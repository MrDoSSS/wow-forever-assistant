import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FixedModelAdapter } from '../bridge/src/ai/fixed.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import type { RouteResult } from '../bridge/src/app/router.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { randomId } from '../bridge/src/ids.js';
import { Store } from '../bridge/src/storage/store.js';
import {
  AddonSession,
  answer,
  ControlledModel,
  encodeMessage,
  FakeClock,
  flush,
  harness,
  identity,
  tempDir,
  waitFor,
  type Harness,
} from './fakes.js';
import { readLua } from './lua-reader.js';

const MINUTE = 60_000;

function accepted(result: RouteResult) {
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  return result as Extract<RouteResult, { status: 'accepted' }>;
}

function deliveries(h: Harness, characterKey: string) {
  return h.store.listCharacterDeliveries(characterKey).map((d) => ({
    ...d,
    parsed: readLua(d.body_lua) as { deliveryId: string; type: string; body: Record<string, unknown> },
  }));
}

function reopen(h: Harness, model = new ControlledModel()): Harness {
  h.store.close();
  return harness({ dir: h.dir, clock: h.clock, model });
}

describe('QUERY acceptance', () => {
  it('commits the question before ACK and answers once', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Which staff is better for a mage?');
    const result = accepted(h.bridge.receive(message));
    assert.deepEqual(result.ack, { originSessionId: key.originSessionId, messageSequence: key.requestId });
    assert.deepEqual(h.store.listAckKeys(addon.characterKey, 128), [result.ack]);
    assert.equal(h.store.getRequest(key)?.state, 'running');
    assert.equal(h.model.calls.length, 1);
    assert.equal(h.model.last().input.query.text, 'Which staff is better for a mage?');

    h.model.reply(answer('Apprentice staff.'));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(key)?.state, 'completed');
    const reply = deliveries(h, addon.characterKey).filter((d) => d.kind === 'reply');
    assert.equal(reply.length, 1);
    assert.equal(reply[0]!.state, 'pending');
    assert.equal(reply[0]!.parsed.body.text, 'Apprentice staff.');
    assert.equal(reply[0]!.target_session_id, addon.originSessionId);
  });

  it('returns the existing outcome for an exact repeat and a conflict for other bytes', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    h.model.reply(answer());
    await h.bridge.scheduler.idle();

    const repeat = h.bridge.receive(message);
    assert.equal(repeat.status, 'duplicate');
    assert.equal(h.model.calls.length, 1);
    assert.equal(h.store.listCharacterDeliveries(addon.characterKey).length, 1);

    const altered = encodeMessage('QUERY', addon.originSessionId, key.requestId, addon.characterKey, {
      ...JSON.parse(new TextDecoder().decode(message.bytes)).body,
      text: 'Different text',
    });
    assert.equal(h.bridge.receive(altered).status, 'conflict');
    assert.equal(h.model.calls.length, 1);
  });

  it('answers a second QUERY of a busy character with busy and no model call', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const first = addon.query('First');
    accepted(h.bridge.receive(first.message));
    const second = addon.query('Second');
    const result = accepted(h.bridge.receive(second.message));
    assert.equal(result.outcome, 'busy');
    assert.equal(h.store.getRequest(second.key), undefined);
    assert.equal(h.model.calls.length, 1);
    const errors = deliveries(h, addon.characterKey).filter((d) => d.kind === 'error');
    assert.equal(errors[0]!.parsed.body.code, 'busy');
    assert.equal(h.store.getReceived(addon.characterKey, second.key.originSessionId, second.key.requestId)?.outcome, 'busy');
  });

  it('does not ACK when the database fails before COMMIT and accepts the retransmission', () => {
    let fail = true;
    const h = harness({
      faults: {
        beforeCommit: (label) => {
          if (fail && label === 'receive.QUERY') throw new Error('disk full');
        },
      },
    });
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    assert.equal(h.bridge.receive(message).status, 'storage_error');
    assert.equal(h.store.getRequest(key), undefined);
    assert.deepEqual(h.store.listAckKeys(addon.characterKey, 128), []);
    assert.equal(h.model.calls.length, 0);
    fail = false;
    accepted(h.bridge.receive(message));
    assert.equal(h.model.calls.length, 1);
  });

  it('rejects wrong identity hash, frame mismatch, broken UTF-8 and policy/snapshot disagreement', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message } = addon.query('Question');
    const json = JSON.parse(new TextDecoder().decode(message.bytes));

    const foreignKey = encodeMessage('QUERY', addon.originSessionId, 50, 'a'.repeat(64), { ...json.body, snapshot: { ...json.body.snapshot, snapshotId: 50 } });
    assert.deepEqual(pick(h.bridge.receive(foreignKey)), { status: 'rejected', reason: 'identity' });

    assert.deepEqual(pick(h.bridge.receive({ ...message, kind: 3 })), { status: 'rejected', reason: 'frame_mismatch' });
    assert.deepEqual(pick(h.bridge.receive({ ...message, bytes: new Uint8Array([0x7b, 0xff, 0x7d]) })), {
      status: 'rejected',
      reason: 'utf8',
    });

    const disabledBags = { ...json.body.policy, enabledGroups: json.body.policy.enabledGroups.filter((g: string) => g !== 'bags') };
    const mismatch = encodeMessage('QUERY', addon.originSessionId, 51, addon.characterKey, {
      ...json.body,
      policy: disabledBags,
      snapshot: { ...json.body.snapshot, snapshotId: 51 },
    });
    assert.deepEqual(pick(h.bridge.receive(mismatch)), { status: 'rejected', reason: 'policy_mismatch' });
    assert.equal(h.model.calls.length, 0);
  });

  it('ignores an extra QUERY field and records it in diagnostics', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const sequence = addon.sequence + 1;
    const { message } = addon.query('Question');
    const json = JSON.parse(new TextDecoder().decode(message.bytes));
    const extended = encodeMessage('QUERY', addon.originSessionId, sequence, addon.characterKey, { ...json.body, futureField: 1 });
    accepted(h.bridge.receive(extended));
    assert.deepEqual(h.diag.named('message.unknown_fields')[0]?.fields.paths, ['body.futureField']);
  });
});

