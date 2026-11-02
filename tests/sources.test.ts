import assert from 'node:assert/strict';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { sha256Hex } from '../bridge/src/ids.js';
import { Store } from '../bridge/src/storage/store.js';
import { readArchive, ARCHIVE_LIMITS } from '../bridge/src/sources/forevermaster/archive.js';
import { decodeNames, decodeRecipe } from '../bridge/src/sources/forevermaster/decode.js';
import { decodeLuaString, parseDataFile } from '../bridge/src/sources/forevermaster/parse.js';
import { normalizeText } from '../bridge/src/sources/forevermaster/search.js';
import { DatasetManager, datasetIdOf, type DatasetManagerOptions } from '../bridge/src/sources/forevermaster/update.js';
import { PARSER_LIMITS } from '../bridge/src/sources/forevermaster/parse.js';
import type { Fetcher } from '../bridge/src/sources/web.js';
import { FakeClock, tempDir } from './fakes.js';
import { syntheticForeverMasterArchive } from './forevermaster-fixture.js';
import { forevermasterZip, makeZip, minimalData, recipesLua, TOC } from './zip-writer.js';

const SYNTHETIC_ARCHIVE = syntheticForeverMasterArchive();
const bytes = (text: string) => new TextEncoder().encode(text);

function manager(options: Partial<DatasetManagerOptions> = {}) {
  const dir = tempDir();
  const clock = new FakeClock();
  const store = options.store ?? Store.open({ path: join(dir, 'assistant.sqlite'), clock });
  const diag = new MemoryDiagnostics(clock);
  const m = new DatasetManager({ store, cacheDir: options.cacheDir ?? join(dir, 'cache'), clock, diag, ...options });
  return { m, store, dir, diag };
}

const noNetwork: Fetcher = () => Promise.reject(new Error('network is not used in tests'));

