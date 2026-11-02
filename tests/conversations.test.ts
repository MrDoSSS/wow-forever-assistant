import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteResult } from '../bridge/src/app/router.js';
import { randomId } from '../bridge/src/ids.js';
import { AddonSession, answer, harness, identity, makePolicy, type Harness } from './fakes.js';
import { readLua } from './lua-reader.js';

type Parsed = { deliveryId: string; type: string; request?: Record<string, unknown>; body: Record<string, unknown> };

function accepted(result: RouteResult) {
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  return result as Extract<RouteResult, { status: 'accepted' }>;
}

function deliveries(h: Harness, characterKey: string, kind?: string) {
  return h.store
    .listCharacterDeliveries(characterKey)
    .filter((d) => kind === undefined || d.kind === kind)
    .map((d) => ({ ...d, parsed: readLua(d.body_lua) as Parsed }));
}

function latest(h: Harness, characterKey: string, kind: string) {
  const list = deliveries(h, characterKey, kind);
  const last = list.at(-1);
  assert.ok(last, `no ${kind} delivery`);
  return last;
}

async function ask(h: Harness, addon: AddonSession, text: string, reply = answer(`Reply: ${text}`)) {
  const { message, key } = addon.query(text);
  accepted(h.bridge.receive(message));
  h.clock.advance(1000);
  h.model.reply(reply);
  await h.bridge.scheduler.idle();
  h.clock.advance(1000);
  return key;
}

describe('HELLO and delivery sessions', () => {
  it('does not let an older chat selection supersede a newer HELLO in the same session', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const older = addon.hello();
    addon.conversationId = randomId();
    const newer = addon.hello();
    accepted(h.bridge.receive(newer));
    const count = deliveries(h, addon.characterKey).length;
    assert.equal(accepted(h.bridge.receive(older)).outcome, 'no_effect');
    assert.equal(deliveries(h, addon.characterKey).length, count);
    assert.equal(latest(h, addon.characterKey, 'hello').parsed.body.conversationId, addon.conversationId);
  });

  it('creates the chat and answers with hello and an empty history page', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    accepted(h.bridge.receive(addon.hello()));
    assert.ok(h.store.getConversation(addon.characterKey, addon.conversationId));
    const hello = latest(h, addon.characterKey, 'hello');
    assert.equal(hello.parsed.body.conversationId, addon.conversationId);
    assert.equal(hello.parsed.body.policyRevision, 1);
    assert.deepEqual(hello.parsed.body.capabilities, { map: false, auctionator: false });
    const history = latest(h, addon.characterKey, 'history');
    assert.deepEqual(history.parsed.body.entries, []);
    assert.equal(history.parsed.body.nextCursor, undefined); // null becomes an absent Lua field
    const state = h.store.getTransportState();
    assert.equal(state.active_character_key, addon.characterKey);
    assert.equal(state.active_delivery_session_id, addon.originSessionId);
  });

  it('moves pending deliveries to the new session after /reload and reopens unconfirmed ones', async () => {
    const h = harness();
    const first = new AddonSession(identity());
    accepted(h.bridge.receive(first.hello()));
    const key = await ask(h, first, 'Question before reload');
    const reply = latest(h, first.characterKey, 'reply');
    assert.equal(reply.target_session_id, first.originSessionId);

    // The reply was applied but SavedVariables were not saved; a new session does not know it.
    accepted(h.bridge.receive(first.receipts([reply.delivery_id])));
    assert.equal(h.store.getDelivery(reply.delivery_id)?.state, 'applied');
    const second = first.reload();
    accepted(h.bridge.receive(second.hello({ pending: [key] })));
    const reopened = h.store.getDelivery(reply.delivery_id)!;
    assert.equal(reopened.state, 'pending');
    assert.equal(reopened.target_session_id, second.originSessionId);

    // The third session reports that the reply was applied.
    const third = second.reload();
    accepted(h.bridge.receive(third.hello({ pending: [key], applied: [reply.delivery_id] })));
    assert.equal(h.store.getDelivery(reply.delivery_id)?.state, 'applied');
    // Keep the original request key and snapshot unchanged.
    assert.equal(h.store.getRequest(key)?.origin_session_id, first.originSessionId);
  });

  it('reports the state of a still running question to the new session', () => {
    const h = harness();
    const first = new AddonSession(identity());
    const { message, key } = first.query('Long-running question');
    accepted(h.bridge.receive(message));
    const second = first.reload();
    accepted(h.bridge.receive(second.hello({ pending: [key] })));
    const status = latest(h, first.characterKey, 'status');
    assert.equal(status.parsed.body.state, 'running');
    assert.equal(status.target_session_id, second.originSessionId);
    assert.equal(h.model.calls.length, 1);
  });

  it('does not let a late HELLO of the previous session take the delivery target', () => {
    const h = harness();
    const first = new AddonSession(identity());
    accepted(h.bridge.receive(first.hello()));
    h.clock.advance(5000);
    const second = first.reload();
    accepted(h.bridge.receive(second.hello()));
    h.clock.advance(5000);
    // A previous session's message retried from the queue after /reload.
    assert.equal(accepted(h.bridge.receive(first.hello())).outcome, 'no_effect');
    assert.equal(h.store.getTransportState().active_delivery_session_id, second.originSessionId);
    // Another /reload creates a new recipient session for the same character.
    h.clock.advance(5000);
    const third = second.reload();
    accepted(h.bridge.receive(third.hello()));
    assert.equal(h.store.getTransportState().active_delivery_session_id, third.originSessionId);
  });
});

