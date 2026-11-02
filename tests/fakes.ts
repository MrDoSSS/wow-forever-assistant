// Shared test fakes: controlled clock, addon session and model.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from '../bridge/src/ai/adapter.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import type { InboundMessage } from '../bridge/src/app/router.js';
import type { Clock } from '../bridge/src/clock.js';
import {
  GROUP_NAMES,
  MESSAGE_KINDS,
  type GroupName,
  type Identity,
  type ItemInput,
  type MessageType,
  type ModelReply,
  type Policy,
  type RequestKey,
  type Snapshot,
} from '../bridge/src/contracts.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { characterKeyOf, randomId } from '../bridge/src/ids.js';
import { Store, type StoreFaults } from '../bridge/src/storage/store.js';

export class FakeClock implements Clock {
  constructor(public value = Date.UTC(2026, 10, 4, 12, 0, 0)) {}
  now(): number {
    return this.value;
  }
  advance(ms: number): void {
    this.value += ms;
  }
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'fa-test-'));
}

export const SERVER_NAMESPACE = 'forever-test';

export function identity(displayName = 'Tester', playerGuid = 'Player-1-00000001', realm = 'Forever'): Identity {
  return { serverNamespace: SERVER_NAMESPACE, realm, playerGuid, displayName };
}

export function makePolicy(revision = 1, enabledGroups: GroupName[] = [...GROUP_NAMES], resetEpoch = 0): Policy {
  return { revision, resetEpoch, enabledGroups: GROUP_NAMES.filter((g) => enabledGroups.includes(g)) };
}

export function snapshotFor(snapshotId: number, p: Policy): Snapshot {
  const at = 120_000;
  const available = <T>(value: T) => ({
    availability: 'available' as const,
    coverage: 'complete' as const,
    observedAtSessionMs: at,
    reason: null,
    value,
  });
  const disabled = {
    availability: 'disabled' as const,
    coverage: 'unknown' as const,
    observedAtSessionMs: null,
    reason: 'user_disabled' as const,
    value: null,
  };
  const values: Record<GroupName, unknown> = {
    character: { classToken: 'MAGE', raceToken: 'Human', faction: 'alliance', level: 12, moneyCopper: 12345 },
    equipment: Array.from({ length: 19 }, (_, i) => ({ slot: i + 1, item: null })),
    quests: [],
    talents: [],
    position: { mapKey: null, x: null, y: null, zoneName: 'Elwynn Forest' },
    bags: [{ bag: 0, slot: 1, item: { itemId: 118, itemLink: null }, count: 2 }],
    professions: [],
    prices: [],
  };
  const groups = Object.fromEntries(
    GROUP_NAMES.map((name) => [name, p.enabledGroups.includes(name) ? available(values[name]) : disabled]),
  );
  return { snapshotId, capturedAtSessionMs: at, groups } as Snapshot;
}

export function encodeMessage(
  type: MessageType,
  originSessionId: string,
  messageSequence: number,
  characterKey: string,
  body: unknown,
  extra: Record<string, unknown> = {},
): InboundMessage {
  const json = JSON.stringify({ version: 1, type, originSessionId, messageSequence, characterKey, body, ...extra });
  return { kind: MESSAGE_KINDS[type], originSessionId, messageSequence, bytes: new TextEncoder().encode(json) };
}

/** Addon game session: originSessionId, message counter, selected conversation and policy. */
export class AddonSession {
  readonly originSessionId = randomId();
  readonly characterKey: string;
  sequence = 0;

  constructor(
    readonly identity: Identity,
    public conversationId: string = randomId(),
    public policy: Policy = makePolicy(),
  ) {
    this.characterKey = characterKeyOf(identity);
  }

  /** New game session for the same character after /reload. */
  reload(): AddonSession {
    return new AddonSession(this.identity, this.conversationId, this.policy);
  }

  message(type: MessageType, body: unknown, extra?: Record<string, unknown>): InboundMessage {
    this.sequence += 1;
    return encodeMessage(type, this.originSessionId, this.sequence, this.characterKey, body, extra);
  }