describe('synthetic ForeverMaster format archive', () => {
  const ctx = manager({ fetcher: noNetwork });

  before(async () => {
    const result = await ctx.m.importArchive(SYNTHETIC_ARCHIVE, { etag: '"synthetic-v1"', lastModified: null });
    assert.equal(result.status, 'activated', JSON.stringify(result));
  });

  it('imports compressed data files with metadata, names and no skipped records', () => {
    const d = ctx.m.source!.dataset;
    assert.equal(Object.keys(d.recipes).length, 5);
    assert.equal(d.trainers.length, 105);
    assert.equal(new Set(d.trainers.map((t) => t.npcId)).size, 105);
    assert.equal(Object.keys(d.names).length, 114);
    assert.equal(d.names['118'], 'Minor Healing Potion');
    assert.equal(d.names['159'], 'Refreshing Spring Water');
    assert.equal(d.names['11287'], 'Lesser Magic Wand');
    assert.equal(new Set(Object.values(d.recipes).map((r) => r.profession)).size, 3);
    assert.deepEqual(d.pack, { version: 'synthetic-v1', build: '0.0.0.1', hash: 'synthetic', site: 'https://example.test/forevermaster' });
    assert.equal(d.addonVersion, '9.9.9');
    assert.equal(d.skippedCount, 0);
    assert.equal(d.archiveSha256, sha256Hex(SYNTHETIC_ARCHIVE));
    assert.equal(ctx.m.source!.datasetId, datasetIdOf(sha256Hex(SYNTHETIC_ARCHIVE)));
    assert.deepEqual(syntheticForeverMasterArchive(), SYNTHETIC_ARCHIVE);
  });

  it('decodes recipe 14293 and keeps enchantments without an output item', () => {
    const recipe = ctx.m.source!.getRecipe(14293);
    assert.equal(recipe.status, 'ok');
    assert.deepEqual(
      { ...recipe.data, limitations: undefined },
      {
        spellId: 14293,
        profession: 'Enchanting',
        learn: 10,
        yellow: 75,
        green: 95,
        grey: 115,
        greenDerived: true,
        outputItemId: 11287,
        outputCount: 1,
        taughtByItemId: null,
        status: null,
        reagents: [
          { itemId: 4470, count: 1 },
          { itemId: 10938, count: 1 },
        ],
        limitations: undefined,
      },
    );
    assert.ok(recipe.limitations.some((l) => l.startsWith('green_derived')));
    const effects = Object.values(ctx.m.source!.dataset.recipes).filter((r) => r.outputItemId === null);
    assert.equal(effects.length, 1);
    assert.ok(effects.every((r) => r.profession === 'Enchanting'));
  });

  it('decodes trainers as candidates with 0..1 coordinates', () => {
    const found = ctx.m.source!.findTrainers('enchanting', null);
    const lucan = found.data!.find((t) => t.npcId === 1317)!;
    assert.deepEqual(
      { name: lucan.name, faction: lucan.faction, uiMapId: lucan.uiMapId, x: lucan.x, y: lucan.y, profession: lucan.profession },
      { name: 'Lucan Cordell', faction: 'alliance', uiMapId: 1453, x: 0.529, y: 0.744, profession: 'Enchanting' },
    );
    assert.ok(found.limitations.some((l) => l.startsWith('trainer_is_candidate')));
    const all = ctx.m.source!.findTrainers(null, null);
    assert.equal(all.data!.length, 100);
    assert.equal(all.nextOffset, 100);
    const next = ctx.m.source!.findTrainers(null, null, null, all.nextOffset!);
    assert.equal(next.data!.length, 5);
    assert.equal(next.nextOffset, null);
    assert.equal(new Set([...all.data!, ...next.data!].map((t) => t.npcId)).size, 105);
    const druids = ctx.m.source!.findTrainers(null, 'DRUID');
    assert.equal(druids.data!.length, 100);
    assert.equal(druids.data!.every((t) => t.classToken === 'DRUID'), true);
  });

  it('hides trainers of the other faction and keeps neutral ones', () => {
    const horde = ctx.m.source!.findTrainers('Enchanting', null, 'horde');
    assert.equal(horde.data!.length, 1);
    assert.ok(horde.data!.every((t) => t.faction !== 'alliance'));
    assert.ok(horde.data!.some((t) => t.name === 'Synthetic Horde Trainer' && t.uiMapId === 1420));
    assert.ok(horde.limitations.includes('other_faction_hidden: 2 trainers of the other faction are omitted'));
    const engineering = ctx.m.source!.findTrainers('Engineering', null, 'alliance');
    assert.ok(engineering.data!.some((t) => t.faction === 'unknown'));
    assert.equal(ctx.m.source!.findTrainers('Enchanting', null, null).data!.length, 3);
  });

  it('links items to recipes by output, reagent and recipe item', () => {
    const wand = ctx.m.source!.getItem(11287);
    assert.equal(wand.data!.name, 'Lesser Magic Wand');
    assert.ok(wand.data!.recipeSpellIds.produces.includes(14293));
    const essence = ctx.m.source!.getItem(10938);
    assert.ok(essence.data!.recipeSpellIds.reagentFor.includes(14293));
    assert.deepEqual(ctx.m.source!.getItem(4345).data!.recipeSpellIds.taughtBy, [3915]);
    assert.equal(ctx.m.source!.getItem(2147483646).status, 'not_found');
    const unnamed = ctx.m.source!.getItem(900002);
    assert.equal(unnamed.status, 'ok');
    assert.equal(unnamed.data!.name, null);
    assert.deepEqual(unnamed.data!.recipeSpellIds.produces, [900001]);
  });

  it('searches by exact ID, exact name, prefix and substring', () => {
    const s = ctx.m.source!;
    const byId = s.searchGameData('11287', []);
    assert.equal(byId.data!.hits[0]!.match, 'id');
    assert.ok(byId.data!.hits.some((h) => h.type === 'search' && h.recordKey === '11287'));
    const byName = s.searchGameData('  LESSER   magic wand ', ['search', 'recipes']);
    assert.equal(byName.data!.hits[0]!.match, 'name');
    assert.deepEqual(
      byName.data!.hits.filter((h) => h.match === 'name').map((h) => `${h.type}/${h.recordKey}`),
      ['recipes/14293', 'search/11287'],
    );
    const prefix = s.searchGameData('lesser magic', ['search']);
    assert.ok(prefix.data!.hits.every((h, i, all) => i === 0 || ['name', 'prefix', 'substring'].indexOf(h.match) >= ['name', 'prefix', 'substring'].indexOf(all[i - 1]!.match)));
    const many = s.searchGameData('a', ['search']);
    assert.equal(many.data!.hits.length, 100);
    assert.notEqual(many.nextOffset, null);
    const next = s.searchGameData('a', ['search'], many.nextOffset!);
    assert.notEqual(next.data!.hits[0]!.recordKey, many.data!.hits[0]!.recordKey);
    const none = s.searchGameData('nonexistent name', []);
    assert.equal(none.data!.hits.length, 0);
    assert.ok(none.limitations[0]!.startsWith('no_match'));
    assert.equal(normalizeText(' \u0401\u043b\u043a\u0430  \u0401\u0416 '), '\u0435\u043b\u043a\u0430 \u0435\u0436');
  });

  it('returns raw literal records for other data sets with provenance', () => {
    const s = ctx.m.source!;
    const items = s.getGameRecord('items', 'items/118');
    assert.equal(items.data!.fields, '|test|Synthetic item note');
    assert.equal(items.data!.sourcePath, 'Data/Items.lua#items["118"]');
    const leveling = s.getGameRecord('leveling', 'leveling/Alchemy');
    assert.equal(leveling.status, 'ok');
    assert.equal((leveling.data!.fields as Record<string, unknown>).slug, 'alchemy');
    assert.ok(s.getGameRecord('leveling', 'leveling/ids').data);
    const status = s.status().data!;
    assert.equal(status.files['Prices.lua']!.status, 'decoded');
    assert.equal(status.files['Recipes.lua']!.status, 'decoded');
    for (const [type, key] of [
      ['dungeons', 'dungeons/1'], ['journal', 'maps/synthetic-dungeon'],
      ['professions', 'professions/Enchanting'], ['training', 'training/MAGE'],
      ['talents', 'talents/MAGE'], ['bis', 'bis/MAGE'], ['rewards', 'reputation/items'],
    ] as const) {
      const result = s.getGameRecord(type, key);
      assert.equal(result.status, 'ok', `${type}/${key}`);
      assert.ok(result.data!.sourcePath.startsWith('Data/'));
      assert.deepEqual(result.limitations, ['raw_literal']);
    }
    assert.equal(Object.keys(status.files).length, 14);
    assert.ok(Object.values(status.files).every((file) => file.status === 'decoded'));
  });

  it('reopens the active dataset from disk and treats the same archive as unchanged', async () => {
    const reopened = new DatasetManager({ store: ctx.store, cacheDir: join(ctx.dir, 'cache'), clock: new FakeClock(), diag: ctx.diag });
    assert.equal(reopened.loadActive(), true);
    assert.equal(Object.keys(reopened.source!.dataset.recipes).length, 5);
    assert.equal((await ctx.m.importArchive(SYNTHETIC_ARCHIVE, { etag: null, lastModified: null })).status, 'unchanged');
  });

  it('keeps the working dataset when a new candidate is rejected', async () => {
    const before = ctx.m.source!.datasetId;
    const broken = forevermasterZip(minimalData({ 'Recipes.lua': null }));
    const result = await ctx.m.importArchive(broken, { etag: null, lastModified: null });
    assert.deepEqual(result.status === 'rejected' && result.code, 'required_file_missing');
    assert.equal(ctx.m.source!.datasetId, before);
    assert.equal(ctx.store.getActiveDataset()!.dataset_id, before);
    // Do not parse the same rejected archive again.
    assert.equal((await ctx.m.importArchive(broken, { etag: null, lastModified: null })).status, 'rejected');
  });

  it('keeps a pinned older dataset readable after an update', async () => {
    const old = ctx.m.source!.datasetId;
    const result = await ctx.m.importArchive(forevermasterZip(minimalData()), { etag: null, lastModified: null });
    assert.equal(result.status, 'activated');
    assert.notEqual(ctx.m.source!.datasetId, old);
    assert.equal(ctx.m.sourceFor(old)!.getRecipe(14293).status, 'ok');
    assert.equal(ctx.store.getDataset(old)!.status, 'retired');
  });
});

