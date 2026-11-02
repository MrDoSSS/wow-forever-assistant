// Receive questions and related messages: QUERY, CANCEL, RECEIPTS, PRICE_RESULT.
// All effects run in the receive transaction; external actions run after COMMIT.
import { ItemInput, MESSAGE_KINDS, type MessageOf, type RequestKey } from '../contracts.js';
import { randomId, sha256Hex } from '../ids.js';
import { ACTIVE_REQUEST_STATES, type Store } from '../storage/store.js';
import { cancelActiveRequest } from './cancel.js';
import { titleFromText, type Conversations } from './conversations.js';
import { ERROR_TEXTS, ProtocolConflict } from './errors.js';
import type { HandlerContext, HandlerResult } from './messages.js';
import type { Outbox } from './outbox.js';

function itemKey(item: ItemInput): string {
  return `${item.itemId}|${item.itemLink ?? ''}`;
}

export class Requests {
  constructor(
    private readonly store: Store,
    private readonly outbox: Outbox,
    private readonly conversations: Conversations,
  ) {}

  handleQuery(message: MessageOf<'QUERY'>, ctx: HandlerContext): HandlerResult {
    const { body } = message;
    const { characterKey, now } = ctx;
    const key: RequestKey = { characterKey, originSessionId: ctx.originSessionId, requestId: ctx.messageSequence };
    const conversationId = body.conversationId;
    this.store.setIdentity(characterKey, body.identity);
    this.conversations.mergePolicy(characterKey, body.policy);

    const serviceError = (code: 'busy' | 'history_cleared') =>
      this.outbox.create({
        characterKey,
        conversationId,
        fallbackTarget: ctx.originSessionId,
        now,
        draft: { type: 'error', request: key, body: { code, text: ERROR_TEXTS[code] } },
      });

    // Late QUERY for a cleared conversation: do not call the model or save its contents.
    if (this.store.getCleared(characterKey, conversationId)) {
      serviceError('history_cleared');
      return { outcome: 'history_cleared', conversationId, dropRawBody: true };
    }

    const input = { conversationId, rawBody: ctx.rawBody, sha256: ctx.bodySha256 };
    const snapshotJson = JSON.stringify(body.snapshot);
    const existing = this.store.getRequest(key);
    if (existing) {
      // Cancellation arrived before QUERY: fill the row but keep the cancelled state.
      if (existing.raw_body !== null || existing.state !== 'cancelled') {
        throw new ProtocolConflict('request key already holds another question');
      }
      this.conversations.ensure(characterKey, conversationId, now, titleFromText(body.text));
      this.store.insertSnapshot(key, snapshotJson, sha256Hex(snapshotJson), now);
      this.store.fillCancelledRequest(key, input, now);
      return { outcome: 'applied', conversationId };
    }

    if (this.store.getActiveRequest(characterKey)) {
      serviceError('busy');
      return { outcome: 'busy', conversationId };
    }

    const isFirst =
      !this.store.getConversation(characterKey, conversationId) ||
      this.store.countConversationRequests(characterKey, conversationId) === 0;
    const title = titleFromText(body.text);
    this.conversations.ensure(characterKey, conversationId, now, title);
    const createdAt = this.conversations.stampEntry(characterKey, conversationId, now, isFirst ? title : undefined);
    this.store.insertSnapshot(key, snapshotJson, sha256Hex(snapshotJson), now);
    this.store.insertAcceptedRequest(key, input, now, createdAt);
    return { outcome: 'applied', conversationId, startAttempts: true };
  }

  handleCancel(message: MessageOf<'CANCEL'>, ctx: HandlerContext): HandlerResult {
    const key = message.body.request;
    const row = this.store.getRequest(key);
    if (row) {
      const conversationId = row.conversation_id ?? undefined;
      if (!ACTIVE_REQUEST_STATES.includes(row.state)) return { outcome: 'no_effect', conversationId };
      const attemptId = cancelActiveRequest(this.store, row, ctx.now);
      return { outcome: 'applied', conversationId, abortAttempts: attemptId ? [attemptId] : [] };
    }
    // QUERY was received without creating a request row (busy/history_cleared): nothing to cancel.
    const query = this.store.getReceived(key.characterKey, key.originSessionId, key.requestId);
    if (query && query.kind === MESSAGE_KINDS.QUERY) {
      return { outcome: 'no_effect', conversationId: query.conversation_id ?? undefined };
    }
    // Keep a cancellation received before QUERY so a late QUERY cannot start the model.
    this.store.insertCancelledPlaceholder(key, ctx.now);
    return { outcome: 'applied' };
  }