  hello(options: { pending?: RequestKey[]; applied?: string[]; cursor?: string | null } = {}): InboundMessage {
    return this.message('HELLO', {
      identity: this.identity,
      deliverySessionId: this.originSessionId,
      conversationId: this.conversationId,
      policy: this.policy,
      pendingRequests: options.pending ?? [],
      appliedDeliveryIds: options.applied ?? [],
      historyCursor: options.cursor ?? null,
    });
  }

  query(text: string, itemRefs: ItemInput[] = []): { message: InboundMessage; key: RequestKey } {
    const sequence = this.sequence + 1;
    const message = this.message('QUERY', {
      identity: this.identity,
      conversationId: this.conversationId,
      policy: this.policy,
      text,
      itemRefs,
      snapshot: snapshotFor(sequence, this.policy),
    });
    return { message, key: { characterKey: this.characterKey, originSessionId: this.originSessionId, requestId: sequence } };
  }

  cancel(request: RequestKey): InboundMessage {
    return this.message('CANCEL', { request });
  }

  receipts(deliveryIds: string[]): InboundMessage {
    return this.message('RECEIPTS', { deliveryIds });
  }

  policyMessage(next: Policy): InboundMessage {
    this.policy = next;
    return this.message('POLICY', { identity: this.identity, policy: next });
  }

  clear(replacementConversationId = randomId(), operationId = randomId()): InboundMessage {
    const message = this.message('CLEAR_HISTORY', {
      identity: this.identity,
      operationId,
      conversationId: this.conversationId,
      replacementConversationId,
    });
    return message;
  }
}

export function answer(text = 'Assistant reply', overrides: Partial<ModelReply> = {}): ModelReply {
  return {
    status: 'answer',
    text,
    itemRefIds: [],
    evidenceIds: [],
    locationRefId: null,
    approxLocation: null,
    calculationIds: [],
    limitations: [],
    clarification: null,
    ...overrides,
  };
}

interface PendingCall {
  input: AttemptInput;
  hooks: AttemptHooks;
  signal: AbortSignal;
  resolve: (result: AdapterResult) => void;
}

/** Test-controlled model; cancellation rejects its pending call. */
export class ControlledModel implements ModelAdapter {
  readonly name = 'controlled';
  readonly limitations: string[] = [];
  readonly calls: PendingCall[] = [];
  aborted = 0;

  run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult> {
    return new Promise((resolve) => {
      this.calls.push({ input, hooks, signal, resolve });
      signal.addEventListener('abort', () => {
        this.aborted += 1;
        resolve({ kind: 'failure', code: 'model_error', detail: 'aborted' });
      });
    });
  }

  last(): PendingCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error('model was not called');
    return call;
  }

  respond(result: AdapterResult, index = this.calls.length - 1): void {
    const call = this.calls[index];
    if (!call) throw new Error(`no model call #${index}`);
    call.resolve(result);
  }

  reply(reply: unknown, index?: number): void {
    this.respond({ kind: 'output', output: reply }, index);
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

export async function waitFor(condition: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

export interface Harness {
  dir: string;
  dbPath: string;
  clock: FakeClock;
  diag: MemoryDiagnostics;
  model: ControlledModel;
  store: Store;
  bridge: Bridge;
  committed: string[];
  priceResults: string[];
}

export function harness(
  options: { dir?: string; clock?: FakeClock; model?: ModelAdapter; faults?: StoreFaults } = {},
): Harness {
  const dir = options.dir ?? tempDir();
  const dbPath = join(dir, 'assistant.sqlite');
  const clock = options.clock ?? new FakeClock();
  const diag = new MemoryDiagnostics(clock);
  const model = (options.model as ControlledModel | undefined) ?? new ControlledModel();
  const store = Store.open({ path: dbPath, clock, ...(options.faults ? { faults: options.faults } : {}) });
  const committed: string[] = [];
  const priceResults: string[] = [];
  const bridge = new Bridge({
    store,
    clock,
    diag,
    adapter: model,
    onCommitted: (key) => committed.push(key),
    onPriceResult: (id) => priceResults.push(id),
  });
  return { dir, dbPath, clock, diag, model, store, bridge, committed, priceResults };
}

/** Delivery type and parsed body for assertions; the Lua literal contains equivalent JSON. */
export function deliveriesOf(store: Store, characterKey: string) {
  return store.listCharacterDeliveries(characterKey);
}
