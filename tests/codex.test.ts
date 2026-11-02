import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildCodexArgs, CodexAdapter, featureProfile, parseFeatureList, applyCodexEvent, type CodexEvents } from '../bridge/src/ai/codex.js';
import { checkHosted, startHosted } from '../bridge/src/ai/process-host.js';
import { activePlanBrief } from '../bridge/src/domain/plan.js';
import { verifyModelReply } from '../bridge/src/domain/reply.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import { encodeIpcFrame } from '../bridge/src/app/ipc.js';
import { ToolChannelHub, type AttemptContext } from '../bridge/src/app/tool-channel.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { characterKeyOf, randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { AltsSource } from '../bridge/src/sources/alts.js';
import { callBridge } from '../bridge/src/sources/mcp.js';
import { DatasetManager } from '../bridge/src/sources/foreverdb/update.js';
import { Store } from '../bridge/src/storage/store.js';
import { AddonSession, ControlledModel, FakeClock, identity, tempDir } from './fakes.js';
import { LuaHost } from './lua-host.js';
import { readLua } from './lua-reader.js';
import { foreverdbZip, minimalForeverDBData, syntheticForeverDBArchive } from './foreverdb-fixture.js';

/** JavaScript value as a client-style WoW SavedVariables literal. */
function wowLiteral(value: unknown): string {
  if (typeof value === 'string') return LuaHost.literal(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `{\n${value.map((v, i) => `${wowLiteral(v)}, -- [${i + 1}]`).join('\n')}\n}`;
  return `{\n${Object.entries(value as object).map(([k, v]) => `[${LuaHost.literal(k)}] = ${wowLiteral(v)},`).join('\n')}\n}`;
}

/** Banker alt with bank contents and a known enchanting recipe in SavedVariables. */
function altsFixture(dir: string): string {
  const banker = identity('Banker', 'Player-1-0000beef');
  const saved = join(dir, 'WoW', 'WTF', 'Account', '1#1', 'SavedVariables');
  mkdirSync(saved, { recursive: true });
  const db = {
    alts: {
      [characterKeyOf(banker)]: {
        version: 1,
        identity: banker,
        summary: { observedAt: 1_762_000_000, classToken: 'MAGE', raceToken: 'Gnome', faction: 'alliance', level: 25, moneyCopper: 5000, zoneName: 'Ironforge' },
        professions: { observedAt: 1_762_000_000, list: [{ skillId: 333, name: 'Enchanting', rank: 60, maxRank: 75 }] },
        recipes: [{ skillId: 333, observedAt: 1_762_000_000, spellIds: [14293] }],
        bank: { observedAt: 1_762_000_000, items: [{ itemId: 10938, count: 5 }] },
      },
    },
  };
  writeFileSync(join(saved, 'ForeverAssistant.lua'), `ForeverAssistantDB = ${wowLiteral(db)}\n`);
  return join(dir, 'WoW', 'Interface', 'AddOns');
}

const windows = process.platform === 'win32';
const SYNTHETIC_ARCHIVE = syntheticForeverDBArchive();
const FAKE_CODEX = resourcePath('tests', 'fake-codex.ts');
const MCP_SCRIPT = resourcePath('bridge', 'src', 'sources', 'mcp.ts');
/** Wait with real timers because external processes are slower than the event loop. */
async function until(condition: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function environment(options: { model?: 'controlled' | 'codex'; priceTimeoutMs?: number; callsPerAttempt?: number; archive?: Uint8Array } = {}) {
  const dir = tempDir();
  const clock = new FakeClock();
  const diag = new MemoryDiagnostics(clock);
  const store = Store.open({ path: join(dir, 'assistant.sqlite'), clock });
  const datasets = new DatasetManager({ store, cacheDir: join(dir, 'cache'), clock, diag, fetcher: () => Promise.reject(new Error('offline')) });
  assert.equal((await datasets.importArchive(options.archive ?? SYNTHETIC_ARCHIVE, { etag: null, lastModified: null })).status, 'activated');
  const committed: string[] = [];
  const hub = new ToolChannelHub({
    store,
    clock,
    diag,
    datasets: { sourceFor: (id) => datasets.sourceFor(id) },
    alts: new AltsSource(altsFixture(dir)),
    onCommitted: (key) => committed.push(key),
    limits: {
      ...(options.priceTimeoutMs ? { priceTimeoutMs: options.priceTimeoutMs } : {}),
      ...(options.callsPerAttempt ? { callsPerAttempt: options.callsPerAttempt } : {}),
    },
  });
  const runDir = join(dir, 'run');
  mkdirSync(runDir);
  const controlled = new ControlledModel();
  const codex = new CodexAdapter({
    command: { exe: process.execPath, prefixArgs: [FAKE_CODEX] },
    runDir,
    schemaPath: resourcePath('schemas', 'model-reply.schema.json'),
    mcp: { exe: process.execPath, script: MCP_SCRIPT },
    channels: hub,
    diag,
  });
  const bridge = new Bridge({
    store,
    clock,
    diag,
    adapter: options.model === 'codex' ? codex : controlled,
    onPriceResult: (id) => hub.resolvePrice(id),
    datasetId: () => datasets.source?.datasetId ?? null,
  });
  const opened: string[] = [];
  const cleanup = async () => {
    for (const attemptId of opened) await hub.close(attemptId);
    await bridge.shutdown();
    store.close();
  };
  return { dir, runDir, clock, diag, store, datasets, hub, bridge, controlled, codex, committed, opened, cleanup };
}

type Env = Awaited<ReturnType<typeof environment>>;

/** Accepted question with a running attempt, a waiting controlled model and an open channel. */
async function attemptWithChannel(env: Env, adjust?: (query: AttemptContext['query']) => void) {
  // Use a separate character per attempt because another test's question may still be active.
  const addon = new AddonSession(identity('Tester', `Player-1-${randomId().slice(0, 8)}`));
  const { message, key } = addon.query('How much is needed for Lesser Magic Wand?');
  assert.equal(env.bridge.receive(message).status, 'accepted');
  const input = env.controlled.last().input;
  assert.equal(input.datasetId, env.datasets.source!.datasetId);
  const ctx: AttemptContext = { attemptId: input.attemptId, request: key, conversationId: input.conversationId, datasetId: input.datasetId, query: input.query };
  adjust?.(ctx.query);
  const channel = await env.hub.open(ctx);
  env.opened.push(input.attemptId);
  const call = (tool: string, args: object, callId = randomId(), token = channel.token) =>
    callBridge(channel.pipeName, { version: 1, token, callId, attemptId: input.attemptId, tool, args }) as Promise<{
      status: string;
      data: Record<string, unknown>;
      evidenceIds: string[];
      limitations: string[];
      cursor: string | null;
    }>;
  return { addon, key, input, ctx, channel, call };
}

describe('Codex CLI profile and arguments', () => {
  it('builds new and resume commands without the channel token', () => {
    const base = {
      schemaPath: 'C:\\schemas\\model-reply.schema.json',
      lastMessagePath: 'C:\\run\\a.last.json',
      disable: ['shell_tool', 'code_mode'],
      mcp: { exe: 'C:\\node.exe', script: 'C:\\mcp.js', pipe: '\\\\.\\pipe\\x', tokenFile: 'C:\\run\\a.token', attemptId: 'a'.repeat(32) },
      model: null,
    };
    const fresh = buildCodexArgs({ ...base, sessionId: null });
    assert.deepEqual(fresh.slice(0, 2), ['exec', '--json']);
    assert.equal(fresh.at(-1), '-');
    assert.ok(fresh.includes('--ignore-user-config') && fresh.includes('--ignore-rules') && fresh.includes('--skip-git-repo-check'));
    assert.ok(fresh.includes('sandbox_mode="read-only"') && fresh.includes('approval_policy="never"') && fresh.includes('web_search="live"'));
    assert.ok(fresh.join(' ').includes('--disable shell_tool --disable code_mode'));
    const mcpArgs = fresh.find((a) => a.startsWith('mcp_servers.forever.args='))!;
    assert.deepEqual(JSON.parse(mcpArgs.split('=').slice(1).join('=')).slice(1, 3), ['--pipe', '\\\\.\\pipe\\x']);
    const resumed = buildCodexArgs({ ...base, sessionId: '0199-session' });
    assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', '0199-session']);
  });

  it('blocks a CLI that lacks a hard-disabled feature and warns on soft ones', () => {
    const real = parseFeatureList('shell_tool  stable  true\nunified_exec stable true\nmemories stable false\n');
    const profile = featureProfile(real);
    assert.ok(profile.missingHard.includes('browser_use'));
    assert.ok(profile.missingSoft.includes('multi_agent'));
    assert.ok(profile.disable.includes('shell_tool') && profile.disable.includes('code_mode') && !profile.disable.includes('browser_use'));
  });

  it('reads session ID, agent message and failures from JSONL events', () => {
    const state: CodexEvents = { sessionId: null, lastAgentMessage: null, failure: null, unknownTypes: new Set() };
    assert.deepEqual(applyCodexEvent(state, '{"type":"thread.started","thread_id":"t-1"}'), { sessionId: 't-1' });
    applyCodexEvent(state, '{"type":"item.completed","item":{"type":"agent_message","text":"{}"}}');
    applyCodexEvent(state, '{"type":"turn.failed","error":{"message":"limit"}}');
    applyCodexEvent(state, '{"type":"something.new"}');
    applyCodexEvent(state, 'not json');
    assert.deepEqual([state.sessionId, state.lastAgentMessage, state.failure, [...state.unknownTypes]], ['t-1', '{}', 'limit', ['something.new']]);
  });
});

describe('tool channel', { skip: !windows }, () => {
  let env: Env;
  before(async () => {
    env = await environment({ priceTimeoutMs: 1500, callsPerAttempt: 5 });
  });
  after(() => env.cleanup());

  it('serves tools, registers evidence and refs before answering, repeats a callId and refuses a conflict', async () => {
    const { call, input } = await attemptWithChannel(env);
    const callId = randomId();
    const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] }, callId);
    assert.equal(recipe.status, 'ok');
    assert.equal((recipe.data.fields as { green: number }).green, 95);
    assert.equal((recipe.data.names as Record<string, string>)['11287'], 'Lesser Magic Wand');
    const ref = env.store.getVerifiedRef(recipe.data.recipeRefId as string)!;
    assert.equal(ref.kind, 'recipe');
    assert.equal(ref.attempt_id, input.attemptId);
    assert.ok(env.store.isEvidenceLinked([input.attemptId], recipe.evidenceIds[0]!));
    assert.deepEqual(await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] }, callId), recipe);
    assert.deepEqual((await call('get_game_record', { type: 'recipe', id: 7418, recordKey: null, fields: [] }, callId)).limitations, ['call_id_conflict']);

    const calc = await call('calculate_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'bags' });
    assert.equal(calc.status, 'ok');
    assert.equal(calc.data.crafts, 3);
    assert.equal(env.store.getVerifiedRef(calc.data.calculationId as string)!.kind, 'calculation');
    assert.equal((await call('get_game_record', { type: 'item', id: 2147483646, recordKey: null, fields: [] })).status, 'not_found');
    assert.equal((await call('get_game_record', { type: 'recipe', id: 2147483646, recordKey: null, fields: [] })).status, 'not_found');
    // Attempt call budget is 5 in this test; the sixth new call returns limit.
    assert.equal((await call('get_source_status', {})).status, 'ok');
    assert.equal((await call('get_source_status', {})).status, 'limit');
  });

  it('answers about alts from SavedVariables and counts the account inventory in a craft', async () => {
    const { call } = await attemptWithChannel(env);
    const alts = await call('get_alts', {});
    assert.equal(alts.status, 'ok');
    const characters = alts.data.characters as { name: string; current: boolean; level: number | null }[];
    assert.deepEqual(characters.map((c) => [c.name, c.current, c.level]), [['Tester', true, 12], ['Banker', false, 25]]);
    assert.equal(alts.evidenceIds.length, 1);
    assert.ok(alts.limitations.some((l) => l.startsWith('bank_not_seen: Tester')));

    const items = await call('find_items_on_alts', { itemIds: [10938] });
    assert.deepEqual((items.data.items as { holders: { name: string; bank: number }[] }[])[0]!.holders.map((h) => [h.name, h.bank]), [['Banker', 5]]);
    const crafters = await call('find_recipe_crafters', { recipeSpellIds: [14293] });
    assert.deepEqual((crafters.data.recipes as { knownBy: string[]; profession: string }[])[0], {
      ...(crafters.data.recipes as object[])[0],
      knownBy: ['Banker'],
      profession: 'Enchanting',
    });

    const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
    const calc = await call('calculate_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'account' });
    assert.equal(calc.status, 'ok');
    const essence = (calc.data.lines as { itemId: number; knownOwned: number; missing: number }[]).find((l) => l.itemId === 10938)!;
    assert.deepEqual([essence.knownOwned, essence.missing], [5, 0]);
  });

  it('treats prices as the market of the only faction of the account', async () => {
    const { call } = await attemptWithChannel(env, (query) => {
      const prices = query.snapshot.groups.prices;
      if (prices.availability === 'available') {
        prices.value = [{
          item: { itemId: 4470, itemLink: null }, marketKey: 'auctionator:PvP', unit: 'per_item', priceCopper: 38,
          readOriginSessionId: 'd'.repeat(32), readAtSessionMs: 1, sourceObservedAtMs: null, ageDays: 0, agePrecision: 'day_bucket',
          rawExactness: true, exactness: 'exact', source: 'auctionator_v1', sourceVersion: '341', unavailableReason: null,
        }];
      }
    });
    const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
    const calc = await call('calculate_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 1, inventoryScope: 'none' });
    assert.equal(calc.status, 'ok');
    assert.ok(!calc.limitations.includes('market_unverified'), calc.limitations.join('; '));
    assert.ok((calc.data.unpricedItemIds as number[]).includes(10938) && calc.data.priceTotalCopper === 38);
  });

  it('plans a craft with the crafting alt, its stock, purchases and what to mail', async () => {
    const { call, input } = await attemptWithChannel(env);
    const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
    const plan = await call('plan_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'account', maxDepth: 3, lookupPrices: false });
    assert.equal(plan.status, 'ok');
    assert.deepEqual((plan.data.steps as { recipeSpellId: number; crafts: number; crafter: string; learn: string }[]).map((s) => [s.recipeSpellId, s.crafts, s.crafter, s.learn]), [[14293, 3, 'Banker', 'known']]);
    assert.deepEqual(plan.data.fromInventory, [{ itemId: 10938, quantity: 3, from: [{ name: 'Banker', quantity: 3 }] }]);
    assert.deepEqual((plan.data.buy as { itemId: number; quantity: number }[]).map((b) => [b.itemId, b.quantity]), [[4470, 3]]);
    assert.ok((plan.data.buy as { buyer: string }[]).every((row) => row.buyer === 'Banker'));
    assert.deepEqual(plan.data.transfers, [{ itemId: 11287, quantity: 3, from: 'Banker', to: 'Tester' }]);
    assert.equal((plan.data.names as Record<string, string>)['4470'], 'Simple Wood');
    const ref = env.store.getVerifiedRef(plan.data.calculationId as string)!;
    assert.equal(ref.kind, 'calculation');
    assert.equal(ref.attempt_id, input.attemptId);
  });

  it('uses an owned finished item without querying auction prices or crafting a duplicate', async () => {
    const { call, input } = await attemptWithChannel(env, (query) => {
      const bags = query.snapshot.groups.bags;
      if (bags.availability === 'available') bags.value = [{ bag: 0, slot: 1, item: { itemId: 11287, itemLink: null }, count: 1 }];
    });
    const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
    const result = await call('plan_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 1, inventoryScope: 'account', maxDepth: 3, lookupPrices: true });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.data.steps, []);
    assert.deepEqual(result.data.buy, []);
    assert.equal(result.data.totalCostCopper, 0);
    assert.equal((result.data.names as Record<string, string>)['11287'], 'Lesser Magic Wand');
    assert.deepEqual(result.data.fromInventory, [{ itemId: 11287, quantity: 1, from: [{ name: 'Tester', quantity: 1 }] }]);
    assert.equal(env.store.rawQuery<{ n: number }>('SELECT count(*) AS n FROM price_lookups WHERE attempt_id = ?', input.attemptId)[0]!.n, 0);
  });

  it('includes vendor prices, provenance and stock limits in both crafting tools and mixed totals', async () => {
    const data = minimalForeverDBData();
    data['NPCs.lua'] = data['NPCs.lua']!.replace('ns.sold={}', 'ns.sold={[4470]={1317,38,1,0,4213,1,1,0},[10938]={1317,800,1,2}}');
    const vendorEnv = await environment({ archive: foreverdbZip(data) });
    try {
      const { call, input } = await attemptWithChannel(vendorEnv, (query) => {
        const prices = query.snapshot.groups.prices;
        if (prices.availability === 'available') prices.value = [];
      });
      const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
      for (const tool of ['calculate_craft', 'plan_craft']) {
        const result = await call(tool, {
          recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'none',
          ...(tool === 'plan_craft' ? { maxDepth: 3, lookupPrices: false } : {}),
        });
        assert.equal(result.status, 'ok');
        assert.equal(result.data[tool === 'plan_craft' ? 'totalCostCopper' : 'priceTotalCopper'], 2514);
        assert.deepEqual(result.data.unpricedItemIds, []);
        const prices = result.data.prices as { itemId: number; source: string; unitPriceCopper: number; vendor: { npcId: number; datasetId: string } }[];
        assert.deepEqual(prices.map((p) => [p.itemId, p.source, p.unitPriceCopper, p.vendor.npcId]), [[4470, 'vendor', 38, 1317], [10938, 'vendor', 800, 1317]]);
        assert.ok(prices.every((p) => p.vendor.datasetId === input.datasetId));
        assert.ok(result.limitations.some((l) => l.startsWith('vendor_restock_required: item 10938')));
        const evidence = result.evidenceIds.flatMap((id) => vendorEnv.store.rawQuery<{ source_kind: string; used_content_json: string }>('SELECT source_kind, used_content_json FROM evidence WHERE evidence_id = ?', id));
        assert.equal(evidence.filter((e) => e.source_kind === 'foreverdb' && JSON.parse(e.used_content_json).source === 'vendor').length, 2);
        assert.ok(result.evidenceIds.every((id) => vendorEnv.store.isEvidenceLinked([input.attemptId], id)));
        const ref = JSON.parse(vendorEnv.store.getVerifiedRef(result.data.calculationId as string)!.body_json);
        assert.equal(ref.priceTotalCopper, 2514);
      }
      const mixed = await attemptWithChannel(vendorEnv, (query) => {
        const prices = query.snapshot.groups.prices;
        if (prices.availability === 'available') prices.value = [4470, 10938].map((itemId) => ({
          item: { itemId, itemLink: null }, marketKey: 'auctionator:PvP', unit: 'per_item', priceCopper: itemId === 4470 ? 33 : 1450,
          readOriginSessionId: 'd'.repeat(32), readAtSessionMs: 1, sourceObservedAtMs: null, ageDays: 0, agePrecision: 'day_bucket',
          rawExactness: true, exactness: 'exact', source: 'auctionator_v1', sourceVersion: '341', unavailableReason: null,
        }));
      });
      const mixedRecipe = await mixed.call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
      for (const tool of ['calculate_craft', 'plan_craft']) {
        const result = await mixed.call(tool, { recipeRefId: mixedRecipe.data.recipeRefId, desiredQuantity: 1, inventoryScope: 'none', ...(tool === 'plan_craft' ? { maxDepth: 3, lookupPrices: false } : {}) });
        assert.equal(result.status, 'ok');
        assert.equal(result.data[tool === 'plan_craft' ? 'totalCostCopper' : 'priceTotalCopper'], 833);
        const prices = result.data.prices as { source: string; alternatives: { source: string; unitPriceCopper: number; vendor: { npcId: number } | null }[] }[];
        assert.deepEqual(prices.map((p) => p.source), ['auctionator', 'vendor']);
        assert.deepEqual(prices.map((p) => [p.alternatives[0]!.source, p.alternatives[0]!.unitPriceCopper, p.alternatives[0]!.vendor?.npcId ?? null]), [['vendor', 38, 1317], ['auctionator', 1450, null]]);
        const evidence = result.evidenceIds.flatMap((id) => vendorEnv.store.rawQuery<{ source_kind: string; used_content_json: string }>('SELECT source_kind, used_content_json FROM evidence WHERE evidence_id = ?', id));
        assert.ok(evidence.some((e) => e.source_kind === 'foreverdb' && JSON.parse(e.used_content_json).itemId === 4470 && JSON.parse(e.used_content_json).unitPriceCopper === 38), 'the unselected vendor quote is returned with evidence');
        assert.ok(result.evidenceIds.every((id) => vendorEnv.store.isEvidenceLinked([mixed.input.attemptId], id)));
      }
    } finally {
      await vendorEnv.cleanup();
    }
  });

  it('verifies a plan in the reply and gives it back as the active plan of a later question', async () => {
    const { call, input, key } = await attemptWithChannel(env);
    const item = await call('get_game_record', { type: 'item', id: 4470, recordKey: null, fields: [] });
    const itemRefId = item.data.itemRefId as string;
    const step = { kind: 'get', text: 'Buy wood', character: 'Tester', itemRefId, quantity: 3, location: null, mailTo: null, mailFrom: null, moneyCopper: 500, recipeSpellId: null, profession: null, skillRank: null };
    const mail = { ...step, kind: 'mail', text: 'Send wood', mailTo: 'Banker', moneyCopper: null };
    const reply = (steps: object[], locations: object[] = []) => ({
      status: 'answer', text: 'Plan below', itemRefIds: [], evidenceIds: [], locationRefId: null, approxLocation: null,
      locations, calculationIds: [], limitations: ['Prices ≈ 1 day'], clarification: null, plan: { title: 'Wands 1→3', steps, revisesActivePlan: true },
    });
    const check = verifyModelReply(reply([step, mail]), env.store, [input.attemptId]);
    assert.ok(check.ok, check.ok ? '' : check.reason);
    const plan = check.ok ? check.reply.plan! : null;
    assert.equal(plan!.steps[0]!.item!.itemId, 4470);
    assert.equal(plan!.steps[0]!.moneyCopper, null, 'money is only for mail');
    assert.equal(plan!.steps[1]!.mailTo, 'Banker');
    assert.equal(plan!.title, 'Wands 1->3', 'text outside the addon font is replaced');
    assert.equal(plan!.revises, true, 'a correction of the active plan is marked');
    assert.deepEqual(check.ok && check.reply.limitations, ['Prices ~ 1 day']);

    const reason = (steps: object[], locations: object[] = []) => {
      const result = verifyModelReply(reply(steps, locations), env.store, [input.attemptId]);
      return result.ok ? '' : result.reason;
    };
    assert.match(reason([{ ...mail, mailTo: null }]), /plan step 1: mail needs character/);
    assert.match(reason([{ ...mail, mailTo: 'tester' }]), /same character/);
    assert.match(reason([{ ...mail, quantity: null }]), /needs quantity/);
    assert.match(reason([step, { ...step, location: 1 }]), /plan step 2: location 1 is outside the 0 locations/);
    assert.match(reason([{ ...step, itemRefId: randomId() }]), /plan step 1: unknown item ref/);
    assert.match(reason([{ ...step, kind: 'login', character: null }]), /login needs character/);
    assert.match(reason([{ ...step, kind: 'collect', itemRefId: null, character: 'Banker' }]), /collect needs mailFrom/);
    assert.match(reason([{ ...step, kind: 'craft', skillRank: 32, profession: 'Sewing' }]), /skillRank needs profession, one of Alchemy/);
    // Step text links only its own item and place; IDs are dropped so revised steps keep their text.
    const marked = verifyModelReply(reply([{ ...step, text: `Buy 3 [[item:${itemRefId}]] at [[map:1]]`, location: 1 }],
      [{ locationRefId: null, approxLocation: { title: 'Vendor', zoneName: 'Elwynn Forest', x: 40, y: 60, basis: 'b', sourceUrl: 'https://example.com' } }]), env.store, [input.attemptId]);
    assert.ok(marked.ok, marked.ok ? '' : marked.reason);
    assert.equal(marked.ok && marked.reply.plan!.steps[0]!.text, 'Buy 3 [[item]] at [[map]]');
    assert.equal(marked.ok && marked.reply.locations![0]!.approxLocation!.uiMapId, 1429, 'the addon opens the point by map ID in any client language');
    assert.match(reason([step, { ...step, text: `Buy [[item:${randomId()}]]` }]), /plan step 2: text marker \[\[item:[0-9a-f]+\]\] is not the step's own item or place/);
    assert.match(reason([{ ...step, text: 'Go to [[map:1]]' }]), /plan step 1: text marker \[\[map:1\]\] is not the step's own/);
    assert.match(reason([{ ...step, itemRefId: null, quantity: null, text: 'Buy [[item]]' }]), /needs the step's itemRefId/);
    const levelling = verifyModelReply(reply([
      { ...step, kind: 'collect', itemRefId: null, character: 'Banker', mailFrom: 'Tester' },
      { ...step, kind: 'craft', skillRank: 32, profession: 'tailoring' },
    ]), env.store, [input.attemptId]);
    assert.ok(levelling.ok, levelling.ok ? '' : levelling.reason);
    assert.deepEqual(levelling.ok && levelling.reply.plan!.steps.map((s) => [s.kind, s.mailFrom, s.skillId, s.skillRank]), [
      ['collect', 'Tester', null, null],
      ['craft', null, 197, 32],
    ]);
    assert.equal(reason([{ ...step, kind: 'goto', itemRefId: null, location: 1 }], [
      { locationRefId: null, approxLocation: { title: 'Camp', zoneName: 'Elwynn Forest', x: 40, y: 60, basis: 'fixture', sourceUrl: 'https://example.test/map' } },
    ]), '');

    assert.equal(activePlanBrief(env.store, null), null);
    assert.deepEqual(activePlanBrief(env.store, { request: key, done: [true] }), { unavailable: true });
    env.store.insertReply({ replyId: randomId(), request: key, attemptId: input.attemptId, gameReplyJson: JSON.stringify(check.ok && check.reply), now: 1 });
    const brief = activePlanBrief(env.store, { request: key, done: [true] });
    assert.deepEqual(brief && 'steps' in brief && brief.steps.map((s) => [s.n, s.kind, s.itemId, s.mailTo, s.done]), [
      [1, 'get', 4470, null, true],
      [2, 'mail', 4470, 'Banker', false],
    ]);
  });

  it('lists trainers of the snapshot faction with zone names and a ready approximate point', async () => {
    const { call } = await attemptWithChannel(env);
    const result = await call('find_services', { service: 'trainer', itemId: null, zoneName: null, cursor: null, profession: 'Enchanting', classToken: null, forCharacter: null });
    assert.equal(result.status, 'ok');
    const trainers = result.data.services as { id: number; friendlyToFaction: string; zoneName: string | null; approxLocation: unknown; locationRefId: unknown }[];
    assert.ok(trainers.every((t) => t.friendlyToFaction !== 'H'));
    assert.ok(result.limitations.some((l) => l.startsWith('other_faction_hidden')));
    const lucan = trainers.find((t) => t.id === 1317)!;
    assert.equal(lucan.zoneName, 'Stormwind City');
    assert.deepEqual(lucan.approxLocation, {
      title: 'Lucan Cordell',
      zoneName: 'Stormwind City',
      x: 52.9,
      y: 74.4,
      basis: 'Trainer record, NPC 1317',
      sourceUrl: 'https://foreverdb.net',
    });
    assert.equal(result.evidenceIds.length, 1);
    // The snapshot map is not confirmed: only a place ForeverDB players recorded in Forever is verified.
    assert.deepEqual(trainers.filter((t) => t.locationRefId !== null).map((t) => t.id), [1317]);
    const ref = env.store.getVerifiedRef(lucan.locationRefId as string)!;
    assert.deepEqual(JSON.parse(ref.body_json).basis, 'seen_in_forever');
    assert.equal(JSON.parse(ref.body_json).mapKey, 'uiMap:1453');
  });

  it('finds the snapshot zone by its map ID when the client names it in another language', async () => {
    const { call } = await attemptWithChannel(env, (query) => {
      const position = query.snapshot.groups.position;
      if (position.availability === 'available') Object.assign(position.value, { mapKey: 'uiMap:1453', zoneName: 'Sturmwind' });
    });
    const result = await call('find_services', { service: 'trainer', itemId: null, zoneName: null, cursor: null, profession: 'Enchanting', classToken: null, forCharacter: null });
    assert.equal(result.status, 'ok');
    assert.ok(result.limitations.some((l) => l.includes('zone Stormwind City')), result.limitations.join(' | '));
    const lucan = (result.data.services as { id: number; inCharacterZone: boolean }[]).find((t) => t.id === 1317)!;
    assert.equal(lucan.inCharacterZone, true);
  });

  it('lists trainers for an alt by its faction and zone', async () => {
    const { call } = await attemptWithChannel(env);
    const result = await call('find_services', { service: 'trainer', itemId: null, zoneName: null, cursor: null, profession: 'Enchanting', classToken: null, forCharacter: 'banker' });
    assert.equal(result.status, 'ok');
    const trainers = result.data.services as { zoneName: string | null; inCharacterZone: boolean }[];
    assert.equal(trainers[0]!.zoneName, 'Ironforge');
    assert.ok(trainers[0]!.inCharacterZone);
    assert.ok(trainers.some((t) => !t.inCharacterZone));
    assert.ok(result.limitations.some((l) => l.startsWith('services_for: Banker (alliance, zone Ironforge)')));
    assert.equal((await call('find_services', { service: 'trainer', itemId: null, zoneName: null, cursor: null, profession: 'Enchanting', classToken: null, forCharacter: 'Nobody' })).status, 'not_found');
  });

  it('gives a verified point for trainers on the map the client confirmed, and the reply accepts it', async () => {
    const { call, input } = await attemptWithChannel(env, (query) => {
      const position = query.snapshot.groups.position;
      if (position.availability === 'available') position.value = { mapKey: 'uiMap:1453', x: 0.5, y: 0.5, zoneName: 'Stormwind City' };
    });
    const result = await call('find_services', { service: 'trainer', itemId: null, zoneName: null, cursor: null, profession: 'Enchanting', classToken: null, forCharacter: null });
    const trainers = result.data.services as { id: number; uiMapId: number; locationRefId: string | null }[];
    assert.ok(trainers.filter((t) => t.uiMapId !== 1453).every((t) => t.locationRefId === null));
    const lucan = trainers.find((t) => t.id === 1317)!;
    assert.ok(lucan.locationRefId);
    const check = verifyModelReply(
      { status: 'answer', text: 'Lucan Cordell', itemRefIds: [], evidenceIds: result.evidenceIds, locationRefId: lucan.locationRefId, approxLocation: null, calculationIds: [], limitations: [], clarification: null },
      env.store,
      [input.attemptId],
    );
    assert.ok(check.ok, check.ok ? '' : check.reason);
    assert.deepEqual(check.ok && { ...check.reply.locationRef, refId: 'x', x: 0, y: 0, evidenceIds: [] }, { refId: 'x', entityKind: 'npc', entityId: '1317', title: 'Lucan Cordell', mapKey: 'uiMap:1453', x: 0, y: 0, evidenceIds: [], basis: 'client_map' });
    assert.ok(check.ok && Math.abs(check.reply.locationRef!.x - 0.529) < 1e-9 && Math.abs(check.reply.locationRef!.y - 0.744) < 1e-9);
    const output = { status: 'answer', text: 'Visit [[map:1]] and [[map:2]].', itemRefIds: [], evidenceIds: result.evidenceIds,
      locationRefId: null, approxLocation: null, calculationIds: [], limitations: [], clarification: null,
      locations: [
        { locationRefId: lucan.locationRefId, approxLocation: null },
        { locationRefId: null, approxLocation: { title: 'Camp', zoneName: 'Elwynn Forest', x: 40, y: 60, basis: 'fixture', sourceUrl: 'https://example.test/map' } },
      ] };
    const multi = verifyModelReply(output, env.store, [input.attemptId]);
    assert.ok(multi.ok, multi.ok ? '' : multi.reason);
    if (multi.ok) {
      assert.equal(multi.reply.locations?.[0]?.locationRef?.entityId, '1317');
      assert.equal(multi.reply.locations?.[1]?.approxLocation?.title, 'Camp');
    }
    const foreign = verifyModelReply(output, env.store, [randomId()]);
    assert.ok(!foreign.ok && foreign.reason.includes('another request'));
  });

  it('closes the connection on a wrong token, oversized frame or another attempt without effect', async () => {
    const { call, input, channel } = await attemptWithChannel(env);
    const before = env.store.countToolCalls(input.attemptId);
    await assert.rejects(call('get_source_status', {}, randomId(), 'f'.repeat(64)));
    await assert.rejects(
      callBridge(channel.pipeName, { version: 1, token: channel.token, callId: randomId(), attemptId: 'a'.repeat(32), tool: 'get_source_status', args: {} }),
    );
    await assert.rejects(call('get_game_record', { type: 'item', id: 'x', recordKey: null, fields: [] }));
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = connect(channel.pipeName, () => {
          const header = Buffer.alloc(4);
          header.writeUInt32LE(200_000, 0);
          socket.write(header);
        });
        socket.on('close', () => reject(new Error('closed')));
        socket.on('data', resolve);
      }),
    );
    assert.equal(env.store.countToolCalls(input.attemptId), before);
    assert.throws(() => encodeIpcFrame({ big: 'x'.repeat(200_000) }));
  });

  it('pages search results with a cursor bound to the attempt and arguments', async () => {
    const { call } = await attemptWithChannel(env);
    const first = await call('search_game_data', { query: 'a', types: ['item'], cursor: null });
    assert.equal((first.data.hits as unknown[]).length, 20);
    assert.ok(first.cursor);
    const second = await call('search_game_data', { query: 'a', types: ['item'], cursor: first.cursor });
    assert.notDeepEqual(second.data.hits, first.data.hits);
    assert.deepEqual((await call('search_game_data', { query: 'b', types: ['item'], cursor: first.cursor })).status, 'error');
  });

  it('asks the addon for prices and returns them in the same call; times out after the limit', async () => {
    const { call, addon, key } = await attemptWithChannel(env);
    const pending = call('lookup_prices', { items: [{ itemId: 10938, itemLink: null }] });
    await until(() => env.store.listRequestDeliveries(key).some((d) => d.kind === 'price_lookup'), 'price_lookup delivery');
    const delivery = env.store.listRequestDeliveries(key).find((d) => d.kind === 'price_lookup')!;
    const lookupId = (readLua(delivery.body_lua) as { body: { lookupId: string } }).body.lookupId;
    assert.ok(env.committed.includes(key.characterKey));
    const observation = {
      item: { itemId: 10938, itemLink: null },
      marketKey: 'forever:Forever:alliance',
      unit: 'per_item',
      priceCopper: 140,
      readOriginSessionId: addon.originSessionId,
      readAtSessionMs: 10,
      sourceObservedAtMs: null,
      ageDays: 0,
      agePrecision: 'day_bucket',
      rawExactness: true,
      exactness: 'exact',
      source: 'auctionator_v1',
      sourceVersion: '341',
      unavailableReason: null,
    };
    assert.equal(env.bridge.receive(addon.message('PRICE_RESULT', { request: key, lookupId, observations: [observation], unavailableReason: null })).status, 'accepted');
    const result = await pending;
    assert.equal(result.status, 'ok');
    assert.equal((result.data.observations as { priceCopper: number }[])[0]!.priceCopper, 140);
    assert.equal(result.evidenceIds.length, 1);

    const timeout = await call('lookup_prices', { items: [{ itemId: 4470, itemLink: null }] });
    assert.equal(timeout.status, 'source_unavailable');
    assert.match(timeout.limitations[0]!, /price_lookup_timeout/);
  });

  it('asks the client for item info through the price lookup and rejects info for other items', async () => {
    const { call, addon, key, input } = await attemptWithChannel(env);
    const pending = call('lookup_items', { items: [{ itemId: 11287, itemLink: null }] });
    await until(() => env.store.listRequestDeliveries(key).some((d) => d.kind === 'price_lookup'), 'price_lookup delivery');
    const delivery = env.store.listRequestDeliveries(key).find((d) => d.kind === 'price_lookup')!;
    const body = (readLua(delivery.body_lua) as { body: { lookupId: string; itemInfo: boolean } }).body;
    assert.equal(body.itemInfo, true);
    const info = {
      item: { itemId: 11287, itemLink: null },
      name: 'Lesser Magic Wand',
      quality: 2,
      itemLevel: 13,
      requiredLevel: 8,
      itemType: 'Weapon',
      itemSubType: 'Wands',
      equipSlot: 'INVTYPE_RANGEDRIGHT',
      sellPriceCopper: 100,
      tooltip: ['Lesser Magic Wand', '(11.3 damage per second)', 'Requires Level 8'],
      unavailableReason: null,
    };
    const other = { ...info, item: { itemId: 1, itemLink: null } };
    const reply = (itemInfo: object[]) =>
      addon.message('PRICE_RESULT', { request: key, lookupId: body.lookupId, observations: [], unavailableReason: 'api_unavailable', itemInfo });
    assert.equal(env.bridge.receive(reply([other])).status, 'conflict');
    assert.equal(env.bridge.receive(reply([info])).status, 'accepted');
    const result = await pending;
    assert.equal(result.status, 'ok');
    const items = result.data.items as (typeof info)[];
    assert.deepEqual([items[0]!.requiredLevel, items[0]!.tooltip[1]], [8, '(11.3 damage per second)']);
    assert.deepEqual(result.data.prices, []);
    assert.equal(result.evidenceIds.length, 1);
    assert.ok(result.limitations.some((l) => l.startsWith('client_item_info')));
    const itemRefId = (items[0] as unknown as { itemRefId: string }).itemRefId;
    assert.equal(env.store.getVerifiedRef(itemRefId)!.kind, 'item');
    assert.equal(env.store.listClientItemInfo(body.lookupId).length, 1);
    const check = verifyModelReply(
      { status: 'answer', text: 'Take [[item:' + itemRefId + ']]', itemRefIds: [itemRefId], evidenceIds: result.evidenceIds, locationRefId: null, approxLocation: null, calculationIds: [], limitations: [], clarification: null },
      env.store,
      [input.attemptId],
    );
    assert.ok(check.ok && check.reply.itemRefs[0]!.itemId === 11287);
  });

  it('reports cancelled for calls after the question is stopped', async () => {
    const { call, addon, key } = await attemptWithChannel(env);
    assert.equal(env.bridge.receive(addon.cancel(key)).status, 'accepted');
    assert.equal((await call('get_source_status', {})).status, 'cancelled');
  });
});

describe('process host', { skip: !windows }, () => {
  it('stops the whole tree and confirms zero active processes', async () => {
    const script = `const g = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000);`;
    const hosted = await startHosted(`Local\\ForeverAssistant-test-${randomId()}`, { exe: process.execPath, args: ['-e', script], cwd: tempDir() });
    let out = '';
    hosted.onStdout((chunk) => (out += chunk.toString()));
    hosted.resume();
    await until(() => out.trim() !== '', 'grandchild pid');
    const grandchild = Number(out.trim());
    assert.ok(alive(hosted.info.pid) && alive(grandchild));
    assert.equal(await hosted.stop(), 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!alive(hosted.info.pid) && !alive(grandchild));
    const check = await checkHosted(hosted.info.jobName, hosted.info.pid, hosted.info.createdAt);
    assert.equal(check.activeProcesses, 0);
  });

  it('kills the tree when the bridge process dies', async () => {
    const dir = tempDir();
    const pidFile = join(dir, 'pids.json');
    const launcher = `
      const { startHosted } = await import(${JSON.stringify(new URL('../bridge/src/ai/process-host.ts', import.meta.url).href)});
      const h = await startHosted('Local\\\\ForeverAssistant-test-${randomId()}', { exe: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: ${JSON.stringify(dir)} });
      h.resume();
      require('fs').writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: h.info.pid, host: h.info.hostPid }));
      process.exit(0);`;
    await new Promise<void>((resolve) => spawn(process.execPath, ['--input-type=module', '-e', launcher.replace("require('fs')", "(await import('node:fs'))")], { stdio: 'ignore' }).on('exit', () => resolve()));
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { child: number; host: number };
    await until(() => !alive(pids.child) && !alive(pids.host), 'tree killed after bridge death');
    assert.equal(alive(pids.child), false);
    assert.equal(alive(pids.host), false);
  });
});

describe('Codex adapter with a fake CLI', { skip: !windows }, () => {
  let env: Env;
  before(async () => {
    env = await environment({ model: 'codex' });
  });
  after(() => env.cleanup());

  async function ask(text: string, addon = new AddonSession(identity())) {
    const { message, key } = addon.query(text);
    assert.equal(env.bridge.receive(message).status, 'accepted');
    await env.bridge.scheduler.idle();
    return { key, addon, request: env.store.getRequest(key)! };
  }

  it('answers through the MCP proxy with verified item refs, evidence and a calculation', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'tools';
    const argsFile = join(env.dir, 'args.jsonl');
    process.env.FAKE_CODEX_ARGS_FILE = argsFile;
    const { key, request } = await ask('How do I craft Lesser Magic Wand?');
    assert.equal(request.state, 'completed', String(request.error_code));
    const reply = JSON.parse(env.store.getReplyForRequest(key)!.body_json) as { text: string; itemRefs: { itemId: number; evidenceIds: string[] }[]; calculationIds: string[]; evidenceIds: string[] };
    assert.match(reply.text, /3 crafts; missing lookup: not_found/);
    assert.equal(reply.itemRefs[0]!.itemId, 11287);
    assert.ok(reply.itemRefs[0]!.evidenceIds.length > 0);
    assert.equal(reply.calculationIds.length, 1);
    const attempt = env.store.listRequestAttempts(key)[0]!;
    assert.match(attempt.process_job_name ?? '', /^Local\\ForeverAssistant-/);
    assert.ok(attempt.stop_confirmed_at !== null && attempt.child_pid !== null);
    assert.equal(attempt.dataset_id, env.datasets.source!.datasetId);
    // The channel token is absent from arguments; attempt work files are removed.
    const args = readFileSync(argsFile, 'utf8');
    assert.ok(!args.includes('.token"') || !/[0-9a-f]{64}/.test(args));
    assert.deepEqual(readdirSync(env.runDir), []);
  });

  it('continues the saved session by ID with a short prompt', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'echo';
    const addon = new AddonSession(identity('Second', 'Player-1-00000077'));
    const first = await ask('First question', addon);
    const session = env.store.getCurrentModelSession(addon.characterKey, addon.conversationId)!;
    assert.match(session.codex_session_id ?? '', /^[0-9a-f-]{36}$/);
    assert.match(JSON.parse(env.store.getReplyForRequest(first.key)!.body_json).text, /mode=new rules=true question=true/);
    const second = await ask('Second question', addon);
    assert.match(JSON.parse(env.store.getReplyForRequest(second.key)!.body_json).text, /mode=resume rules=false question=true/);
  });

  it('corrects one invalid final message by resuming with the rejection reason', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'invalid-then-fix';
    const { key, request } = await ask('Question', new AddonSession(identity('Third', 'Player-1-00000078')));
    assert.equal(request.state, 'completed');
    assert.deepEqual(env.store.listRequestAttempts(key).map((a) => a.state), ['invalid_result', 'succeeded']);
    assert.match(JSON.parse(env.store.getReplyForRequest(key)!.body_json).text, /fixed in resume/);
  });

  it('reports a failed turn as model_error', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'fail';
    const { request } = await ask('Question', new AddonSession(identity('Fourth', 'Player-1-00000079')));
    assert.equal(request.error_code, 'model_error');
  });

  it('stops the Codex process tree on Stop and confirms the stop', async () => {
    process.env.FAKE_CODEX_SCENARIO = 'hang';
    const addon = new AddonSession(identity('Fifth', 'Player-1-00000080'));
    const { message, key } = addon.query('Long-running question');
    env.bridge.receive(message);
    await until(() => env.store.listRequestAttempts(key)[0]?.child_pid != null, 'codex started');
    const childPid = env.store.listRequestAttempts(key)[0]!.child_pid!;
    assert.equal(env.bridge.receive(addon.cancel(key)).status, 'accepted');
    await env.bridge.scheduler.idle();
    const attempt = env.store.listRequestAttempts(key)[0]!;
    assert.equal(attempt.state, 'cancelled');
    assert.notEqual(attempt.stop_confirmed_at, null);
    assert.equal(alive(childPid), false);
    assert.equal(env.store.getReplyForRequest(key), undefined);
    assert.ok(!existsSync(join(env.runDir, attempt.attempt_id)));
  });
});
