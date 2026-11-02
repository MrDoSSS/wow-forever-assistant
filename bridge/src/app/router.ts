// Receive a reassembled message: validate bytes and the contract outside a transaction,
// then commit reception and effects together; ACK only after COMMIT.
import {
  GROUP_NAMES,
  LIMITS,
  MESSAGE_KINDS,
  Message,
  type MessageKey,
  type MessageType,
} from '../contracts.js';
import type { Clock } from '../clock.js';
import { shortKey, type Diagnostics } from '../diagnostics.js';
import { describeIssues } from '../domain/reply.js';
import { characterKeyOf, sha256Hex } from '../ids.js';
import { StoreError, type ReceivedOutcome, type Store } from '../storage/store.js';
import type { Conversations } from './conversations.js';
import { ProtocolConflict } from './errors.js';
import { decodeUtf8, type HandlerContext, type HandlerResult } from './messages.js';
import type { Requests } from './requests.js';
import type { Scheduler } from './scheduler.js';

/** Message reassembled from frames: header metadata and UTF-8 JSON bytes. */
export interface InboundMessage {
  kind: number;
  originSessionId: string;
  messageSequence: number;
  bytes: Uint8Array;
}

export type RejectReason = 'size' | 'utf8' | 'json' | 'schema' | 'frame_mismatch' | 'identity' | 'policy_mismatch';

export type RouteResult =
  | { status: 'accepted'; type: MessageType; characterKey: string; ack: MessageKey; outcome: ReceivedOutcome }
  | { status: 'duplicate'; type: MessageType; characterKey: string; ack: MessageKey }
  | { status: 'rejected'; reason: RejectReason; detail: string }
  | { status: 'conflict'; type: MessageType; characterKey: string; detail: string }
  | { status: 'storage_error'; detail: string };

export interface RouterDeps {
  store: Store;
  clock: Clock;
  diag: Diagnostics;
  requests: Requests;
  conversations: Conversations;
  scheduler: Scheduler;
  /** After COMMIT, when deliveries or acknowledgments may have been created. */
  onCommitted?: (characterKey: string) => void;
  onPriceResult?: (lookupId: string) => void;
}

/** Paths of extra fields: tolerate them but include them in diagnostics. */
export function unknownFieldPaths(input: unknown, output: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(input) && Array.isArray(output)) {
    input.forEach((item, i) => unknownFieldPaths(item, output[i], `${path}[${i}]`, out));
  } else if (input && output && typeof input === 'object' && typeof output === 'object') {
    for (const [key, value] of Object.entries(input)) {
      const child = path ? `${path}.${key}` : key;
      if (!(key in output)) out.push(child);
      else unknownFieldPaths(value, (output as Record<string, unknown>)[key], child, out);
    }
  }
  return out;
}

