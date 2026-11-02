// Conversations, context policy, model sessions, history and clearing.
import {
  canonicalPolicyJson,
  GameReply,
  LIMITS,
  type HistoryEntry,
  type MessageOf,
  type Policy,
  type RequestKey,
} from '../contracts.js';
import { assistantEntryFields } from '../domain/reply.js';
import { randomId } from '../ids.js';
import type { ConversationRow, ModelSessionRow, Store } from '../storage/store.js';
import { cancelActiveRequest } from './cancel.js';
import { ERROR_TEXTS, ProtocolConflict } from './errors.js';
import { entryIdOf, parseStoredQuery, requestKeyOf, type HandlerContext, type HandlerResult } from './messages.js';
import type { DeliveryDraft, Outbox } from './outbox.js';

export const DEFAULT_TITLE = 'New chat';
const TITLE_CODE_POINTS = 64;

export interface BridgeCapabilities {
  map: boolean;
  auctionator: boolean;
  limitations: string[];
}

export interface TimedEntry {
  createdAt: number;
  entry: HistoryEntry;
}

export type PolicyMerge = 'updated' | 'unchanged' | 'older';

function compareEntries(a: { createdAt: number; entryId: string }, b: { createdAt: number; entryId: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

export function titleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]!.trim();
  const codePoints = [...(firstLine || text.trim())];
  const title = codePoints.slice(0, TITLE_CODE_POINTS).join('');
  return title.length > 0 ? title : DEFAULT_TITLE;
}

export class Conversations {
  constructor(
    private readonly store: Store,
    private readonly outbox: Outbox,
    private readonly capabilities: () => BridgeCapabilities,
  ) {}

  // -------------------------------------------------------------------------
  // Keep the highest policy revision; the same revision with different contents is a conflict.

  mergePolicy(characterKey: string, policy: Policy): PolicyMerge {
    const row = this.store.getCharacter(characterKey);
    const json = canonicalPolicyJson(policy);
    if (!row || row.policy_revision === null || policy.revision > row.policy_revision) {
      this.store.setPolicy(characterKey, policy.revision, json);
      return 'updated';
    }
    if (policy.revision === row.policy_revision) {
      if (json !== row.policy_json) throw new ProtocolConflict('policy revision reused with different content');
      return 'unchanged';
    }
    return 'older';
  }

  // -------------------------------------------------------------------------
  // Conversations

  /** A cleared conversation is replaced by a new one; follow the chain to the active conversation. */
  resolve(characterKey: string, conversationId: string): string {
    const seen = new Set<string>();
    let current = conversationId;
    for (;;) {
      const cleared = this.store.getCleared(characterKey, current);
      if (!cleared) return current;
      if (seen.has(current)) throw new Error('cycle in cleared conversations');
      seen.add(current);
      current = cleared.replacement_conversation_id;
    }
  }

  ensure(characterKey: string, conversationId: string, now: number, title = DEFAULT_TITLE): ConversationRow {
    const existing = this.store.getConversation(characterKey, conversationId);
    if (existing) return existing;
    const row: ConversationRow = {
      character_key: characterKey,
      conversation_id: conversationId,
      title,
      created_at: now,
      updated_at: now,
      history_revision: 0,
    };
    this.store.insertConversation(row);
    return row;
  }

  /**
   * Each history entry's time is strictly later than the previous entry in its conversation,
   * so created_at/entryId ordering follows event order even within one millisecond.
   */
  stampEntry(characterKey: string, conversationId: string, now: number, title?: string): number {
    const conversation = this.store.getConversation(characterKey, conversationId);
    const at = conversation ? Math.max(now, conversation.updated_at + 1) : now;
    this.store.touchConversation(characterKey, conversationId, at, title);
    return at;
  }

  /**
   * Current model session generation for a conversation. A higher policy resetEpoch
   * ("Start over") closes the current generation and opens a new one without
   * copying the old conversation.
   */
  resolveModelSession(characterKey: string, conversationId: string, resetEpoch: number, now: number): ModelSessionRow {
    const current = this.store.getCurrentModelSession(characterKey, conversationId);
    if (current && current.reset_epoch >= resetEpoch) return current;
    const generation = current ? current.generation + 1 : 1;
    if (current) this.store.closeModelSession(characterKey, conversationId, current.generation, now);
    this.store.insertModelSession({
      character_key: characterKey,
      conversation_id: conversationId,
      generation,
      reset_epoch: resetEpoch,
      created_at: now,
    });
    return this.store.getModelSession(characterKey, conversationId, generation)!;
  }

  // -------------------------------------------------------------------------
  // History

