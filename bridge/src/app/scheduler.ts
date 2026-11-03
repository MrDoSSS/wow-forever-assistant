// Reply attempts: start after receive COMMIT, fence by attemptId,
// allow one schema correction and recover after restart. There is no overall
// question timeout: an attempt waits for the adapter or explicit cancellation.
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from '../ai/adapter.js';
import type { Clock } from '../clock.js';
import type { ErrorCode, RequestKey } from '../contracts.js';
import type { Diagnostics } from '../diagnostics.js';
import { verifyModelReply } from '../domain/reply.js';
import { randomId } from '../ids.js';
import type { RequestRow, Store } from '../storage/store.js';
import type { Conversations } from './conversations.js';
import { ERROR_TEXTS } from './errors.js';
import { parseStoredQuery, requestKeyOf } from './messages.js';
import type { Outbox } from './outbox.js';

export interface SchedulerDeps {
  store: Store;
  outbox: Outbox;
  conversations: Conversations;
  adapter: ModelAdapter;
  clock: Clock;
  diag: Diagnostics;
  /** After committing a result: deliveries are ready for publication. */
  onCommitted?: (characterKey: string) => void;
  /** Current working reference dataset, pinned to the question on its first attempt. */
  datasetId?: () => string | null;
  /** Verify that an interrupted attempt's process tree stopped after restart. */
  confirmStop?: (attempt: { jobName: string; childPid: number | null; childCreatedAt: number | null }) => Promise<boolean>;
}

export interface RecoveryReport {
  interruptedAttempts: number;
  failedRequests: number;
  acceptedRequests: number;
}

type Completion =
  | { kind: 'done' }
  | { kind: 'stale' }
  | { kind: 'retry'; input: AttemptInput };

export class Scheduler {
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  get runningCount(): number {
    return this.running.size;
  }

  /** Recover on startup before receiving messages or publishing. */
  recover(): RecoveryReport {
    const { store, clock } = this.deps;
    const now = clock.now();
    const report = store.transaction('recover', () => {
      let interruptedAttempts = 0;
      let failedRequests = 0;
      // A started external attempt has no result: its outcome is unknown; do not silently retry.
      for (const attempt of store.listRunningAttempts()) {
        store.finishAttempt(attempt.attempt_id, 'interrupted', now, 'external_outcome_unknown');
        store.cancelPendingLookups(attempt.attempt_id);
        interruptedAttempts++;
      }
      for (const row of store.listRequestsInState('running')) {
        this.failRequest(row, 'external_outcome_unknown', now);
        failedRequests++;
      }
      return { interruptedAttempts, failedRequests, acceptedRequests: store.listRequestsInState('accepted').length };
    });
    this.deps.diag.event('scheduler.recovered', { ...report });
    return report;
  }

  /**
   * After restart, stop any surviving process trees from interrupted attempts.
   * Unconfirmed stop leaves stop_confirmed_at empty and blocks session resumption.
   */
  async verifyStops(): Promise<{ confirmed: number; unconfirmed: number }> {
    const { store, clock, confirmStop, diag } = this.deps;
    let confirmed = 0;
    let unconfirmed = 0;
    if (!confirmStop) return { confirmed, unconfirmed };
    for (const attempt of store.listUnconfirmedStops()) {
      let ok = false;
      try {
        ok = await confirmStop({ jobName: attempt.process_job_name!, childPid: attempt.child_pid, childCreatedAt: attempt.child_created_at });
      } catch (error) {
        diag.error('scheduler.stop_check_failed', { attemptId: attempt.attempt_id, error: String(error) });
      }
      if (ok) {
        store.transaction('attempt.stop_confirmed', () => store.confirmAttemptStopped(attempt.attempt_id, clock.now()));
        confirmed++;
      } else unconfirmed++;
    }
    if (confirmed + unconfirmed > 0) diag.event('scheduler.stops_verified', { confirmed, unconfirmed });
    return { confirmed, unconfirmed };
  }

  /** Start attempts for accepted questions that have not made an external call yet. */
  kick(): void {
    if (this.stopped) return;
    const { store } = this.deps;
    for (const row of store.listRequestsInState('accepted')) {
      if (store.getRunningAttempt(row.character_key)) continue;
      let input: AttemptInput | null = null;
      try {
        input = store.transaction('attempt.start', () => this.startFirstAttempt(requestKeyOf(row)));
      } catch (error) {
        this.deps.diag.error('scheduler.start_failed', { error: String(error) });
      }
      if (input) this.launch(input);
    }
  }

  abort(attemptId: string): void {
    this.running.get(attemptId)?.controller.abort();
  }

