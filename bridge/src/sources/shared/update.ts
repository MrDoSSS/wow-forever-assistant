// Shared lifecycle result for independently updated reference snapshots.
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type UpdateResult =
  | { status: 'activated'; datasetId: string }
  | { status: 'not_modified' | 'unchanged'; datasetId: string | null }
  | { status: 'rejected'; datasetId: string; code: string }
  | { status: 'error'; code: string }
  | { status: 'busy' };
