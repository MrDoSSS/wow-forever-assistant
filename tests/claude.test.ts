import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { applyClaudeEvent, boundaryProblem, buildClaudeArgs, ClaudeAdapter, claudeSessionId, type ClaudeEvents } from '../bridge/src/ai/claude.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import { ToolChannelHub } from '../bridge/src/app/tool-channel.js';
import { TOOL_NAMES } from '../bridge/src/contracts.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { DatasetManager } from '../bridge/src/sources/foreverdb/update.js';
import { Store } from '../bridge/src/storage/store.js';
import { AddonSession, FakeClock, identity, tempDir } from './fakes.js';
import { syntheticForeverDBArchive } from './foreverdb-fixture.js';

const windows = process.platform === 'win32';
const FAKE_CLAUDE = resourcePath('tests', 'fake-claude.ts');
const MCP_SCRIPT = resourcePath('bridge', 'src', 'sources', 'mcp.ts');
const FOREVER_TOOLS = TOOL_NAMES.map((name) => `mcp__forever__${name}`);

const emptyEvents = (): ClaudeEvents => ({ sessionId: null, init: null, result: null, unknownTypes: new Set() });

describe('Claude CLI arguments and events', () => {
  const mcp = { exe: 'bun.exe', script: 'mcp.ts', pipe: '\\\\.\\pipe\\x', tokenFile: 'C:\\run\\a.token', attemptId: 'a' };

  it('builds new and resume commands with the boundary flags and without the channel token', () => {
    const fresh = buildClaudeArgs({ sessionId: 'id-1', resume: false, schema: '{}', mcp, model: 'sonnet', effort: 'low' });
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(fresh.includes(flag), flag);
    assert.equal(fresh[fresh.indexOf('--tools') + 1], 'WebSearch');
    assert.equal(fresh[fresh.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(fresh[fresh.indexOf('--json-schema') + 1], '{}');
    assert.deepEqual(fresh.slice(fresh.indexOf('--model'), fresh.indexOf('--model') + 4), ['--model', 'sonnet', '--effort', 'low']);
    assert.deepEqual(fresh.slice(-2), ['--session-id', 'id-1']);
    const config = JSON.parse(fresh[fresh.indexOf('--mcp-config') + 1]!) as { mcpServers: { forever: { args: string[] } } };
    assert.deepEqual(config.mcpServers.forever.args.slice(1, 5), ['--pipe', mcp.pipe, '--token-file', mcp.tokenFile]);
    const resumed = buildClaudeArgs({ sessionId: 'id-1', resume: true, schema: '{}', mcp, model: null, effort: null });
    assert.deepEqual(resumed.slice(-2), ['--resume', 'id-1']);
    assert.ok(!resumed.includes('--model') && !resumed.includes('--effort'));
  });

  it('keeps stored UUIDs and derives a stable UUID from other session IDs', () => {
    const uuid = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    assert.equal(claudeSessionId(uuid.toUpperCase()), uuid);
    const derived = claudeSessionId('0123456789abcdef0123456789abcdef');
    assert.match(derived, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(claudeSessionId('0123456789abcdef0123456789abcdef'), derived);
  });

  it('accepts only the forever tools and web search on a connected server', () => {
    assert.equal(boundaryProblem({ tools: ['WebSearch', 'StructuredOutput', ...FOREVER_TOOLS], forever: 'connected' }), null);
    assert.equal(boundaryProblem({ tools: FOREVER_TOOLS, forever: 'connected' }), null);
    assert.match(boundaryProblem({ tools: ['Bash', ...FOREVER_TOOLS], forever: 'connected' })!, /unexpected tools: Bash/);
    assert.match(boundaryProblem({ tools: ['WebSearch'], forever: 'failed' })!, /forever MCP server is failed/);
    assert.match(boundaryProblem({ tools: ['WebSearch', ...FOREVER_TOOLS.slice(1)], forever: 'connected' })!, /missing forever tools/);
  });

  it('reads init, structured results and API errors reported as success', () => {
    const state = emptyEvents();
    assert.deepEqual(applyClaudeEvent(state, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', tools: ['WebSearch'], mcp_servers: [{ name: 'forever', status: 'connected' }] })), { init: true });
    assert.deepEqual(state.init, { tools: ['WebSearch'], forever: 'connected' });
    applyClaudeEvent(state, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '{}', structured_output: { a: 1 }, total_cost_usd: 0.5, num_turns: 3 }));
    assert.deepEqual(state.result?.structured, { a: 1 });
    applyClaudeEvent(state, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_code: 'oauth_not_allowed_for_organization', result: 'disabled' }));
    assert.equal(state.result?.isError, true);
    assert.match(state.result!.detail, /oauth_not_allowed_for_organization/);
    applyClaudeEvent(state, JSON.stringify({ type: 'surprise' }));
    assert.deepEqual([...state.unknownTypes], ['surprise']);
  });
});

describe('Claude adapter with a fake CLI', { skip: !windows }, () => {
  const dir = tempDir();
  const configDir = join(dir, 'claude-config');
  const clock = new FakeClock();
  const diag = new MemoryDiagnostics(clock);
  let store: Store;
  let bridge: Bridge;
  let previousConfigDir: string | undefined;

  before(async () => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    store = Store.open({ path: join(dir, 'assistant.sqlite'), clock });
    const datasets = new DatasetManager({ store, cacheDir: join(dir, 'cache'), clock, diag, fetcher: () => Promise.reject(new Error('offline')) });
    assert.equal((await datasets.importArchive(syntheticForeverDBArchive(), { etag: null, lastModified: null })).status, 'activated');
    const hub = new ToolChannelHub({ store, clock, diag, datasets: { sourceFor: (id) => datasets.sourceFor(id) } });
    const adapter = new ClaudeAdapter({
      command: { exe: process.execPath, prefixArgs: [FAKE_CLAUDE] },
      runDir: join(dir, 'run'),
      schemaPath: resourcePath('schemas', 'model-reply.schema.json'),
      mcp: { exe: process.execPath, script: MCP_SCRIPT },
      channels: hub,
      diag,
    });
    bridge = new Bridge({ store, clock, diag, adapter, datasetId: () => datasets.source?.datasetId ?? null });
  });
  after(async () => {
    await bridge.shutdown();
    store.close();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  });

  async function ask(scenario: string, text: string, addon = new AddonSession(identity('Claude', `Player-1-${randomId().slice(0, 8)}`))) {
    process.env.FAKE_CLAUDE_SCENARIO = scenario;
    const { message, key } = addon.query(text);
    assert.equal(bridge.receive(message).status, 'accepted');
    await bridge.scheduler.idle();
    return { key, addon, request: store.getRequest(key)! };
  }
  const replyText = (key: Parameters<Store['getReplyForRequest']>[0]) => (JSON.parse(store.getReplyForRequest(key)!.body_json) as { text: string }).text;
  const sessionFile = (id: string) => join(configDir, 'projects', 'fake-run-claude', `${id}.jsonl`);

  it('answers through the MCP proxy with verified item refs, evidence and a calculation', async () => {
    const argsFile = join(dir, 'args.jsonl');
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const { key, addon, request } = await ask('tools', 'How do I craft Lesser Magic Wand?');
    delete process.env.FAKE_CLAUDE_ARGS_FILE;
    assert.equal(request.state, 'completed', String(request.error_code));
    const reply = JSON.parse(store.getReplyForRequest(key)!.body_json) as { text: string; itemRefs: { itemId: number }[]; calculationIds: string[] };
    assert.equal(reply.text, 'Lesser Magic Wand: 3 crafts');
    assert.equal(reply.itemRefs[0]!.itemId, 11287);
    assert.equal(reply.calculationIds.length, 1);
    const attempt = store.listRequestAttempts(key)[0]!;
    assert.match(attempt.process_job_name ?? '', /^Local\\ForeverAssistant-/);
    assert.ok(attempt.stop_confirmed_at !== null);
    const session = store.getCurrentModelSession(addon.characterKey, addon.conversationId)!;
    assert.match(session.codex_session_id ?? '', /^[0-9a-f-]{36}$/);
    assert.ok(existsSync(sessionFile(session.codex_session_id!)));
    // The channel token is absent from arguments; only the per-attempt token file is removed.
    const args = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
    assert.doesNotMatch(args.join(' '), /[0-9a-f]{64}/);
    // The model sees the marker rule in the output schema and the system prompt.
    const schema = JSON.parse(args[args.indexOf('--json-schema') + 1]!) as { properties: { text: { description: string } } };
    assert.match(schema.properties.text.description, /\[\[item:<itemRefId>\]\] in place of its name/);
    assert.match(args[args.indexOf('--system-prompt') + 1]!, /\[\[item:<itemRefId>\]\] marker/);
    assert.ok(!existsSync(join(dir, 'run', `${attempt.attempt_id}.token`)));
  });

  it('resumes the saved session with a short prompt and starts over when the CLI lost it', async () => {
    const addon = new AddonSession(identity('Resumer', 'Player-1-000000c1'));
    const first = await ask('echo', 'First question', addon);
    assert.equal(replyText(first.key), 'mode=new rules=true question=true schema=true');
    const second = await ask('echo', 'Second question', addon);
    assert.equal(replyText(second.key), 'mode=resume rules=false question=true schema=true');
    const session = store.getCurrentModelSession(addon.characterKey, addon.conversationId)!;
    rmSync(sessionFile(session.codex_session_id!));
    const third = await ask('echo', 'Third question', addon);
    assert.equal(third.request.state, 'completed', String(third.request.error_code));
    assert.equal(replyText(third.key), 'mode=new rules=true question=true schema=true');
    assert.equal(store.getCurrentModelSession(addon.characterKey, addon.conversationId)!.codex_session_id, session.codex_session_id);
  });

  it('uses the result text when the CLI gives no structured output', async () => {
    const { key, request } = await ask('text', 'Question');
    assert.equal(request.state, 'completed', String(request.error_code));
    assert.equal(replyText(key), 'from result text');
  });

  it('corrects one invalid final message by resuming with the rejection reason', async () => {
    const { key, request } = await ask('invalid-then-fix', 'Question');
    assert.equal(request.state, 'completed');
    assert.deepEqual(store.listRequestAttempts(key).map((a) => a.state), ['invalid_result', 'succeeded']);
    assert.equal(replyText(key), 'fixed in resume');
  });

  it('reports an API error as model_error with its code', async () => {
    const { request } = await ask('fail', 'Question');
    assert.equal(request.error_code, 'model_error');
    assert.ok(diag.records.some((r) => r.event === 'claude.no_output' && String(r.fields.detail).includes('oauth_not_allowed_for_organization')));
  });

  it('stops the CLI when it offers a tool outside the boundary', async () => {
    const { key, request } = await ask('extra-tool', 'Question');
    assert.equal(request.error_code, 'model_profile_unsupported');
    assert.notEqual(store.listRequestAttempts(key)[0]!.stop_confirmed_at, null);
    assert.ok(diag.records.some((r) => r.event === 'claude.boundary_violation' && String(r.fields.detail).includes('Bash')));
  });
});