function pick(result: RouteResult) {
  return result.status === 'rejected' ? { status: result.status, reason: result.reason } : { status: result.status };
}

describe('cancellation', () => {
  it('stops a running attempt and suppresses the late result', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Long-running question');
    accepted(h.bridge.receive(message));
    const call = h.model.last();
    accepted(h.bridge.receive(addon.cancel(key)));
    assert.equal(call.signal.aborted, true);
    assert.equal(h.store.getRequest(key)?.state, 'cancelled');
    await h.bridge.scheduler.idle();
    h.model.reply(answer('Late reply'), 0);
    await flush();
    assert.equal(h.store.getReplyForRequest(key), undefined);
    assert.equal(deliveries(h, addon.characterKey).filter((d) => d.kind === 'reply').length, 0);
    assert.equal(h.store.listRequestAttempts(key)[0]!.state, 'cancelled');
  });

  it('keeps a CANCEL that arrives before its QUERY and never starts the model', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const key = { characterKey: addon.characterKey, originSessionId: addon.originSessionId, requestId: 1 };
    const query = addon.query('Question'); // sequence 1
    const cancel = addon.cancel(key); // sequence 2, delivered first
    accepted(h.bridge.receive(cancel));
    assert.equal(h.store.getRequest(key)?.state, 'cancelled');
    accepted(h.bridge.receive(query.message));
    const row = h.store.getRequest(key)!;
    assert.equal(row.state, 'cancelled');
    assert.notEqual(row.raw_body, null);
    assert.equal(h.model.calls.length, 0);
  });

  it('wins over a result that becomes ready at the same moment', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    h.model.reply(answer('Done')); // the attempt continues after the current synchronous code
    accepted(h.bridge.receive(addon.cancel(key)));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(key)?.state, 'cancelled');
    assert.equal(h.store.getReplyForRequest(key), undefined);
  });

  it('confirms a CANCEL for a finished question without effect', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    h.model.reply(answer());
    await h.bridge.scheduler.idle();
    assert.equal(accepted(h.bridge.receive(addon.cancel(key))).outcome, 'no_effect');
    assert.equal(h.store.getRequest(key)?.state, 'completed');
    assert.equal(deliveries(h, addon.characterKey).find((d) => d.kind === 'reply')?.state, 'pending');
  });
});

