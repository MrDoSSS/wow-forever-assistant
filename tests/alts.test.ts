import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Message, type QueryBody } from '../bridge/src/contracts.js';
import { accountBrief, accountInventory, accountView, coverageLimitations, describeAccount, itemHoldings, recipeCrafters, singleFaction } from '../bridge/src/domain/alts.js';
import { buildPrompt } from '../bridge/src/ai/prompt.js';
import type { AttemptInput } from '../bridge/src/ai/adapter.js';
import { calculateCraft } from '../bridge/src/domain/crafting.js';
import { decodeUtf8 } from '../bridge/src/app/messages.js';
import { characterKeyOf } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { AltsSource, altRecordsOf, savedVariablesFiles, type AltRecord } from '../bridge/src/sources/alts.js';
import type { RecipeRecord } from '../bridge/src/sources/shared/types.js';
import { parseSavedVariables, type LiteralValue } from '../bridge/src/sources/shared/lua.js';
import { AddonSession, identity, tempDir } from './fakes.js';
import { LuaHost } from './lua-host.js';

const NOW = 1_762_000_000;

/** Addon in fengari with bank, mail and the newer profession window API. */
function addonWithAlts(): LuaHost {
  const lua = new LuaHost();
  lua.runFile(resourcePath('tests', 'wow-serialize.lua'));
  lua.run(`
    time = function() return ${NOW} end
    local slots, info = C_Container.GetContainerNumSlots, C_Container.GetContainerItemInfo
    C_Container.GetContainerNumSlots = function(bag) if bag == -1 then return 24 end return slots(bag) end
    C_Container.GetContainerItemInfo = function(bag, slot)
      if bag == -1 and slot == 1 then return { itemID = 2589, stackCount = 20 } end
      return info(bag, slot)
    end
    GetInboxNumItems = function() return 2 end
    GetInboxHeaderInfo = function(i) return nil, nil, "Sender", "Subject", 0, i == 2 and 500 or 0 end
    GetInboxItem = function(i, j)
      if j == 1 then return "Linen Cloth", 2589, "tex", i == 1 and 5 or 7 end
    end
    C_TradeSkillUI = {
      GetAllRecipeIDs = function() return { 2963, 3275, 9999 } end,
      GetRecipeInfo = function(id) return { learned = id ~= 9999 } end,
      GetBaseProfessionInfo = function() return { professionID = 197, professionName = "Tailoring" } end,
      GetProfessionInfoByRecipeID = function() return { professionID = 197 } end,
    }`);
  lua.loadAddon();
  lua.run('__FA_NS.Assistant.start()');
  return lua;
}

const ALT = 'ForeverAssistantDB.alts[__FA_NS.Assistant.session.characterKey]';

function writeSaved(lua: LuaHost, dir: string, account = '1#1'): string {
  const saved = join(dir, 'WoW', 'WTF', 'Account', account, 'SavedVariables');
  mkdirSync(saved, { recursive: true });
  mkdirSync(join(dir, 'WoW', 'Interface', 'AddOns'), { recursive: true });
  const file = join(saved, 'ForeverAssistant.lua');
  writeFileSync(file, lua.eval('WowSavedVariables("ForeverAssistantDB")'), 'utf8');
  return join(dir, 'WoW', 'Interface', 'AddOns');
}

/** SavedVariables alt: a different GUID in the same server namespace. */
function addAlt(lua: LuaHost, name: string, guid: string, extra: string): void {
  lua.run(`
    local identity = { serverNamespace = "forever-test", realm = "Forever", playerGuid = ${LuaHost.literal(guid)}, displayName = ${LuaHost.literal(name)} }
    ForeverAssistantDB.alts[__FA_NS.Assistant.characterKeyOf(identity)] = {
      version = 1, identity = identity, recipes = {},
      summary = { observedAt = ${NOW - 3600}, classToken = "PRIEST", raceToken = "Scourge", faction = "horde", level = 30, moneyCopper = 99 },
      ${extra}
    }`);
}

function query(): QueryBody {
  const { message } = new AddonSession(identity()).query('How much linen do I have?');
  const parsed = Message.parse(JSON.parse(decodeUtf8(message.bytes)));
  if (parsed.type !== 'QUERY') throw new Error('not a query');
  return parsed.body;
}

const tailoring = (spellId: number, learn: number): RecipeRecord => ({
  spellId,
  profession: 'Tailoring',
  learn,
  yellow: null,
  green: null,
  grey: null,
  greenDerived: false,
  outputItemId: 2568,
  outputCount: 1,
  taughtByItemId: null,
  status: null,
  reagents: [{ itemId: 2589, count: 3 }],
  limitations: [],
});

