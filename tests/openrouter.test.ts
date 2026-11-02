import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { OpenRouterAdapter, parseReply, replyProblem, toolDefinitions, type ChatMessage } from '../bridge/src/ai/openrouter.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import { ToolChannelHub } from '../bridge/src/app/tool-channel.js';
import { TOOL_NAMES } from '../bridge/src/contracts.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { DatasetManager } from '../bridge/src/sources/foreverdb/update.js';
import { Store } from '../bridge/src/storage/store.js';
import { AddonSession, answer, FakeClock, identity, tempDir } from './fakes.js';
import { syntheticForeverDBArchive } from './foreverdb-fixture.js';

interface SentRequest {
  headers: Record<string, string>;
  body: { model: string; messages: ChatMessage[]; tools: { type: string; function?: { name: string } }[]; tool_choice: string; response_format: { type: string }; provider: unknown };
}

/** Scripted OpenRouter: each step answers one request, given every request sent so far. */
type Step = (sent: SentRequest) => Response | Record<string, unknown>;

const message = (content: string | null, extra: Record<string, unknown> = {}) => ({
  provider: 'Fake',
  choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0001 },
});
/** Messages of a request after the system message with the output schema. */
const conversation = (sent: SentRequest) => {
  const [system, ...rest] = sent.body.messages as unknown as { role: string; content: string }[];
  assert.equal(system!.role, 'system');
  assert.match(system!.content, /^Output schema:[\s\S]*"itemRefIds"/);
  return rest;
};
const call = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResult = (sent: SentRequest, id: string) =>
  JSON.parse((sent.body.messages.find((m) => m.role === 'tool' && m.tool_call_id === id) as { content: string }).content) as {
    status: string;
    data: Record<string, unknown>;
    evidenceIds: string[];
    limitations: string[];
  };