describe('attempt outcomes', () => {
  it('waits 2, 10 and 30 minutes without a timer, CANCEL or second call', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    for (const minutes of [2, 8, 20]) {
      h.clock.advance(minutes * MINUTE);
      await flush();
      assert.equal(h.store.getRequest(key)?.state, 'running');
      assert.equal(h.model.calls.length, 1);
      assert.equal(h.model.last().signal.aborted, false);
    }
    h.model.reply(answer('After half an hour'));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(key)?.state, 'completed');
    assert.equal(deliveries(h, addon.characterKey).filter((d) => d.kind === 'reply').length, 1);
  });

  it('corrects one invalid result and fails after two', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const first = addon.query('First');
    accepted(h.bridge.receive(first.message));
    h.model.reply({ status: 'answer' });
    await waitFor(() => h.model.calls.length === 2, 'correction attempt');
    assert.equal(h.model.last().input.ordinal, 2);
    assert.match(h.model.last().input.correction?.reason ?? '', /schema/);
    h.model.reply(answer('Corrected'));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(first.key)?.state, 'completed');
    assert.deepEqual(h.store.listRequestAttempts(first.key).map((a) => a.state), ['invalid_result', 'succeeded']);

    const second = addon.query('Second');
    accepted(h.bridge.receive(second.message));
    h.model.reply({ nope: true });
    await waitFor(() => h.model.calls.length === 4, 'second correction');
    h.model.reply(answer('x', { itemRefIds: [randomId()] }));
    await h.bridge.scheduler.idle();
    const row = h.store.getRequest(second.key)!;
    assert.equal(row.state, 'failed');
    assert.equal(row.error_code, 'invalid_result');
    const error = deliveries(h, addon.characterKey).find((d) => d.kind === 'error');
    assert.equal(error?.parsed.body.code, 'invalid_result');
  });

  it('maps model error, process failure and needs_data to terminal states', async () => {
    const h = harness();
    const addon = new AddonSession(identity());

    const a = addon.query('Model error');
    accepted(h.bridge.receive(a.message));
    h.model.reply(answer('Unable to answer', { status: 'error', limitations: ['source unavailable'] }));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(a.key)?.error_code, 'model_error');
    assert.equal(deliveries(h, addon.characterKey).at(-1)?.parsed.body.status, 'error');

    const b = addon.query('Process failure');
    accepted(h.bridge.receive(b.message));
    h.model.respond({ kind: 'failure', code: 'model_error', detail: 'exit 1' });
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(b.key)?.state, 'failed');
    assert.equal(deliveries(h, addon.characterKey).at(-1)?.kind, 'error');

    const c = addon.query('What should I craft?');
    accepted(h.bridge.receive(c.message));
    h.model.reply(answer('More data is needed.', { status: 'needs_data', clarification: 'What is your profession?' }));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(c.key)?.state, 'needs_data');
    assert.equal(h.store.getActiveRequest(addon.characterKey), undefined);
  });

  it('marks deliveries applied by RECEIPTS idempotently', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message } = addon.query('Question');
    accepted(h.bridge.receive(message));
    h.model.reply(answer());
    await h.bridge.scheduler.idle();
    const id = h.store.listCharacterDeliveries(addon.characterKey)[0]!.delivery_id;
    assert.equal(accepted(h.bridge.receive(addon.receipts([id]))).outcome, 'applied');
    assert.equal(h.store.getDelivery(id)?.state, 'applied');
    assert.equal(accepted(h.bridge.receive(addon.receipts([id, randomId()]))).outcome, 'no_effect');
  });

  it('answers with the fixed adapter without AI', async () => {
    const h = harness({ model: new FixedModelAdapter() });
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Connection check');
    accepted(h.bridge.receive(message));
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(key)?.state, 'completed');
    const reply = deliveries(h, addon.characterKey).find((d) => d.kind === 'reply')!;
    assert.match(String(reply.parsed.body.text), /Test answer from the bridge/);
  });
});

describe('recovery', () => {
  it('fails a started external attempt as external_outcome_unknown without a hidden repeat', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    assert.equal(h.model.calls.length, 1);
    const after = reopen(h); // the bridge crashed during the model call
    const report = after.bridge.start();
    assert.equal(report.interruptedAttempts, 1);
    assert.equal(after.store.getRequest(key)?.error_code, 'external_outcome_unknown');
    assert.equal(after.store.listRequestAttempts(key)[0]!.state, 'interrupted');
    assert.equal(after.model.calls.length, 0);
    const error = deliveries(after, addon.characterKey).find((d) => d.kind === 'error');
    assert.equal(error?.parsed.body.code, 'external_outcome_unknown');
    await after.bridge.scheduler.idle();
  });

  it('starts an accepted question automatically after restart', async () => {
    let crashStart = true;
    const h = harness({
      faults: {
        beforeCommit: (label) => {
          if (crashStart && label === 'attempt.start') throw new Error('crash');
        },
      },
    });
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    assert.equal(h.store.getRequest(key)?.state, 'accepted');
    assert.equal(h.model.calls.length, 0);
    crashStart = false;
    const after = reopen(h);
    after.bridge.start();
    assert.equal(after.model.calls.length, 1);
    after.model.reply(answer());
    await after.bridge.scheduler.idle();
    assert.equal(after.store.getRequest(key)?.state, 'completed');
  });

  it('keeps a committed answer pending across restart without a second call', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { message, key } = addon.query('Question');
    accepted(h.bridge.receive(message));
    h.model.reply(answer('Saved'));
    await h.bridge.scheduler.idle();
    const after = reopen(h);
    after.bridge.start();
    assert.equal(after.model.calls.length, 0);
    assert.equal(after.store.getRequest(key)?.state, 'completed');
    const pending = after.store.listPendingDeliveries(addon.characterKey, addon.originSessionId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, 'reply');
  });
});