  handleReceipts(message: MessageOf<'RECEIPTS'>, ctx: HandlerContext): HandlerResult {
    let changed = 0;
    for (const deliveryId of message.body.deliveryIds) {
      changed += this.store.markDeliveryApplied(ctx.characterKey, deliveryId, ctx.now);
    }
    return { outcome: changed > 0 ? 'applied' : 'no_effect' };
  }

  handlePriceResult(message: MessageOf<'PRICE_RESULT'>, ctx: HandlerContext): HandlerResult {
    const { request, lookupId, observations, unavailableReason, itemInfo } = message.body;
    const lookup = this.store.getPriceLookup(lookupId);
    if (!lookup) return { outcome: 'no_effect' };
    const attempt = this.store.getAttempt(lookup.attempt_id);
    if (
      !attempt ||
      attempt.character_key !== request.characterKey ||
      attempt.origin_session_id !== request.originSessionId ||
      attempt.request_id !== request.requestId
    ) {
      throw new ProtocolConflict('price lookup belongs to another request');
    }
    const conversationId = attempt.conversation_id;
    // The hash of a prices-only reply matches the previous format.
    const resultSha = sha256Hex(JSON.stringify(itemInfo.length > 0 ? { observations, unavailableReason, itemInfo } : { observations, unavailableReason }));

    switch (lookup.state) {
      case 'completed':
        if (lookup.result_sha256 === resultSha) return { outcome: 'no_effect', conversationId };
        throw new ProtocolConflict('different result for a completed price lookup');
      case 'timed_out':
        return { outcome: 'late_result', conversationId };
      case 'cancelled':
        return { outcome: 'no_effect', conversationId };
      case 'pending':
        break;
    }
    if (ctx.now > lookup.expires_at) {
      this.store.setPriceLookupState(lookupId, 'timed_out', null);
      return { outcome: 'late_result', conversationId };
    }

    if (observations.length > 0) {
      const requested = ItemInput.array().parse(JSON.parse(lookup.requested_items_json)).map(itemKey).sort();
      const received = observations.map((o) => itemKey(o.item)).sort();
      if (requested.length !== received.length || requested.some((k, i) => k !== received[i])) {
        throw new ProtocolConflict('price observations do not match the requested items');
      }
    }
    if (itemInfo.length > 0) {
      const requested = ItemInput.array().parse(JSON.parse(lookup.requested_items_json)).map(itemKey).sort();
      const received = itemInfo.map((i) => itemKey(i.item)).sort();
      if (requested.length !== received.length || requested.some((k, i) => k !== received[i])) {
        throw new ProtocolConflict('item info does not match the requested items');
      }
    }
    for (const o of observations) {
      this.store.insertPriceObservation({
        observationId: randomId(),
        request,
        lookupId,
        itemId: o.item.itemId,
        marketKey: o.marketKey,
        priceCopper: o.priceCopper,
        readOriginSessionId: o.readOriginSessionId,
        readAtSessionMs: o.readAtSessionMs,
        receivedAt: ctx.now,
        ageDays: o.ageDays,
        agePrecision: o.agePrecision,
        rawExactness: o.rawExactness,
        sourceVersion: o.sourceVersion,
        originalItemLink: o.item.itemLink,
        exactness: o.exactness,
        unavailableReason: o.unavailableReason,
      });
    }
    for (const info of itemInfo) {
      this.store.insertClientItemInfo({
        infoId: randomId(),
        request,
        lookupId,
        itemId: info.item.itemId,
        originalItemLink: info.item.itemLink,
        bodyJson: JSON.stringify(info),
        receivedAt: ctx.now,
      });
    }
    this.store.setPriceLookupState(lookupId, 'completed', resultSha);
    return { outcome: 'applied', conversationId, completedLookups: [lookupId] };
  }
}
