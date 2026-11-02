import type { ErrorCode } from '../contracts.js';

/** Player-facing text for each error code; addon labels use English and Latin letters only. */
export const ERROR_TEXTS: Record<ErrorCode, string> = {
  model_error: 'The model returned an error or its process failed. Ask again.',
  invalid_result: 'The model returned a malformed answer twice. Ask again.',
  external_outcome_unknown:
    'The assistant bridge restarted while processing the question; the outcome is unknown. Ask again if needed.',
  process_stop_unconfirmed:
    'Could not confirm that the previous Codex process stopped. This chat cannot continue yet.',
  process_host_unavailable: 'Could not start Codex safely. The question was not processed.',
  model_profile_unsupported:
    'The installed Codex version does not support the required safety profile. The question was not processed.',
  busy: 'The assistant is still answering the previous question of this character. Wait for it or press Stop.',
  history_changed: 'The chat history changed; the latest page was loaded.',
  history_cleared: 'This chat was cleared; the question from the old chat was not processed.',
  storage_error: 'Assistant database error. The question was not processed.',
};

/** The message conflicts with an accepted one: neither apply nor acknowledge it. */
export class ProtocolConflict extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ProtocolConflict';
  }
}

/** A single delivery does not fit in an Inbox.lua packet. */
export class DeliveryTooLarge extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`delivery literal is ${bytes} bytes, limit ${limit}`);
    this.name = 'DeliveryTooLarge';
  }
}