describe('chats and characters', () => {
  it('keeps separate model sessions and histories for two chats of one character', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const chatA = addon.conversationId;
    const { message } = addon.query('Question in conversation A');
    accepted(h.bridge.receive(message));
    h.model.last().hooks.sessionStarted('codex-session-a');
    h.model.reply(answer('Reply A'));
    await h.bridge.scheduler.idle();

    const chatB = randomId();
    addon.conversationId = chatB;
    await ask(h, addon, 'Question in conversation B');
    assert.equal(h.model.last().input.modelSession.codexSessionId, null);

    addon.conversationId = chatA;
    accepted(h.bridge.receive(addon.query('A again').message));
    assert.equal(h.model.last().input.modelSession.codexSessionId, 'codex-session-a');
    h.model.reply(answer());
    await h.bridge.scheduler.idle();

    const historyA = h.bridge.conversations.history(addon.characterKey, chatA).map((e) => e.entry.text);
    assert.deepEqual(historyA, ['Question in conversation A', 'Reply A', 'A again', 'Assistant reply']);
    const historyB = h.bridge.conversations.history(addon.characterKey, chatB).map((e) => e.entry.text);
    assert.deepEqual(historyB, ['Question in conversation B', 'Reply: Question in conversation B']);
    assert.equal(h.store.getCurrentModelSession(addon.characterKey, chatB)?.generation, 1);
  });

  it('runs questions of different characters and servers independently', () => {
    const h = harness();
    const alice = new AddonSession(identity('Alice', 'Player-1-00000001'));
    const bob = new AddonSession(identity('Bob', 'Player-1-00000002'));
    const otherServer = new AddonSession({ ...identity('Alice', 'Player-1-00000001'), serverNamespace: 'other' });
    assert.notEqual(alice.characterKey, otherServer.characterKey);
    for (const addon of [alice, bob, otherServer]) accepted(h.bridge.receive(addon.query('Question').message));
    assert.equal(h.model.calls.length, 3);
    for (const addon of [alice, bob, otherServer]) {
      assert.equal(h.store.getActiveRequest(addon.characterKey)?.state, 'running');
    }
  });
});

describe('context policy', () => {
  it('keeps the highest revision and rejects a reused revision with other content', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    accepted(h.bridge.receive(addon.hello()));
    accepted(h.bridge.receive(addon.policyMessage(makePolicy(2, ['character', 'equipment']))));
    assert.equal(h.store.getCharacter(addon.characterKey)?.policy_revision, 2);
    const conflict = h.bridge.receive(addon.policyMessage(makePolicy(2, ['character'])));
    assert.equal(conflict.status, 'conflict');
    assert.equal(h.store.getCharacter(addon.characterKey)?.policy_json, '{"revision":2,"resetEpoch":0,"enabledGroups":["character","equipment"]}');
  });

  it('processes a QUERY of an older revision with its own policy and snapshot', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    accepted(h.bridge.receive(addon.policyMessage(makePolicy(3, ['character']))));
    addon.policy = makePolicy(2, ['character', 'bags']);
    const { message, key } = addon.query('Question with the old policy');
    accepted(h.bridge.receive(message));
    assert.equal(h.model.last().input.query.snapshot.groups.bags.availability, 'available');
    assert.equal(h.store.getCharacter(addon.characterKey)?.policy_revision, 3);
    h.model.reply(answer());
    await h.bridge.scheduler.idle();
    assert.equal(h.store.getRequest(key)?.state, 'completed');
  });

  it('starts a new model session generation after «Start over», chat by chat', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const chatA = addon.conversationId;
    const chatB = randomId();
    for (const chat of [chatA, chatB]) {
      addon.conversationId = chat;
      accepted(h.bridge.receive(addon.query('Before reset').message));
      h.model.last().hooks.sessionStarted(`codex-${chat}`);
      h.model.reply(answer());
      await h.bridge.scheduler.idle();
    }
    accepted(h.bridge.receive(addon.policyMessage(makePolicy(2, ['character'], 1))));

    addon.conversationId = chatA;
    await ask(h, addon, 'After reset');
    const input = h.model.last().input;
    assert.equal(input.modelSession.generation, 2);
    assert.equal(input.modelSession.codexSessionId, null);
    assert.equal(h.store.getCurrentModelSession(addon.characterKey, chatB)?.generation, 1);

    addon.conversationId = chatB;
    await ask(h, addon, 'After reset in B');
    assert.equal(h.store.getCurrentModelSession(addon.characterKey, chatB)?.generation, 2);
    // Keep old UI history.
    assert.equal(h.bridge.conversations.history(addon.characterKey, chatA).length, 4);
  });
});

