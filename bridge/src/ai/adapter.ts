// Model adapter interface. The adapter starts or resumes a session and returns
// a raw result; the bridge validates its schema and references and handles publication.
import type { QueryBody, RequestKey } from '../contracts.js';
import type { AttemptPhase } from '../storage/store.js';

export interface AttemptInput {
  attemptId: string;
  ordinal: 1 | 2;
  request: RequestKey;
  conversationId: string;
  query: QueryBody;
  modelSession: { generation: number; codexSessionId: string | null };
  /** Reference dataset pinned to the question and its correction. */
  datasetId: string | null;
  /** Second attempt: the first result's rejection reason. */
  correction: { reason: string } | null;
}

export interface AttemptHooks {
  /** Persist immediately, even before a final answer is available. */
  sessionStarted(codexSessionId: string): void;
  phase(phase: AttemptPhase): void;
  /** Process tree created before resume: information needed for restart recovery. */
  processStarted?(info: { jobName: string; hostPid: number; hostCreatedAt: number; childPid: number; childCreatedAt: number }): void;
}

export type AdapterFailureCode =
  | 'model_error'
  | 'process_host_unavailable'
  | 'model_profile_unsupported'
  | 'process_stop_unconfirmed';

/** stopConfirmed=false means the process tree is still running; block session resumption. */
export type AdapterResult =
  | { kind: 'output'; output: unknown; stopConfirmed?: boolean }
  | { kind: 'failure'; code: AdapterFailureCode; detail: string; stopConfirmed?: boolean };

export interface ModelAdapter {
  readonly name: string;
  /** Adapter limitations included in the addon greeting. */
  readonly limitations: readonly string[];
  run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult>;
}