describe('update over HTTP', () => {
  function fetcherFor(responses: (() => Response)[]) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next();
    };
    return { fetcher, calls };
  }

  it('downloads, then asks with If-None-Match and accepts 304', async () => {
    const archive = forevermasterZip(minimalData());
    const { fetcher, calls } = fetcherFor([
      () => new Response(archive as unknown as BodyInit, { status: 200, headers: { etag: '"v1"', 'last-modified': 'Mon, 26 Oct 2026 11:28:03 GMT' } }),
      () => new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    ]);
    const { m } = manager({ fetcher });
    assert.equal((await m.checkForUpdate()).status, 'activated');
    assert.equal((await m.checkForUpdate()).status, 'not_modified');
    assert.equal(calls[1]!.headers['If-None-Match'], '"v1"');
  });

  it('does not retry 4xx, retries 5xx once and keeps the dataset on errors', async () => {
    const notFound = fetcherFor([() => new Response('no', { status: 404 })]);
    const a = manager({ fetcher: notFound.fetcher });
    assert.deepEqual(await a.m.checkForUpdate(), { status: 'error', code: 'http_status:404' });
    assert.equal(notFound.calls.length, 1);
    const flaky = fetcherFor([() => new Response('x', { status: 503 }), () => new Response('x', { status: 503 })]);
    const b = manager({ fetcher: flaky.fetcher });
    assert.deepEqual(await b.m.checkForUpdate(), { status: 'error', code: 'http_status:503' });
    assert.equal(flaky.calls.length, 2);
    assert.equal(b.m.source, null);
  });

  it('rejects an archive over the size limit while downloading', async () => {
    const big = new Uint8Array(2048);
    const { fetcher } = fetcherFor([() => new Response(big as unknown as BodyInit, { status: 200 })]);
    const { m } = manager({ fetcher, archiveLimits: { ...ARCHIVE_LIMITS, archiveBytes: 1024 } });
    assert.deepEqual(await m.checkForUpdate(), { status: 'error', code: 'too_large' });
  });
});