describe('history pages', () => {
  it('pages newest-first with a cursor and resets on a stale cursor', async () => {
    const h = harness();
    const addon = new AddonSession(identity());
    for (let i = 1; i <= 25; i++) await ask(h, addon, `Question ${i}`);

    accepted(h.bridge.receive(addon.hello()));
    const page1 = latest(h, addon.characterKey, 'history').parsed.body;
    const texts1 = (page1.entries as { text: string }[]).map((e) => e.text);
    assert.equal(texts1.length, 20);
    assert.equal(texts1.at(-1), 'Reply: Question 25');
    assert.equal(texts1[0], 'Question 16');

    accepted(h.bridge.receive(addon.hello({ cursor: String(page1.nextCursor) })));
    const page2 = latest(h, addon.characterKey, 'history').parsed.body;
    const texts2 = (page2.entries as { text: string }[]).map((e) => e.text);
    assert.equal(texts2.length, 20);
    assert.equal(texts2.at(-1), 'Reply: Question 15');

    accepted(h.bridge.receive(addon.hello({ cursor: String(page2.nextCursor) })));
    const page3 = latest(h, addon.characterKey, 'history').parsed.body;
    assert.equal((page3.entries as unknown[]).length, 10);
    assert.equal(page3.nextCursor, undefined);

    accepted(h.bridge.receive(addon.hello({ cursor: randomId() })));
    const error = latest(h, addon.characterKey, 'error');
    assert.equal(error.parsed.body.code, 'history_changed');
    assert.equal(error.parsed.request, undefined);
    assert.equal((latest(h, addon.characterKey, 'history').parsed.body.entries as unknown[]).length, 20);
    // Suppress stale hello/history deliveries from older HELLO messages.
    assert.equal(deliveries(h, addon.characterKey, 'history').filter((d) => d.state === 'pending').length, 1);
  });
});

