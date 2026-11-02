// Fixed reply without AI for transport testing.
import { setTimeout as delay } from 'node:timers/promises';
import { GROUP_NAMES, utf8ByteLength, type ModelReply } from '../contracts.js';
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from './adapter.js';

const AVAILABILITY_LABELS = {
  available: 'available',
  unavailable: 'unavailable',
  disabled: 'disabled',
} as const;

export function fixedReply(input: AttemptInput): ModelReply {
  const { text, itemRefs, snapshot } = input.query;
  const groups = GROUP_NAMES.map((name) => {
    const group = snapshot.groups[name];
    const coverage = group.availability === 'available' && group.coverage === 'partial' ? ', partial' : '';
    return `${name}: ${AVAILABILITY_LABELS[group.availability]}${coverage}`;
  });
  return {
    status: 'answer',
    text: [
      'Test answer from the bridge (no AI).',
      `Question received: ${utf8ByteLength(text)} bytes, item links: ${itemRefs.length}.`,
      `Snapshot #${snapshot.snapshotId}: ${groups.join('; ')}.`,
    ].join('\n'),
    itemRefIds: [],
    evidenceIds: [],
    locationRefId: null,
    approxLocation: null,
    calculationIds: [],
    limitations: [],
    clarification: null,
  };
}

export interface FixedModelOptions {
  /** Artificial reply delay for testing the waiting state. */
  delayMs?: number;
}

export class FixedModelAdapter implements ModelAdapter {
  readonly name = 'fixed';
  readonly limitations = ['Test mode: fixed answers, AI is not connected.'];

  constructor(private readonly options: FixedModelOptions = {}) {}

  async run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult> {
    hooks.phase('generating');
    const delayMs = this.options.delayMs ?? 0;
    if (delayMs > 0) {
      try {
        await delay(delayMs, undefined, { signal });
      } catch {
        return { kind: 'failure', code: 'model_error', detail: 'aborted' };
      }
    }
    if (signal.aborted) return { kind: 'failure', code: 'model_error', detail: 'aborted' };
    return { kind: 'output', output: fixedReply(input) };
  }
}