describe('archive safety', () => {
  const data = minimalData();
  const cases: [string, Uint8Array][] = [
    ['parent path', forevermasterZip(data, [{ name: 'ForeverMaster/../evil.lua', data: 'x' }])],
    ['absolute path', forevermasterZip(data, [{ name: '/etc/evil.lua', data: 'x' }])],
    ['case duplicate', forevermasterZip(data, [{ name: 'ForeverMaster/Data/pack.lua', data: 'x' }])],
    ['encrypted', forevermasterZip(data, [{ name: 'ForeverMaster/Media/a.tga', data: 'x', flags: 1 }])],
    ['symlink', forevermasterZip(data, [{ name: 'ForeverMaster/link', data: '/etc/passwd', unixMode: 0o120777 }])],
    ['outside root', forevermasterZip(data, [{ name: 'Other/file.lua', data: 'x' }])],
    ['bad crc', makeZip([
      { name: 'ForeverMaster/ForeverMaster.toc', data: TOC },
      { name: 'ForeverMaster/Data/Recipes.lua', data: data['Recipes.lua']!, crc: 12345 },
    ])],
  ];
  for (const [name, archive] of cases) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(readArchive(archive));
    });
  }

  it('enforces entry count and file size limits', async () => {
    const archive = forevermasterZip(data);
    await assert.rejects(readArchive(archive, { ...ARCHIVE_LIMITS, entries: 3 }), /entries/);
    await assert.rejects(readArchive(archive, { ...ARCHIVE_LIMITS, fileBytes: 64 }), /too large/);
  });

  it('reads only Data/*.lua and the TOC', async () => {
    const archive = forevermasterZip(data, [{ name: 'ForeverMaster/UI/Pages/Recipes.lua', data: 'print(1)' }]);
    const contents = await readArchive(archive);
    assert.deepEqual([...contents.dataFiles.keys()].sort(), ['Pack.lua', 'Recipes.lua', 'Search.lua', 'Trainers.lua']);
    assert.equal(Buffer.from(contents.toc).toString(), TOC);
  });
});