describe('alts in the addon', () => {
  it('saves summary, equipment, professions and bags at start; bank and mail only while open', () => {
    const lua = addonWithAlts();
    assert.equal(lua.eval(`${ALT}.summary.level`), '12');
    assert.equal(lua.eval(`${ALT}.summary.classToken`), 'MAGE');
    assert.equal(lua.eval(`${ALT}.summary.observedAt`), String(NOW));
    assert.equal(lua.eval(`${ALT}.identity.playerGuid`), 'Player-1-00000001');
    assert.equal(lua.eval(`${ALT}.equipment.items[1].itemId`), '7046');
    assert.equal(lua.eval(`${ALT}.bags.items[1].itemId .. "x" .. ${ALT}.bags.items[1].count`), '118x2');
    assert.equal(lua.eval(`${ALT}.bank`), 'nil');
    assert.equal(lua.eval(`${ALT}.mail`), 'nil');

    lua.run('__FA_NS.Alts.onEvent("BANKFRAME_OPENED")');
    assert.equal(lua.eval(`${ALT}.bank.items[1].itemId .. "x" .. ${ALT}.bank.items[1].count`), '2589x20');
    // Ignore cash-on-delivery mail.
    lua.run('__FA_NS.Alts.onEvent("MAIL_SHOW")');
    assert.equal(lua.eval(`#${ALT}.mail.items .. ":" .. ${ALT}.mail.items[1].count`), '1:5');
  });

  it('saves learned recipes of the own profession window and ignores a linked one', () => {
    const lua = addonWithAlts();
    lua.run('__FA_NS.Alts.onEvent("TRADE_SKILL_SHOW")');
    assert.equal(lua.eval(`${ALT}.recipes[1].skillId`), '197');
    assert.equal(lua.eval(`table.concat(${ALT}.recipes[1].spellIds, ",")`), '2963,3275');
    lua.run('C_TradeSkillUI.IsTradeSkillLinked = function() return true end; C_TradeSkillUI.GetAllRecipeIDs = function() return { 1 } end');
    lua.run('__FA_NS.Alts.onEvent("TRADE_SKILL_LIST_UPDATE")');
    assert.equal(lua.eval(`table.concat(${ALT}.recipes[1].spellIds, ",")`), '2963,3275');
  });

  it('keeps saved values while the world is torn down', () => {
    const lua = addonWithAlts();
    lua.run('__FA_NS.Alts.onEvent("PLAYER_LEAVING_WORLD"); UnitLevel = function() return 13 end');
    lua.run('__FA_NS.Alts.onEvent("PLAYER_LEVEL_UP")');
    assert.equal(lua.eval(`${ALT}.summary.level`), '12');
    lua.run('__FA_NS.Alts.onEvent("PLAYER_ENTERING_WORLD")');
    assert.equal(lua.eval(`${ALT}.summary.level`), '13');
    lua.run('UnitLevel = function() return 0 end; __FA_NS.Alts.onEvent("PLAYER_LEVEL_UP")');
    assert.equal(lua.eval(`${ALT}.summary.level`), '13');
    lua.run('C_Container.GetContainerNumSlots = function() return 0 end; __FA_NS.Alts.onEvent("BAG_UPDATE_DELAYED")');
    assert.equal(lua.eval(`#${ALT}.bags.items`), '2');
  });
});