  history(characterKey: string, conversationId: string): TimedEntry[] {
    const entries: TimedEntry[] = [];
    for (const row of this.store.listConversationRequests(characterKey, conversationId)) {
      if (row.raw_body === null) continue;
      const key = requestKeyOf(row);
      const query = parseStoredQuery(row.raw_body).body;
      entries.push({
        createdAt: row.created_at,
        entry: {
          entryId: entryIdOf(key, 'user'),
          request: key,
          role: 'user',
          text: query.text,
          itemRefs: query.itemRefs,
          locationRef: null,
        },
      });
    }
    for (const reply of this.store.listConversationReplies(characterKey, conversationId)) {
      const key = requestKeyOf(reply);
      const body = GameReply.parse(JSON.parse(reply.body_json));
      entries.push({
        createdAt: reply.created_at,
        entry: { entryId: entryIdOf(key, 'assistant'), request: key, role: 'assistant', ...assistantEntryFields(body) },
      });
    }
    return entries.sort((a, b) =>
      compareEntries({ createdAt: a.createdAt, entryId: a.entry.entryId }, { createdAt: b.createdAt, entryId: b.entry.entryId }),
    );
  }

  /**
   * A history page contains up to 20 entries before the cursor, trimmed to
   * the packet limit; nextCursor points to older entries.
   */
  pushHistory(characterKey: string, conversationId: string, cursorId: string | null, now: number, fallbackTarget: string): void {
    const conversation = this.store.getConversation(characterKey, conversationId);
    if (!conversation) throw new Error('conversation is missing');
    let before: { createdAt: number; entryId: string } | null = null;
    if (cursorId !== null) {
      const cursor = this.store.getHistoryCursor(cursorId);
      if (
        cursor &&
        cursor.character_key === characterKey &&
        cursor.conversation_id === conversationId &&
        cursor.history_revision === conversation.history_revision
      ) {
        before = { createdAt: cursor.last_created_at, entryId: cursor.last_entry_id };
      } else {
        this.outbox.create({
          characterKey,
          conversationId,
          fallbackTarget,
          now,
          draft: { type: 'error', request: null, body: { code: 'history_changed', text: ERROR_TEXTS.history_changed } },
        });
      }
    }
    const older = this.history(characterKey, conversationId).filter(
      (e) => before === null || compareEntries({ createdAt: e.createdAt, entryId: e.entry.entryId }, before) < 0,
    );
    const draftFor = (page: TimedEntry[], nextCursor: string | null): DeliveryDraft => ({
      type: 'history',
      request: null,
      body: {
        conversationId,
        historyRevision: conversation.history_revision,
        entries: page.map((e) => e.entry),
        nextCursor,
      },
    });
    for (let count = Math.min(LIMITS.historyEntries, older.length); count > 0; count--) {
      const page = older.slice(older.length - count);
      const nextCursor = older.length > count ? randomId() : null;
      const draft = draftFor(page, nextCursor);
      if (!this.outbox.fits(draft)) continue;
      if (nextCursor !== null) {
        this.store.insertHistoryCursor({
          cursor_id: nextCursor,
          character_key: characterKey,
          conversation_id: conversationId,
          history_revision: conversation.history_revision,
          last_created_at: page[0]!.createdAt,
          last_entry_id: page[0]!.entry.entryId,
        });
      }
      this.outbox.create({ characterKey, conversationId, fallbackTarget, now, draft });
      return;
    }
    this.outbox.create({ characterKey, conversationId, fallbackTarget, now, draft: draftFor([], null) });
  }

  // -------------------------------------------------------------------------
  // HELLO, POLICY, CLEAR_HISTORY

  handleHello(message: MessageOf<'HELLO'>, ctx: HandlerContext): HandlerResult {
    const { body } = message;
    const { characterKey, now } = ctx;
    this.store.setIdentity(characterKey, body.identity);
    this.mergePolicy(characterKey, body.policy);

    if (this.store.latestHelloSequence(characterKey, message.originSessionId) > message.messageSequence) {
      return { outcome: 'no_effect', conversationId: body.conversationId };
    }

    // A repeated HELLO from an older game session after /reload must not steal delivery
    // from a newer session, or the active session would stop receiving packets.
    const target = this.store.getTransportState();
    const current = target.active_character_key === characterKey ? target.active_delivery_session_id : null;
    if (current && current !== body.deliverySessionId) {
      const incomingSeen = this.store.firstSeenAt(characterKey, body.deliverySessionId);
      const currentSeen = this.store.firstSeenAt(characterKey, current);
      if (incomingSeen !== null && currentSeen !== null && incomingSeen < currentSeen) {
        return { outcome: 'no_effect', conversationId: body.conversationId };
      }
    }

    const conversationId = this.resolve(characterKey, body.conversationId);
    this.ensure(characterKey, conversationId, now);

    for (const deliveryId of body.appliedDeliveryIds) this.store.markDeliveryApplied(characterKey, deliveryId, now);
    const applied = new Set(body.appliedDeliveryIds);
    for (const key of body.pendingRequests) this.reportPending(key, applied, now, body.deliverySessionId);

    // New delivery session: old hello/history deliveries become stale; pending work uses the new target.
    this.store.suppressPendingOfKinds(characterKey, ['hello', 'history']);
    this.store.setActiveTarget(characterKey, body.deliverySessionId);
    this.store.retargetPendingDeliveries(characterKey, body.deliverySessionId);

    const character = this.store.getCharacter(characterKey)!;
    const conversation = this.store.getConversation(characterKey, conversationId)!;
    const capabilities = this.capabilities();
    this.outbox.create({
      characterKey,
      conversationId,
      fallbackTarget: body.deliverySessionId,
      now,
      draft: {
        type: 'hello',
        request: null,
        body: {
          conversationId,
          policyRevision: character.policy_revision!,
          historyRevision: conversation.history_revision,
          capabilities: { map: capabilities.map, auctionator: capabilities.auctionator },
          limitations: capabilities.limitations,
        },
      },
    });
    const cursor = conversationId === body.conversationId ? body.historyCursor : null;
    this.pushHistory(characterKey, conversationId, cursor, now, body.deliverySessionId);
    return { outcome: 'applied', conversationId: body.conversationId };
  }