describe('static Lua parsing', () => {
  const parse = (text: string) => parseDataFile(bytes(text));

  it('decodes Lua 5.1 strings byte-exactly and validates UTF-8 afterwards', () => {
    assert.equal(Buffer.from(decodeLuaString('"\\208\\175 \\n\\"q\\\\"')).toString('utf8'), '\u042f \n"q\\');
    assert.equal(Buffer.from(decodeLuaString("'a\\'b'")).toString(), "a'b");
    assert.equal(Buffer.from(decodeLuaString('[==[\nlong]] x]==]')).toString(), 'long]] x');
    assert.deepEqual([...decodeLuaString('"\\0012"')], [1, 50]);
    const result = parse('ForeverMasterData.items = { [1] = "\\255\\254", [2] = "\u043e\u043a" }');
    assert.deepEqual({ ...(result.assignments[0]!.value as object) }, { '2': '\u043e\u043a' });
    assert.deepEqual(result.skips, [{ path: 'items["1"]', reason: 'invalid_utf8' }]);
  });

  it('accepts only literal assignments to ForeverMasterData paths', () => {
    assert.deepEqual(parse('ForeverMasterData = ForeverMasterData or {}\nForeverMasterData.a = { -1, 2.5, true, "x" }').assignments, [
      { path: ['a'], value: [-1, 2.5, true, 'x'] },
    ]);
    for (const source of [
      'print("x")',
      'ForeverMasterData.a = os.time()',
      'ForeverMasterData.a = function() end',
      'local t = {}',
      'ForeverMasterData.a = 1 + 2',
      'ForeverMasterData.a = { x = y }',
      'Other.a = {}',
      'ForeverMasterData = {}',
      'for i = 1, 2 do end',
    ]) {
      assert.throws(() => parse(source), (e: Error & { code?: string }) => e.code === 'forbidden_construct', source);
    }
  });

  it('skips duplicate keys and mixed tables as records, nil fields are absent', () => {
    const result = parse('ForeverMasterData.a = { x = 1, x = 2, y = { 1, k = 2 }, z = 3, n = nil }');
    assert.deepEqual({ ...(result.assignments[0]!.value as object) }, { z: 3 });
    assert.deepEqual(result.skips.map((s) => s.reason).sort(), ['duplicate_key', 'mixed_table']);
  });

  it('stops on AST node and depth limits', () => {
    assert.throws(() => parseDataFile(bytes('ForeverMasterData.a = { 1, 2, 3, 4, 5, 6 }'), { maxDepth: 64, maxNodes: 5 }), /AST/);
    assert.throws(() => parseDataFile(bytes('ForeverMasterData.a = { { { { 1 } } } }'), { maxDepth: 3, maxNodes: 1000 }), /depth/);
  });

  it('decodes recipe lines by the 9-field rule', () => {
    const recipe = decodeRecipe('Tailoring', '3915', '10|45||70|4307|2|4345|n|2996,2320:2,2996');
    assert.ok(typeof recipe !== 'string');
    assert.deepEqual(recipe.reagents, [
      { itemId: 2996, count: 2 },
      { itemId: 2320, count: 2 },
    ]);
    assert.equal(recipe.outputCount, 2);
    assert.equal(recipe.taughtByItemId, 4345);
    assert.equal(recipe.status, 'new');
    assert.equal(recipe.green, 57);
    assert.equal(decodeRecipe('X', '1', '1|2|3|4|5|6|7|n'), 'field_count');
    assert.equal(decodeRecipe('X', '1', '1|2|3|4|5|0|7||8'), 'bad_count');
    assert.equal(decodeRecipe('X', '1', '1|2|3|4|5||7||8:x'), 'bad_reagent');
    const unknown = decodeRecipe('X', '1', '|||||||z|8');
    assert.ok(typeof unknown !== 'string' && unknown.limitations[0] === 'unknown_status:z' && unknown.green === null);
  });

  it('decodes Search names as base36 increments from 0', () => {
    const decoded = decodeNames('3a Minor Healing Potion\n15 Refreshing Spring Water\n-1 not an increment\n');
    assert.deepEqual({ ...decoded.names }, { '118': 'Minor Healing Potion', '159': 'Refreshing Spring Water' });
    assert.equal(decoded.skipped, 1);
  });
});