function conversationOf(message: Message): string | null {
  switch (message.type) {
    case 'HELLO':
    case 'QUERY':
    case 'CLEAR_HISTORY':
      return message.body.conversationId;
    default:
      return null;
  }
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  handle(input: InboundMessage): RouteResult {
    const parsed = this.validate(input);
    if ('status' in parsed) {
      this.deps.diag.warn('message.rejected', { reason: parsed.reason, detail: parsed.detail, kind: input.kind });
      return parsed;
    }
    const { message, unknown } = parsed;
    const { store, clock, diag } = this.deps;
    const characterKey = message.characterKey;
    const ack: MessageKey = { originSessionId: message.originSessionId, messageSequence: message.messageSequence };
    const bodySha256 = sha256Hex(input.bytes);
    if (unknown.length > 0) {
      diag.event('message.unknown_fields', { type: message.type, count: unknown.length, paths: unknown.slice(0, 20) });
    }

    let result: { duplicate: true } | { duplicate: false; handled: HandlerResult };
    try {
      result = store.transaction(`receive.${message.type}`, () => {
        const existing = store.getReceived(characterKey, ack.originSessionId, ack.messageSequence);
        if (existing) {
          if (existing.body_sha256 !== bodySha256) throw new ProtocolConflict('message key reused with different bytes');
          store.touchReceived({ characterKey, ...ack }, clock.now());
          return { duplicate: true } as const;
        }
        const now = clock.now();
        store.ensureCharacter(characterKey, now);
        store.insertReceived({
          character_key: characterKey,
          origin_session_id: ack.originSessionId,
          message_sequence: ack.messageSequence,
          kind: MESSAGE_KINDS[message.type],
          conversation_id: conversationOf(message),
          raw_body: input.bytes,
          body_sha256: bodySha256,
          outcome: 'applied',
          accepted_at: now,
        });
        const ctx: HandlerContext = { characterKey, ...ack, now, rawBody: input.bytes, bodySha256 };
        const handled = this.dispatch(message, ctx);
        if (handled.outcome !== 'applied' || handled.conversationId !== undefined || handled.dropRawBody) {
          store.updateReceived(
            { characterKey, ...ack },
            {
              outcome: handled.outcome,
              ...(handled.conversationId !== undefined ? { conversationId: handled.conversationId } : {}),
              ...(handled.dropRawBody ? { dropRawBody: true } : {}),
            },
          );
        }
        return { duplicate: false, handled } as const;
      });
    } catch (error) {
      if (error instanceof ProtocolConflict) {
        diag.warn('message.conflict', { type: message.type, character: shortKey(characterKey), detail: error.reason });
        return { status: 'conflict', type: message.type, characterKey, detail: error.reason };
      }
      const detail = error instanceof Error ? error.message : String(error);
      diag.error('message.storage_error', {
        type: message.type,
        code: error instanceof StoreError ? error.code : 'storage_error',
        detail,
      });
      return { status: 'storage_error', detail };
    }

    if (result.duplicate) {
      diag.event('message.duplicate', { type: message.type, character: shortKey(characterKey), sequence: ack.messageSequence });
      this.deps.onCommitted?.(characterKey);
      return { status: 'duplicate', type: message.type, characterKey, ack };
    }

    const { handled } = result;
    for (const attemptId of handled.abortAttempts ?? []) this.deps.scheduler.abort(attemptId);
    if (handled.startAttempts) this.deps.scheduler.kick();
    for (const lookupId of handled.completedLookups ?? []) this.deps.onPriceResult?.(lookupId);
    this.deps.onCommitted?.(characterKey);
    diag.event('message.accepted', {
      type: message.type,
      character: shortKey(characterKey),
      origin: ack.originSessionId,
      sequence: ack.messageSequence,
      bytes: input.bytes.byteLength,
      outcome: handled.outcome,
    });
    return { status: 'accepted', type: message.type, characterKey, ack, outcome: handled.outcome };
  }

  private validate(
    input: InboundMessage,
  ): { message: Message; unknown: string[] } | Extract<RouteResult, { status: 'rejected' }> {
    const reject = (reason: RejectReason, detail: string) => ({ status: 'rejected', reason, detail }) as const;
    if (input.bytes.byteLength < 1 || input.bytes.byteLength > LIMITS.messageBytes) {
      return reject('size', `message is ${input.bytes.byteLength} bytes`);
    }
    let text: string;
    try {
      text = decodeUtf8(input.bytes);
    } catch {
      return reject('utf8', 'message is not valid UTF-8');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return reject('json', 'message is not valid JSON');
    }
    const parsed = Message.safeParse(json);
    if (!parsed.success) return reject('schema', describeIssues(parsed.error));
    const message = parsed.data;
    if (
      MESSAGE_KINDS[message.type] !== input.kind ||
      message.originSessionId !== input.originSessionId ||
      message.messageSequence !== input.messageSequence
    ) {
      return reject('frame_mismatch', 'envelope does not match the frame header');
    }
    if ('identity' in message.body && characterKeyOf(message.body.identity) !== message.characterKey) {
      return reject('identity', 'characterKey does not match identity');
    }
    if (message.type === 'QUERY') {
      const { policy, snapshot } = message.body;
      for (const name of GROUP_NAMES) {
        const enabled = policy.enabledGroups.includes(name);
        if (enabled === (snapshot.groups[name].availability === 'disabled')) {
          return reject('policy_mismatch', `group ${name} disagrees with policy`);
        }
      }
    }
    return { message, unknown: unknownFieldPaths(json, message) };
  }

  private dispatch(message: Message, ctx: HandlerContext): HandlerResult {
    const { requests, conversations } = this.deps;
    switch (message.type) {
      case 'HELLO':
        return conversations.handleHello(message, ctx);
      case 'QUERY':
        return requests.handleQuery(message, ctx);
      case 'CANCEL':
        return requests.handleCancel(message, ctx);
      case 'PRICE_RESULT':
        return requests.handlePriceResult(message, ctx);
      case 'RECEIPTS':
        return requests.handleReceipts(message, ctx);
      case 'POLICY':
        return conversations.handlePolicy(message, ctx);
      case 'CLEAR_HISTORY':
        return conversations.handleClearHistory(message, ctx);
    }
  }
}
