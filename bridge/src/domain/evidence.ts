// Evidence and verified references. Evidence is immutable:
// source, record, hash, retrieval time, applicability and fields used.
// The bridge registers evidence and refIds and links them to the attempt before
// returning the tool result to the model.
import { randomId, sha256Hex } from '../ids.js';
import type { Store, VerifiedRefRow } from '../storage/store.js';

export type EvidenceSourceKind = 'foreverdb' | 'questiedb' | 'calculation' | 'auctionator' | 'client';

export interface EvidenceInput {
  attemptId: string;
  sourceKind: EvidenceSourceKind;
  datasetId: string | null;
  recordKey: string | null;
  sourceUrl: string | null;
  /** Record fields or excerpt used. */
  content: unknown;
  applicability: Record<string, unknown>;
  purpose: string;
  now: number;
}

/** Find or create evidence and link it to the attempt within the transaction. */
export function registerEvidence(store: Store, input: EvidenceInput): string {
  const usedContentJson = JSON.stringify(input.content);
  const contentSha256 = sha256Hex(usedContentJson);
  let evidenceId = store.findEvidence(input.sourceKind, input.datasetId, input.recordKey, contentSha256);
  if (!evidenceId) {
    evidenceId = randomId();
    store.insertEvidence({
      evidenceId,
      sourceKind: input.sourceKind,
      sourceUrl: input.sourceUrl,
      datasetId: input.datasetId,
      recordKey: input.recordKey,
      contentSha256,
      retrievedAt: input.now,
      applicabilityJson: JSON.stringify(input.applicability),
      usedContentJson,
    });
  }
  store.linkEvidence(input.attemptId, evidenceId, input.purpose);
  return evidenceId;
}

/** Issue a refId for a record the model can reference in its reply. */
export function registerRef(store: Store, attemptId: string, kind: VerifiedRefRow['kind'], body: (refId: string) => unknown): string {
  const refId = randomId();
  store.insertVerifiedRef({ refId, attemptId, kind, bodyJson: JSON.stringify(body(refId)) });
  return refId;
}