describe('alts read by the bridge', () => {
  it('reads every character from the SavedVariables file written by the client', () => {
    const lua = addonWithAlts();
    lua.run('__FA_NS.Alts.onEvent("BANKFRAME_OPENED"); __FA_NS.Alts.onEvent("TRADE_SKILL_SHOW")');
    addAlt(lua, 'Banker', 'Player-1-00000002', 'bank = { observedAt = 1, items = { { itemId = 2589, count = 40 } } },');
    const addons = writeSaved(lua, tempDir());
    const source = new AltsSource(addons);
    const { records, limitations } = source.load();
    assert.deepEqual(limitations, []);
    assert.equal(records.length, 2);
    const me = records.find((r) => r.identity.displayName === 'Tester')!;
    assert.equal(me.characterKey, characterKeyOf(identity()));
    assert.equal(me.summary!.level, 12);
    assert.deepEqual(me.bank!.items, [{ itemId: 2589, count: 20 }]);
    assert.deepEqual(me.recipes, [{ skillId: 197, observedAt: NOW, spellIds: [2963, 3275] }]);
    const banker = records.find((r) => r.identity.displayName === 'Banker')!;
    assert.equal(banker.mail, null);
    assert.equal(banker.summary!.faction, 'horde');
    assert.equal(source.load().records[0], source.load().records[0], 'an unchanged file is not parsed again');
  });

  it('skips characters without a matching identity and malformed sections', () => {
    const db = {
      alts: {
        ['f'.repeat(64)]: { version: 1, identity: identity('Fake') },
        [characterKeyOf(identity('Real', 'Player-1-00000009'))]: {
          version: 1,
          identity: identity('Real', 'Player-1-00000009'),
          summary: { observedAt: 1, classToken: 'MAGE', raceToken: '', faction: 'alliance', level: 0 },
          bags: { observedAt: 1, items: [{ itemId: 118, count: 2 }] },
        },
      },
    };
    const { records, limitations } = altRecordsOf(JSON.parse(JSON.stringify(db)) as LiteralValue, 0);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.summary, null);
    assert.deepEqual(records[0]!.bags!.items, [{ itemId: 118, count: 2 }]);
    assert.ok(limitations.some((l) => l.startsWith('alt_skipped')));
    assert.ok(limitations.some((l) => l.includes('summary is malformed')));
  });

  it('takes the later save when a character is in two account folders and reports unreadable files', () => {
    const dir = tempDir();
    const lua = addonWithAlts();
    const addons = writeSaved(lua, dir, 'A');
    lua.run(`${ALT}.summary.level = 20`);
    writeSaved(lua, dir, 'B');
    const older = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'WoW', 'WTF', 'Account', 'A', 'SavedVariables', 'ForeverAssistant.lua'), older, older);
    assert.equal(savedVariablesFiles(addons).length, 2);
    assert.equal(new AltsSource(addons).load().records[0]!.summary!.level, 20);
    mkdirSync(join(dir, 'WoW', 'WTF', 'Account', 'C', 'SavedVariables'), { recursive: true });
    writeFileSync(join(dir, 'WoW', 'WTF', 'Account', 'C', 'SavedVariables', 'ForeverAssistant.lua'), 'ForeverAssistantDB = os.exit()');
    assert.ok(new AltsSource(addons).load().limitations.some((l) => l.startsWith('alts_file_unreadable')));
    assert.deepEqual(new AltsSource(null).load().limitations, ['alts_unavailable: addonsPath is not configured']);
  });

  it('parses only the requested SavedVariables names', () => {
    const bytes = new TextEncoder().encode('Other = { 1, 2 }\nForeverAssistantDB = { ["a"] = { "x", -- [1]\n }, }\n');
    assert.deepEqual(JSON.parse(JSON.stringify(parseSavedVariables(bytes, ['ForeverAssistantDB']).values)), { ForeverAssistantDB: { a: ['x'] } });
  });
});

describe('account view', () => {
  function records(): AltRecord[] {
    const lua = addonWithAlts();
    lua.run('__FA_NS.Alts.onEvent("BANKFRAME_OPENED"); __FA_NS.Alts.onEvent("MAIL_SHOW"); __FA_NS.Alts.onEvent("TRADE_SKILL_SHOW")');
    addAlt(
      lua,
      'Banker',
      'Player-1-00000002',
      `bank = { observedAt = 1, items = { { itemId = 2589, count = 40 } } },
       professions = { observedAt = 1, list = { { skillId = 197, name = "Tailoring", rank = 50, maxRank = 75 } } },
       recipes = { { skillId = 197, observedAt = 1, spellIds = { 3275 } } },`,
    );
    addAlt(lua, 'Other', 'Player-1-00000003', 'professions = { observedAt = 1, list = { { skillId = 197, name = "Tailoring", rank = 10, maxRank = 75 } } },');
    return new AltsSource(writeSaved(lua, tempDir())).load().records;
  }

  it('puts the current character first with snapshot data and the alts after it', () => {
    const view = accountView(records(), query(), characterKeyOf(identity()));
    assert.deepEqual(view.map((c) => [c.name, c.current]), [['Tester', true], ['Banker', false], ['Other', false]]);
    const me = view[0]!;
    assert.equal(me.bags!.source, 'snapshot');
    assert.equal(me.bank!.source, 'saved');
    const described = describeAccount(view);
    assert.equal(described[1]!.level, 30);
    assert.equal(described[1]!.professions[0]!.knownRecipes, 1);
    assert.equal(described[0]!.data.bank!.observedAt, new Date(NOW * 1000).toISOString());
    assert.ok(coverageLimitations(view).some((l) => l.startsWith('mail_not_seen: Banker, Other')));
  });

  it('finds items across characters, recipe crafters and the account inventory', () => {
    const view = accountView(records(), query(), characterKeyOf(identity()));
    const [linen] = itemHoldings(view, [2589]);
    assert.equal(linen!.total, 65);
    assert.deepEqual(linen!.holders.map((h) => [h.name, h.bank, h.mail]), [['Banker', 40, 0], ['Tester', 20, 5]]);

    // The test character knows 2963 from the profession window but has no Tailoring skill in its snapshot.
    assert.deepEqual(recipeCrafters(view, 2963, null).knownBy, ['Tester']);
    const report = recipeCrafters(view, 2963, tailoring(2963, 30));
    assert.deepEqual(report.canLearnNow, [{ name: 'Banker', rank: 50 }]);
    assert.deepEqual(report.notScanned, [{ name: 'Other', rank: 10 }]);
    assert.deepEqual(recipeCrafters(view, 3275, tailoring(3275, 30)).knownBy, ['Banker']);

    const result = calculateCraft({
      recipe: tailoring(2963, 1),
      desiredQuantity: 30,
      inventory: { scope: 'account', owned: accountInventory(view), limitations: [] },
      prices: new Map(),
    });
    assert.deepEqual(result.lines, [{ itemId: 2589, needed: 90, knownOwned: 65, missing: 25 }]);
    assert.ok(result.limitations.some((l) => l.startsWith('account_inventory')));
  });

  it('knows the single faction of the account only when every character has the same known one', () => {
    assert.equal(singleFaction(accountView([], query(), characterKeyOf(identity()))), 'alliance');
    // Banker and Other are Horde; the current character is Alliance.
    assert.equal(singleFaction(accountView(records(), query(), characterKeyOf(identity()))), null);
    const noSummary = accountView([], query(), characterKeyOf(identity()));
    noSummary[0]!.summary = null;
    assert.equal(singleFaction(noSummary), null);
  });

  it('shows only the current character from the snapshot when nothing is saved', () => {
    const view = accountView([], query(), characterKeyOf(identity()));
    assert.equal(view.length, 1);
    assert.equal(view[0]!.summary!.value.level, 12);
    assert.equal(view[0]!.bank, null);
  });
});