describe('PRICE_RESULT', () => {
  function withLookup(h: Harness, addon: AddonSession) {
    const { message, key } = addon.query('How much do herbs cost?');
    accepted(h.bridge.receive(message));
    const attemptId = h.model.last().input.attemptId;
    const lookupId = randomId();
    const items = [{ itemId: 2447, itemLink: null }, { itemId: 765, itemLink: null }];
    h.store.transaction('lookup', () =>
      h.store.insertPriceLookup({
        lookup_id: lookupId,
        attempt_id: attemptId,
        requested_items_json: JSON.stringify(items),
        state: 'pending',
        expires_at: h.clock.now() + 180_000,
        result_sha256: null,
      }),
    );
    return { key, lookupId, items };
  }

  const observation = (itemId: number, origin: string) => ({
    item: { itemId, itemLink: null },
    marketKey: 'forever:Forever:alliance',
    unit: 'per_item',
    priceCopper: itemId === 765 ? null : 120,
    readOriginSessionId: origin,
    readAtSessionMs: 5000,
    sourceObservedAtMs: null,
    ageDays: itemId === 765 ? null : 1,
    agePrecision: itemId === 765 ? 'unknown' : 'day_bucket',
    rawExactness: true,
    exactness: 'exact',
    source: 'auctionator_v1',
    sourceVersion: '341',
    unavailableReason: itemId === 765 ? 'no_price' : null,
  });

  it('stores exactly the requested observations and notifies the waiting tool', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { key, lookupId } = withLookup(h, addon);
    const body = { request: key, lookupId, observations: [observation(765, addon.originSessionId), observation(2447, addon.originSessionId)], unavailableReason: null };
    const result = accepted(h.bridge.receive(addon.message('PRICE_RESULT', body)));
    assert.equal(result.outcome, 'applied');
    assert.equal(h.store.getPriceLookup(lookupId)?.state, 'completed');
    assert.equal(h.store.countPriceObservations(lookupId), 2);
    assert.deepEqual(h.priceResults, [lookupId]);
    assert.equal(accepted(h.bridge.receive(addon.message('PRICE_RESULT', body))).outcome, 'no_effect');
  });

  it('treats an unrequested item as a conflict and an unknown lookup as no effect', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { key, lookupId } = withLookup(h, addon);
    const extra = { request: key, lookupId, observations: [observation(2447, addon.originSessionId), observation(118, addon.originSessionId)], unavailableReason: null };
    assert.equal(h.bridge.receive(addon.message('PRICE_RESULT', extra)).status, 'conflict');
    assert.equal(h.store.countPriceObservations(lookupId), 0);
    const unknown = { request: key, lookupId: randomId(), observations: [], unavailableReason: 'api_unavailable' };
    assert.equal(accepted(h.bridge.receive(addon.message('PRICE_RESULT', unknown))).outcome, 'no_effect');
  });

  it('confirms a result after 180 seconds as late without storing it', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const { key, lookupId } = withLookup(h, addon);
    h.clock.advance(181_000);
    const body = { request: key, lookupId, observations: [], unavailableReason: 'not_ready' };
    assert.equal(accepted(h.bridge.receive(addon.message('PRICE_RESULT', body))).outcome, 'late_result');
    assert.equal(h.store.getPriceLookup(lookupId)?.state, 'timed_out');
    assert.equal(h.store.countPriceObservations(lookupId), 0);
  });
});

describe('composition', () => {
  it('runs on a fresh store with in-memory diagnostics', async () => {
    const clock = new FakeClock();
    const store = Store.open({ path: join(tempDir(), 'assistant.sqlite'), clock });
    const bridge = new Bridge({ store, clock, diag: new MemoryDiagnostics(clock), adapter: new FixedModelAdapter() });
    assert.deepEqual(bridge.start(), { interruptedAttempts: 0, failedRequests: 0, acceptedRequests: 0 });
    await bridge.shutdown();
    store.close();
  });
});