  /** Wait for all attempts, including ones started while waiting. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((r) => r.promise));
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const { controller } of this.running.values()) controller.abort();
    await this.idle();
  }

  // -------------------------------------------------------------------------

  private startFirstAttempt(key: RequestKey): AttemptInput | null {
    const { store, conversations, clock } = this.deps;
    const row = store.getRequest(key);
    if (!row || row.state !== 'accepted' || row.raw_body === null || row.conversation_id === null) return null;
    if (store.getRunningAttempt(key.characterKey)) return null;
    const query = parseStoredQuery(row.raw_body).body;
    const now = clock.now();
    const session = conversations.resolveModelSession(key.characterKey, row.conversation_id, query.policy.resetEpoch, now);
    // Do not resume a session until the previous process tree is confirmed stopped.
    if (store.hasUnconfirmedStop(key.characterKey, row.conversation_id, session.generation)) {
      this.failRequest(row, 'process_stop_unconfirmed', now);
      return null;
    }
    const datasetId = this.deps.datasetId?.() ?? null;
    const attemptId = randomId();
    store.insertAttempt({
      attemptId,
      request: key,
      conversationId: row.conversation_id,
      ordinal: 1,
      modelGeneration: session.generation,
      datasetId,
      now,
    });
    store.setRequestRunning(key, attemptId);
    return {
      attemptId,
      ordinal: 1,
      request: key,
      conversationId: row.conversation_id,
      query,
      modelSession: { generation: session.generation, codexSessionId: session.codex_session_id },
      datasetId,
      correction: null,
    };
  }

  private launch(input: AttemptInput): void {
    const controller = new AbortController();
    const promise = this.execute(input, controller.signal).finally(() => this.running.delete(input.attemptId));
    this.running.set(input.attemptId, { controller, promise });
    this.deps.diag.event('attempt.started', {
      attemptId: input.attemptId,
      ordinal: input.ordinal,
      requestId: input.request.requestId,
      adapter: this.deps.adapter.name,
    });
  }

  private hooks(input: AttemptInput): AttemptHooks {
    const { store } = this.deps;
    return {
      sessionStarted: (codexSessionId) => {
        try {
          store.transaction('attempt.session', () => {
            const attempt = store.getAttempt(input.attemptId);
            if (attempt?.state !== 'running') return;
            const changed = store.setCodexSessionId(
              input.request.characterKey,
              input.conversationId,
              input.modelSession.generation,
              codexSessionId,
            );
            if (changed === 0) this.deps.diag.warn('attempt.session_mismatch', { attemptId: input.attemptId });
          });
        } catch (error) {
          this.deps.diag.error('attempt.session_store_failed', { attemptId: input.attemptId, error: String(error) });
        }
      },
      processStarted: (info) => {
        try {
          store.transaction('attempt.process', () =>
            store.setAttemptProcess(input.attemptId, {
              jobName: info.jobName,
              hostPid: info.hostPid,
              hostCreatedAt: info.hostCreatedAt,
              childPid: info.childPid,
              childCreatedAt: info.childCreatedAt,
            }),
          );
        } catch (error) {
          this.deps.diag.error('attempt.process_store_failed', { attemptId: input.attemptId, error: String(error) });
        }
      },
      phase: (phase) => {
        try {
          store.transaction('attempt.phase', () => store.setAttemptPhase(input.attemptId, phase));
        } catch (error) {
          this.deps.diag.error('attempt.phase_store_failed', { attemptId: input.attemptId, error: String(error) });
        }
      },
    };
  }

  private async execute(input: AttemptInput, signal: AbortSignal): Promise<void> {
    let result: AdapterResult;
    try {
      result = await this.deps.adapter.run(input, this.hooks(input), signal);
    } catch (error) {
      result = { kind: 'failure', code: 'model_error', detail: String(error) };
    }
    let completion: Completion;
    try {
      completion = this.deps.store.transaction('attempt.complete', () => this.complete(input, result, signal.aborted));
    } catch (error) {
      this.deps.diag.error('attempt.complete_failed', { attemptId: input.attemptId, error: String(error) });
      this.failAfterStorageError(input);
      return;
    }
    this.deps.diag.event('attempt.completed', { attemptId: input.attemptId, completion: completion.kind });
    this.deps.onCommitted?.(input.request.characterKey);
    if (completion.kind === 'retry') this.launch(completion.input);
    else this.kick();
  }

  /** Result readiness: recheck state and attemptId, then publish. */
  private complete(input: AttemptInput, result: AdapterResult, aborted: boolean): Completion {
    const { store, outbox, clock } = this.deps;
    const now = clock.now();
    const attempt = store.getAttempt(input.attemptId);
    const request = store.getRequest(input.request);
    const current =
      attempt?.state === 'running' &&
      request?.state === 'running' &&
      request.current_attempt_id === input.attemptId;
    // The adapter returned after its process tree exited; false means stop is unconfirmed.
    if (result.stopConfirmed !== false) store.confirmAttemptStopped(input.attemptId, now);
    if (!current || aborted) {
      // A cancelled or superseded attempt cannot save its result.
      if (attempt?.state === 'running') store.finishAttempt(input.attemptId, 'cancelled', now, null);
      return { kind: 'stale' };
    }
    store.setAttemptPhase(input.attemptId, 'validating');

    if (result.kind === 'failure') {
      store.finishAttempt(input.attemptId, 'failed', now, result.code);
      this.failRequest(request, result.code, now);
      return { kind: 'done' };
    }

    const attemptIds = store.listRequestAttempts(input.request).map((a) => a.attempt_id);
    const check = verifyModelReply(result.output, store, attemptIds, input.query.snapshot.locale);
    if (!check.ok) return this.invalid(input, request, check.reason, now);
    if (check.markdown.length > 0) this.deps.diag.event('reply.markdown_removed', { attemptId: input.attemptId, kinds: check.markdown });

    // A delivery must fit in a packet in full; check before saving the answer.
    const reply = check.reply;
    const draft = { type: 'reply', request: input.request, body: reply } as const;
    if (!outbox.fits(draft)) return this.invalid(input, request, 'reply delivery exceeds the packet limit', now);

    const replyId = randomId();
    const replyAt = this.deps.conversations.stampEntry(input.request.characterKey, input.conversationId, now);
    store.finishAttempt(input.attemptId, 'succeeded', now, null);
    store.insertReply({
      replyId,
      request: input.request,
      attemptId: input.attemptId,
      gameReplyJson: JSON.stringify(reply),
      now: replyAt,
    });
    outbox.create({
      characterKey: input.request.characterKey,
      conversationId: input.conversationId,
      replyId,
      fallbackTarget: input.request.originSessionId,
      now,
      draft,
    });
    if (reply.status === 'error') store.finishRequest(input.request, 'failed', now, 'model_error');
    else store.finishRequest(input.request, reply.status === 'needs_data' ? 'needs_data' : 'completed', now, null);
    return { kind: 'done' };
  }