async function environment() {
  const dir = tempDir();
  const clock = new FakeClock();
  const diag = new MemoryDiagnostics(clock);
  const store = Store.open({ path: join(dir, 'assistant.sqlite'), clock });
  const datasets = new DatasetManager({ store, cacheDir: join(dir, 'cache'), clock, diag, fetcher: () => Promise.reject(new Error('offline')) });
  assert.equal((await datasets.importArchive(syntheticForeverDBArchive(), { etag: null, lastModified: null })).status, 'activated');
  const hub = new ToolChannelHub({ store, clock, diag, datasets: { sourceFor: (id) => datasets.sourceFor(id) } });
  const sessionsDir = join(dir, 'sessions');
  let steps: Step[] = [];
  const sent: SentRequest[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const request: SentRequest = { headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
    sent.push(request);
    const step = steps.shift();
    if (!step) throw new Error('unexpected OpenRouter request');
    const result = step(request);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  const adapter = new OpenRouterAdapter({
    apiKey: 'sk-or-test',
    model: 'google/gemini-3.8-flash',
    schemaPath: resourcePath('schemas', 'model-reply.schema.json'),
    sessionsDir,
    channels: hub,
    diag,
    fetch: fetchFake,
  });
  const bridge = new Bridge({ store, clock, diag, adapter, datasetId: () => datasets.source?.datasetId ?? null });
  const ask = async (text: string, addon: AddonSession, script: Step[]) => {
    steps = script;
    sent.length = 0;
    const { message: query, key } = addon.query(text);
    assert.equal(bridge.receive(query).status, 'accepted');
    await bridge.scheduler.idle();
    assert.equal(steps.length, 0, 'every scripted response was used');
    return { key, request: store.getRequest(key)!, sent: [...sent] };
  };
  const cleanup = async () => {
    await bridge.shutdown();
    store.close();
  };
  return { diag, store, sessionsDir, ask, cleanup };
}

describe('OpenRouter adapter helpers', () => {
  it('describes every forever tool as a function without $schema, plus web search when enabled', () => {
    const tools = toolDefinitions(true) as { type: string; function?: { name: string; parameters: Record<string, unknown> } }[];
    assert.deepEqual(tools.filter((t) => t.type === 'function').map((t) => t.function!.name), [...TOOL_NAMES]);
    assert.ok(tools.every((t) => t.function === undefined || !('$schema' in t.function.parameters)));
    assert.deepEqual(tools.at(-1), { type: 'openrouter:web_search', parameters: { max_results: 5 } });
    assert.equal(toolDefinitions(false).length, TOOL_NAMES.length);
  });

  it('parses the final JSON with a code fence or text around it and keeps other text for validation', () => {
    assert.deepEqual(parseReply('{"a":1}'), { a: 1 });
    assert.deepEqual(parseReply('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseReply('Here is the answer:\n{"a":{"b":2}}\nDone.'), { a: { b: 2 } });
    assert.equal(parseReply('not json'), 'not json');
  });

  it('names schema problems of a final message', () => {
    assert.equal(replyProblem(JSON.stringify(answer('ok'))), null);
    assert.equal(replyProblem('Plain text answer'), 'the final message is not a JSON object');
    assert.match(replyProblem('{"status":"answer","text":"x"}') ?? '', /^schema: .*itemRefIds/);
  });
});

describe('OpenRouter adapter with a scripted API', () => {
  let env: Awaited<ReturnType<typeof environment>>;
  before(async () => {
    env = await environment();
  });
  after(() => env.cleanup());

  it('runs the tool loop in process and answers with verified refs, evidence and a calculation', async () => {
    const addon = new AddonSession(identity('Router', 'Player-1-000000a1'));
    const reasoning = [{ type: 'reasoning.encrypted', data: 'opaque', id: 'r1', format: 'google-gemini-v1', index: 0 }];
    const { key, request, sent } = await env.ask('How do I craft Lesser Magic Wand?', addon, [
      () => message(null, {
        tool_calls: [
          call('c1', 'get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] }),
          call('c2', 'get_game_record', { type: 'item', id: 11287, recordKey: null, fields: [] }),
        ],
        reasoning_details: reasoning,
      }),
      (s) => message(null, {
        tool_calls: [
          call('c3', 'calculate_craft', { recipeRefId: toolResult(s, 'c1').data.recipeRefId, desiredQuantity: 3, inventoryScope: 'bags' }),
          call('c4', 'search_game_data', { query: '', types: [], cursor: null }),
          call('c5', 'shell', { command: 'dir' }),
        ],
      }),
      (s) => {
        const recipe = toolResult(s, 'c1');
        const item = toolResult(s, 'c2');
        const calc = toolResult(s, 'c3');
        return message(JSON.stringify(answer(`${String(calc.data.crafts)} crafts`, {
          itemRefIds: [item.data.itemRefId as string],
          evidenceIds: [...recipe.evidenceIds, ...item.evidenceIds],
          calculationIds: [calc.data.calculationId as string],
        })));
      },
    ]);
    assert.equal(request.state, 'completed', String(request.error_code));
    const reply = JSON.parse(env.store.getReplyForRequest(key)!.body_json) as { text: string; itemRefs: { itemId: number }[]; calculationIds: string[] };
    assert.equal(reply.text, '3 crafts');
    assert.equal(reply.itemRefs[0]!.itemId, 11287);
    assert.equal(reply.calculationIds.length, 1);

    const first = sent[0]!;
    assert.equal(first.headers.Authorization, 'Bearer sk-or-test');
    assert.equal(first.body.model, 'google/gemini-3.8-flash');
    assert.equal(first.body.response_format.type, 'json_schema');
    assert.deepEqual(first.body.provider, { require_parameters: true });
    assert.equal(conversation(first).length, 1);
    assert.match(conversation(first)[0]!.content, /You are the in-game assistant[\s\S]*<question>\nHow do I craft/);
    // Reasoning goes back unchanged with the tool calls it led to.
    assert.deepEqual((conversation(sent[1]!)[1] as unknown as { reasoning_details: unknown }).reasoning_details, reasoning);
    // Invalid arguments and unknown tools are answered without running or counting a tool call.
    assert.match(toolResult(sent[2]!, 'c4').limitations[0]!, /^invalid_arguments: /);
    assert.match(toolResult(sent[2]!, 'c5').limitations[0]!, /^unknown_tool: shell/);
    const attempt = env.store.listRequestAttempts(key)[0]!;
    assert.equal(env.store.countToolCalls(attempt.attempt_id), 3);
    assert.notEqual(attempt.stop_confirmed_at, null);
    const usage = env.diag.records.find((r) => r.event === 'openrouter.usage' && r.fields.attemptId === attempt.attempt_id)!;
    assert.equal(usage.fields.rounds, 3);
    assert.equal(usage.fields.promptTokens, 30);
    assert.deepEqual(usage.fields.providers, ['Fake']);
  });

  it('answers repeated calls from the earlier result and makes a looping model answer', async () => {
    const addon = new AddonSession(identity('Looper', 'Player-1-000000a6'));
    const looping: Step[] = Array.from({ length: 19 }, (_, i) => () => message(null, { tool_calls: [call(`l${i}`, 'get_source_status', {})] }));
    const { key, request, sent } = await env.ask('Question', addon, [...looping, () => message(JSON.stringify(answer('done')))]);
    assert.equal(request.state, 'completed', String(request.error_code));
    const attempt = env.store.listRequestAttempts(key)[0]!;
    assert.equal(env.store.countToolCalls(attempt.attempt_id), 1);
    assert.match(toolResult(sent[2]!, 'l1').limitations.at(-1)!, /^duplicate_call: /);
    assert.deepEqual(sent.map((s) => s.body.tool_choice), [...Array(19).fill('auto'), 'none']);
    assert.match(conversation(sent[19]!).at(-1)!.content, /^No more tool calls are possible/);
    const usage = env.diag.records.find((r) => r.event === 'openrouter.usage' && r.fields.attemptId === attempt.attempt_id)!;
    assert.equal(usage.fields.repeatedCalls, 18);
    assert.equal(env.diag.records.filter((r) => r.event === 'openrouter.round' && r.fields.attemptId === attempt.attempt_id).length, 20);
  });

  it('repairs a final message that breaks the schema inside the attempt', async () => {
    const addon = new AddonSession(identity('Sloppy', 'Player-1-000000a5'));
    const { key, request, sent } = await env.ask('Question', addon, [
      () => message('Sure! Here is the answer: {"status":"answer","text":"x","limitations":null}'),
      () => message(JSON.stringify(answer('repaired'))),
    ]);
    assert.equal(request.state, 'completed', String(request.error_code));
    assert.deepEqual(env.store.listRequestAttempts(key).map((a) => a.state), ['succeeded']);
    const repair = conversation(sent[1]!);
    assert.deepEqual(repair.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(repair[2]!.content, /^The bridge rejected your previous final message for this question: schema: .*itemRefIds/);
    assert.equal(JSON.parse(env.store.getReplyForRequest(key)!.body_json).text, 'repaired');
  });

  it('keeps the chat in a transcript and sends earlier questions and answers with the full rules', async () => {
    const addon = new AddonSession(identity('Chatty', 'Player-1-000000a2'));
    await env.ask('First question', addon, [() => message(JSON.stringify(answer('First answer')))]);
    const session = env.store.getCurrentModelSession(addon.characterKey, addon.conversationId)!;
    assert.match(session.codex_session_id ?? '', /^[0-9a-f]{32}$/);
    assert.ok(existsSync(join(env.sessionsDir, `${session.codex_session_id}.json`)));

    const { request, sent } = await env.ask('Second question', addon, [() => message(JSON.stringify(answer('Second answer')))]);
    assert.equal(request.state, 'completed');
    const messages = conversation(sent[0]!);
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(messages[0]!.content, /^Earlier question in this chat[\s\S]*First question/);
    assert.doesNotMatch(messages[0]!.content, /<snapshot>/);
    assert.equal(JSON.parse(messages[1]!.content).text, 'First answer');
    assert.match(messages[2]!.content, /You are the in-game assistant[\s\S]*Second question/);
  });

  it('corrects a rejected final message on top of the rejected attempt', async () => {
    const addon = new AddonSession(identity('Fixer', 'Player-1-000000a3'));
    // Fits the schema, but the item ref was never issued: only the bridge can reject it.
    const rejected = JSON.stringify(answer('wand', { itemRefIds: [randomId()] }));
    const { key, request, sent } = await env.ask('Question', addon, [
      () => message(rejected),
      () => message(JSON.stringify(answer('fixed'))),
    ]);
    assert.equal(request.state, 'completed');
    assert.deepEqual(env.store.listRequestAttempts(key).map((a) => a.state), ['invalid_result', 'succeeded']);
    const retry = conversation(sent[1]!);
    assert.deepEqual(retry.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(retry[1]!.content, rejected);
    assert.match(retry[2]!.content, /^The bridge rejected your previous final message for this question: unknown item ref/);
    // The history keeps only the accepted answer.
    const next = await env.ask('Next', addon, [() => message(JSON.stringify(answer('ok')))]);
    const history = conversation(next.sent[0]!);
    assert.equal(history.length, 3);
    assert.equal(JSON.parse(history[1]!.content).text, 'fixed');
  });

  it('reports an API error as model_error and logs its detail', async () => {
    const addon = new AddonSession(identity('Broken', 'Player-1-000000a4'));
    const { request } = await env.ask('Question', addon, [() => new Response('{"error":{"message":"No endpoints found"}}', { status: 404 })]);
    assert.equal(request.error_code, 'model_error');
    assert.ok(env.diag.records.some((r) => r.event === 'openrouter.failed' && String(r.fields.detail).includes('HTTP 404')));
    assert.equal(env.store.getCurrentModelSession(addon.characterKey, addon.conversationId)?.codex_session_id ?? null, null);
    assert.ok(readdirSync(env.sessionsDir).every((name) => !name.endsWith('.tmp')));
  });
});