describe('candidate decoding rules', () => {
  const importData = async (data: Record<string, string>, options: Partial<DatasetManagerOptions> = {}) => {
    const { m } = manager(options);
    return { result: await m.importArchive(forevermasterZip(data), { etag: null, lastModified: null }), m };
  };

  it('skips one bad recipe line and keeps the rest', async () => {
    const { result, m } = await importData(
      minimalData({
        'Recipes.lua': recipesLua({
          Enchanting: { '1': '1|2||4|5||||10', '2': '1|2||4|6||||10', '3': '1|2||4|7||||10', '4': '1|2||4|8||||10', '5': 'broken' },
        }),
      }),
    );
    assert.equal(result.status, 'activated');
    assert.equal(Object.keys(m.source!.dataset.recipes).length, 4);
    assert.equal(m.source!.status().data!.skippedCount, 1);
  });

  it('rejects a candidate with more than 25% bad recipes', async () => {
    const { result } = await importData(
      minimalData({ 'Recipes.lua': recipesLua({ Enchanting: { '1': '1|2||4|5||||10', '2': 'bad', '3': 'bad|x' } }) }),
    );
    assert.deepEqual(result.status === 'rejected' && result.code, 'too_many_skipped');
  });

  it('skips an optional file with a forbidden construct but rejects a required one', async () => {
    const optional = await importData(minimalData({ 'Items.lua': 'ForeverMasterData.items = loadstring("x")()' }));
    assert.equal(optional.result.status, 'activated');
    assert.deepEqual(optional.m.source!.status().data!.files['Items.lua'], { status: 'skipped_file', reason: 'forbidden_construct' });
    const required = await importData(minimalData({ 'Trainers.lua': 'ForeverMasterData.trainers = setmetatable({}, {})' }));
    assert.deepEqual(required.result.status === 'rejected' && required.result.code, 'required_file_invalid');
  });

  it('keeps a trainer with invalid coordinates without a point', async () => {
    const { m } = await importData(minimalData());
    const taladan = m.source!.dataset.trainers.find((t) => t.npcId === 4213)!;
    assert.deepEqual([taladan.x, taladan.y, taladan.faction, taladan.limitations], [null, null, 'horde', ['invalid_coordinates']]);
  });

  it('rejects a candidate that breaks the AST or time limits', async () => {
    const ast = await importData(minimalData(), { parserLimits: { ...PARSER_LIMITS, maxNodes: 10 } });
    assert.deepEqual(ast.result.status === 'rejected' && ast.result.code, 'ast_limit');
    const time = await importData(minimalData(), { parserLimits: { ...PARSER_LIMITS, timeoutMs: 1 } });
    assert.deepEqual(time.result.status === 'rejected' && time.result.code, 'time_limit');
  });

  it('rejects unsafe archives as candidates', async () => {
    const { m } = manager();
    const unsafe = makeZip([
      { name: 'ForeverMaster/ForeverMaster.toc', data: TOC },
      { name: 'ForeverMaster/../x.lua', data: 'x' },
    ]);
    const result = await m.importArchive(unsafe, { etag: null, lastModified: null });
    assert.equal(result.status, 'rejected');
    assert.equal(m.source, null);
  });
});