describe('clearing a chat', () => {
  async function prepared() {
    const h = harness();
    const addon = new AddonSession(identity());
    const oldChat = addon.conversationId;
    accepted(h.bridge.receive(addon.hello()));
    const firstQuery = addon.query('How do I reach the Deadmines?');
    accepted(h.bridge.receive(firstQuery.message));
    h.model.last().hooks.sessionStarted('codex-old');
    h.model.reply(answer('Through Westfall.'));
    await h.bridge.scheduler.idle();
    const running = addon.query('What should I bring?');
    accepted(h.bridge.receive(running.message));
    return { h, addon, oldChat, firstQuery, running };
  }

  it('stops the active question and removes the chat data atomically', async () => {
    const { h, addon, oldChat, running } = await prepared();
    const call = h.model.last();
    const replacement = randomId();
    const operationId = randomId();
    const clear = addon.clear(replacement, operationId);
    accepted(h.bridge.receive(clear));
    assert.equal(call.signal.aborted, true);

    const count = (table: string) =>
      h.store.rawQuery<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE character_key = ? AND conversation_id = ?`, addon.characterKey, oldChat)[0]!.n;
    for (const table of ['requests', 'attempts', 'model_sessions', 'conversations', 'deliveries']) assert.equal(count(table), 0, table);
    assert.equal(count('received_messages'), 1); // CLEAR_HISTORY itself
    assert.equal(h.store.rawQuery('SELECT * FROM snapshots').length, 0);
    assert.equal(h.store.rawQuery('SELECT * FROM replies').length, 0);
    assert.equal(h.store.getRequest(running.key), undefined);
    assert.deepEqual(h.store.integrityCheck(), { quickCheck: 'ok', foreignKeyViolations: 0 });

    const chat = h.store.getConversation(addon.characterKey, replacement)!;
    assert.equal(chat.title, 'How do I reach the Deadmines?');
    assert.equal(chat.history_revision, 1);
    const cleared = latest(h, addon.characterKey, 'cleared').parsed.body;
    assert.deepEqual(cleared, { operationId, oldConversationId: oldChat, replacementConversationId: replacement, historyRevision: 1 });

    h.model.reply(answer('Late reply'), 1);
    await h.bridge.scheduler.idle();
    assert.equal(h.store.rawQuery('SELECT * FROM replies').length, 0);
  });

  it('discards the title as well as messages when deleting a chat', async () => {
    const { h, addon, oldChat } = await prepared();
    const replacement = randomId();
    const clear = addon.message('CLEAR_HISTORY', {
      identity: addon.identity,
      operationId: randomId(),
      conversationId: oldChat,
      replacementConversationId: replacement,
      deleteChat: true,
    });
    accepted(h.bridge.receive(clear));
    assert.equal(h.store.getConversation(addon.characterKey, oldChat), undefined);
    assert.equal(h.store.getConversation(addon.characterKey, replacement)?.title, 'New chat');
    assert.deepEqual(h.bridge.conversations.history(addon.characterKey, replacement), []);
  });

  it('answers repeats and late messages of the old chat without restoring anything', async () => {
    const { h, addon, oldChat, firstQuery, running } = await prepared();
    const replacement = randomId();
    const operationId = randomId();
    const clear = addon.clear(replacement, operationId);
    accepted(h.bridge.receive(clear));
    await h.bridge.scheduler.idle();

    assert.equal(h.bridge.receive(clear).status, 'duplicate');
    // Same operation in a new message: same outcome and replacement.
    addon.conversationId = oldChat;
    const again = addon.message('CLEAR_HISTORY', {
      identity: addon.identity,
      operationId,
      conversationId: oldChat,
      replacementConversationId: randomId(),
    });
    assert.equal(accepted(h.bridge.receive(again)).outcome, 'no_effect');
    assert.equal(latest(h, addon.characterKey, 'cleared').parsed.body.replacementConversationId, replacement);

    // Old QUERY retries and new questions in an old conversation return history_cleared without model calls or contents.
    const calls = h.model.calls.length;
    assert.equal(accepted(h.bridge.receive(firstQuery.message)).outcome, 'history_cleared');
    const late = addon.query('Another question in the old conversation');
    assert.equal(accepted(h.bridge.receive(late.message)).outcome, 'history_cleared');
    assert.equal(h.model.calls.length, calls);
    const received = h.store.getReceived(addon.characterKey, late.key.originSessionId, late.key.requestId)!;
    assert.equal(received.raw_body, null);
    assert.equal(latest(h, addon.characterKey, 'error').parsed.body.code, 'history_cleared');

    // Late CANCEL creates a marker without contents; unknown RECEIPTS have no effect.
    accepted(h.bridge.receive(addon.cancel(running.key)));
    const mark = h.store.getRequest(running.key)!;
    assert.equal(mark.state, 'cancelled');
    assert.equal(mark.raw_body, null);
    assert.equal(accepted(h.bridge.receive(addon.receipts([randomId()]))).outcome, 'no_effect');

    // HELLO for an old conversation receives its replacement without old history.
    accepted(h.bridge.receive(addon.hello()));
    assert.equal(latest(h, addon.characterKey, 'hello').parsed.body.conversationId, replacement);
    const history = latest(h, addon.characterKey, 'history').parsed.body;
    assert.equal(history.conversationId, replacement);
    assert.deepEqual(history.entries, []);
    assert.equal(h.bridge.conversations.history(addon.characterKey, oldChat).length, 0);
  });

  it('changes nothing when the bridge crashes before COMMIT', async () => {
    let crash = true;
    const h = harness({
      faults: {
        beforeCommit: (label) => {
          if (crash && label === 'receive.CLEAR_HISTORY') throw new Error('crash');
        },
      },
    });
    const addon = new AddonSession(identity());
    const key = await ask(h, addon, 'Question');
    const clear = addon.clear();
    assert.equal(h.bridge.receive(clear).status, 'storage_error');
    assert.equal(h.store.getRequest(key)?.state, 'completed');
    assert.equal(h.bridge.conversations.history(addon.characterKey, addon.conversationId).length, 2);
    crash = false;
    accepted(h.bridge.receive(clear));
    assert.equal(h.store.getRequest(key), undefined);
  });
});