  private invalid(input: AttemptInput, request: RequestRow, reason: string, now: number): Completion {
    const { store } = this.deps;
    store.finishAttempt(input.attemptId, 'invalid_result', now, 'invalid_result');
    this.deps.diag.warn('attempt.invalid_result', { attemptId: input.attemptId, ordinal: input.ordinal, reason });
    if (input.ordinal === 2) {
      this.failRequest(request, 'invalid_result', now);
      return { kind: 'done' };
    }
    const attemptId = randomId();
    store.insertAttempt({
      attemptId,
      request: input.request,
      conversationId: input.conversationId,
      ordinal: 2,
      modelGeneration: input.modelSession.generation,
      // A correction keeps the question, snapshot and pinned dataset.
      datasetId: input.datasetId,
      now,
    });
    store.setRequestCurrentAttempt(input.request, attemptId);
    const session = store.getModelSession(input.request.characterKey, input.conversationId, input.modelSession.generation);
    return {
      kind: 'retry',
      input: {
        ...input,
        attemptId,
        ordinal: 2,
        modelSession: { generation: input.modelSession.generation, codexSessionId: session?.codex_session_id ?? null },
        correction: { reason },
      },
    };
  }

  private failRequest(row: RequestRow, code: ErrorCode, now: number): void {
    const { store, outbox } = this.deps;
    const key = requestKeyOf(row);
    store.finishRequest(key, 'failed', now, code);
    outbox.create({
      characterKey: key.characterKey,
      conversationId: row.conversation_id,
      fallbackTarget: key.originSessionId,
      now,
      draft: { type: 'error', request: key, body: { code, text: ERROR_TEXTS[code] } },
    });
  }

  private failAfterStorageError(input: AttemptInput): void {
    const { store, clock } = this.deps;
    try {
      store.transaction('attempt.storage_error', () => {
        const now = clock.now();
        const request = store.getRequest(input.request);
        if (request?.state !== 'running' || request.current_attempt_id !== input.attemptId) return;
        store.finishAttempt(input.attemptId, 'failed', now, 'storage_error');
        this.failRequest(request, 'storage_error', now);
      });
    } catch (error) {
      // The question stays running; a restart changes it to external_outcome_unknown.
      this.deps.diag.error('attempt.storage_error_unrecorded', { attemptId: input.attemptId, error: String(error) });
    }
  }
}