describe('alts in the prompt', () => {
  const attempt = (codexSessionId: string | null): AttemptInput => ({
    attemptId: 'a'.repeat(32),
    ordinal: 1,
    request: { characterKey: characterKeyOf(identity()), originSessionId: 'b'.repeat(32), requestId: 1 },
    conversationId: 'c'.repeat(32),
    query: query(),
    modelSession: { generation: 1, codexSessionId },
    datasetId: null,
    correction: null,
  });
  const brief = [{ name: 'Banker', classToken: 'MAGE', level: 25, faction: 'alliance', moneyCopper: 10_000_000, professions: ['Enchanting 10/75'], savedAt: null }];

  it('gives the other characters and the alt rules to new and continued sessions', () => {
    for (const session of [null, 'thread-1']) {
      const prompt = buildPrompt(attempt(session), brief);
      assert.ok(prompt.includes('</characters>') && prompt.includes('"moneyCopper":10000000'), String(session));
      assert.ok(prompt.includes('find_recipe_crafters') && prompt.includes('move freely between own characters by mail'), String(session));
    }
    assert.ok(buildPrompt(attempt('thread-1'), []).includes('No other characters of the player are saved yet.'));
    assert.ok(!buildPrompt(attempt(null), null).includes('</characters>'));
  });

  it('gives the plan rules to every session and the active plan with its done marks', () => {
    const plan = { title: 'Wands', steps: [{ n: 1, kind: 'get', text: 'Buy wood', character: 'Tester', itemId: 4470, quantity: 3, mailTo: null, mailFrom: null, moneyCopper: null, skillRank: null, done: true }] };
    for (const session of [null, 'thread-1']) {
      const prompt = buildPrompt(attempt(session), null, plan);
      assert.ok(prompt.includes('Plans (this replaces any earlier rule about plans)'), String(session));
      assert.ok(prompt.includes('</active_plan>') && prompt.includes('"done":true'), String(session));
    }
    assert.ok(!buildPrompt(attempt(null)).includes('</active_plan>'));
    assert.ok(buildPrompt(attempt(null), null, { unavailable: true }).includes('its answer was deleted'));
  });

  it('lists only the other characters in the brief', () => {
    const lua = addonWithAlts();
    addAlt(lua, 'Banker', 'Player-1-00000002', 'professions = { observedAt = 1, list = { { skillId = 333, name = "Enchanting", rank = 10, maxRank = 75 } } },');
    lua.run('for _, r in pairs(ForeverAssistantDB.alts) do if r.identity.displayName == "Banker" then r.summary.fullName = "Banker Ironfoot" end end');
    const view = accountView(new AltsSource(writeSaved(lua, tempDir())).load().records, query(), characterKeyOf(identity()));
    assert.deepEqual(accountBrief(view), [
      { name: 'Banker', fullName: 'Banker Ironfoot', classToken: 'PRIEST', level: 30, faction: 'horde', moneyCopper: 99, zoneName: null, professions: ['Enchanting 10/75'], savedAt: new Date((NOW - 3600) * 1000).toISOString() },
    ]);
  });
});
