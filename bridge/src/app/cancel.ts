import type { RequestRow, Store } from '../storage/store.js';
import { requestKeyOf } from './messages.js';

/**
 * Cancel an active question within a transaction: mark it cancelled, fence its attempt,
 * and suppress pending lookups and unapplied deliveries.
 * Return the attempt to stop after COMMIT.
 */
export function cancelActiveRequest(store: Store, row: RequestRow, now: number): string | null {
  const key = requestKeyOf(row);
  store.finishRequest(key, 'cancelled', now, null);
  store.suppressRequestDeliveries(key);
  const attemptId = row.current_attempt_id;
  if (attemptId === null) return null;
  store.finishAttempt(attemptId, 'cancelled', now, null);
  store.cancelPendingLookups(attemptId);
  return attemptId;
}