  /** State of a question the addon still considers pending after reload. */
  private reportPending(key: RequestKey, applied: ReadonlySet<string>, now: number, target: string): void {
    const row = this.store.getRequest(key);
    if (!row) return; // QUERY has not been accepted yet; the addon will resend it.
    this.store.suppressRequestDeliveries(key, ['status']);
    const status = (state: 'accepted' | 'running' | 'cancelled' | 'failed', errorCode: string | null) =>
      this.outbox.create({
        characterKey: key.characterKey,
        conversationId: row.conversation_id,
        fallbackTarget: target,
        now,
        draft: { type: 'status', request: key, body: { state, errorCode } },
      });
    if (row.state === 'accepted' || row.state === 'running' || row.state === 'cancelled') {
      status(row.state, null);
      return;
    }
    let finalPending = false;
    for (const delivery of this.store.listRequestDeliveries(key)) {
      if (delivery.kind !== 'reply' && delivery.kind !== 'error') continue;
      if (delivery.state === 'pending') finalPending = true;
      if (delivery.state === 'applied' && !applied.has(delivery.delivery_id)) {
        this.store.reopenDelivery(delivery.delivery_id);
        finalPending = true;
      }
    }
    if (!finalPending && row.state === 'failed') status('failed', row.error_code);
  }

  handlePolicy(message: MessageOf<'POLICY'>, ctx: HandlerContext): HandlerResult {
    this.store.setIdentity(ctx.characterKey, message.body.identity);
    const merged = this.mergePolicy(ctx.characterKey, message.body.policy);
    return { outcome: merged === 'updated' ? 'applied' : 'no_effect' };
  }

  handleClearHistory(message: MessageOf<'CLEAR_HISTORY'>, ctx: HandlerContext): HandlerResult {
    const { identity, operationId, conversationId, replacementConversationId, deleteChat } = message.body;
    const { characterKey, now } = ctx;
    this.store.setIdentity(characterKey, identity);

    const cleared = (replacement: string, historyRevision: number) =>
      this.outbox.create({
        characterKey,
        conversationId: replacement,
        fallbackTarget: ctx.originSessionId,
        now,
        draft: {
          type: 'cleared',
          request: null,
          body: { operationId, oldConversationId: conversationId, replacementConversationId: replacement, historyRevision },
        },
      });
    const revisionOf = (id: string) => this.store.getConversation(characterKey, id)?.history_revision ?? 0;

    // Repeated operation or already cleared conversation: return the same outcome without clearing again.
    const byOperation = this.store.getClearedByOperation(operationId);
    if (byOperation) {
      if (byOperation.character_key !== characterKey || byOperation.conversation_id !== conversationId) {
        throw new ProtocolConflict('operationId reused for another conversation');
      }
      cleared(byOperation.replacement_conversation_id, revisionOf(byOperation.replacement_conversation_id));
      return { outcome: 'no_effect', conversationId };
    }
    const previous = this.store.getCleared(characterKey, conversationId);
    if (previous) {
      cleared(previous.replacement_conversation_id, revisionOf(previous.replacement_conversation_id));
      return { outcome: 'no_effect', conversationId };
    }
    if (
      this.store.getConversation(characterKey, replacementConversationId) ||
      this.store.getCleared(characterKey, replacementConversationId)
    ) {
      throw new ProtocolConflict('replacement conversation already exists');
    }

    const abortAttempts: string[] = [];
    const active = this.store.getActiveRequest(characterKey);
    if (active && active.conversation_id === conversationId) {
      const attemptId = cancelActiveRequest(this.store, active, now);
      if (attemptId) abortAttempts.push(attemptId);
    }
    const old = this.store.getConversation(characterKey, conversationId);
    this.store.deleteConversationData(characterKey, conversationId, {
      originSessionId: ctx.originSessionId,
      messageSequence: ctx.messageSequence,
    });
    const historyRevision = (old?.history_revision ?? 0) + 1;
    this.store.insertConversation({
      character_key: characterKey,
      conversation_id: replacementConversationId,
      title: deleteChat ? DEFAULT_TITLE : old?.title ?? DEFAULT_TITLE,
      created_at: now,
      updated_at: now,
      history_revision: historyRevision,
    });
    this.store.insertCleared({
      character_key: characterKey,
      conversation_id: conversationId,
      replacement_conversation_id: replacementConversationId,
      operation_id: operationId,
      cleared_at: now,
    });
    cleared(replacementConversationId, historyRevision);
    return { outcome: 'applied', conversationId, abortAttempts };
  }
}
