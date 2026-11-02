import { Message, type MessageOf, type RequestKey } from '../contracts.js';
import { sha256Hex } from '../ids.js';
import type { ReceivedOutcome, RequestRow } from '../storage/store.js';

export interface HandlerContext {
  characterKey: string;
  originSessionId: string;
  messageSequence: number;
  now: number;
  /** Original message bytes and their SHA-256: retries resend them without reserializing. */
  rawBody: Uint8Array;
  bodySha256: string;
}

/** Handler outcome within the receive transaction and actions after COMMIT. */
export interface HandlerResult {
  outcome: ReceivedOutcome;
  conversationId?: string;
  dropRawBody?: boolean;
  abortAttempts?: string[];
  startAttempts?: boolean;
  completedLookups?: string[];
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Stored original QUERY bytes were already validated on reception. */
export function parseStoredQuery(raw: Uint8Array): MessageOf<'QUERY'> {
  const message = Message.parse(JSON.parse(decodeUtf8(raw)));
  if (message.type !== 'QUERY') throw new Error('stored request body is not a QUERY');
  return message;
}

export function requestKeyOf(row: Pick<RequestRow, 'character_key' | 'origin_session_id' | 'request_id'>): RequestKey {
  return { characterKey: row.character_key, originSessionId: row.origin_session_id, requestId: row.request_id };
}

export function sameRequestKey(a: RequestKey, b: RequestKey): boolean {
  return a.characterKey === b.characterKey && a.originSessionId === b.originSessionId && a.requestId === b.requestId;
}

/** entryId is the first 16 bytes of SHA-256 of the request key and role. */
export function entryIdOf(key: RequestKey, role: 'user' | 'assistant'): string {
  return sha256Hex(`${key.characterKey}|${key.originSessionId}|${key.requestId}|${role}`).slice(0, 32);
}
