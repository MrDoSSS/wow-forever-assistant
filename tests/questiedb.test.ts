import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ToolArgs, TOOL_NAMES, type ToolName } from '../bridge/src/contracts.js';
import { ToolChannelHub } from '../bridge/src/app/tool-channel.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { randomId, sha256Hex } from '../bridge/src/ids.js';
import { decodeCbor } from '../bridge/src/sources/questiedb/cbor.js';
import { decodeQuestieDataset } from '../bridge/src/sources/questiedb/decode.js';
import { QuestieSource } from '../bridge/src/sources/questiedb/tools.js';
import { QuestieDatasetManager, QUESTIEDB_RELEASE_URL } from '../bridge/src/sources/questiedb/update.js';
import { DatasetManager } from '../bridge/src/sources/forevermaster/update.js';
import { searchGameData } from '../bridge/src/sources/search.js';
import { getGameRecord } from '../bridge/src/sources/records.js';
import { findServices, type ServiceFilter } from '../bridge/src/sources/services.js';
import { Store } from '../bridge/src/storage/store.js';
import { AddonSession, ControlledModel, FakeClock, identity, tempDir } from './fakes.js';
import { cbor, questieFiles, questieZip } from './questiedb-fixture.js';
import { forevermasterZip, minimalData } from './zip-writer.js';

const metadata = { datasetId: 'a'.repeat(32), archiveSha256: 'b'.repeat(64), sourceUrl: 'https://github.com/Questie/QuestieDB/releases/download/v1.0.9/QuestieDB-Forever.zip' };
const importMeta = { sourceUrl: metadata.sourceUrl, releaseTag: 'v1.0.9', etag: '"release-9"', lastModified: null };
const who = { faction: 'alliance', zoneName: 'Stormwind City', uiMapId: 1453, x: 0.6, y: 0.7 };
function source() { return new QuestieSource(decodeQuestieDataset(questieFiles({ chunked: true }), metadata)); }
function environment(fetcher?: ConstructorParameters<typeof QuestieDatasetManager>[0]['fetcher']) {
  const dir = tempDir(), clock = new FakeClock(), diag = new MemoryDiagnostics(clock);
  const store = Store.open({ path: join(dir, 'assistant.sqlite'), clock });
  const options = { store, cacheDir: join(dir, 'cache'), clock, diag, fetcher };
  return { ...options, manager: new QuestieDatasetManager(options) };
}

describe('QuestieDB baked data', () => {
  it('decodes typed entities, chunked spawns, translations and positional scalar rows', () => {
    const reference = source();
    assert.deepEqual(reference.counts, { quest: 2, npc: 3, item: 1, object: 1 });
    assert.equal(reference.get('quest', 3)!.fields.requiredLevel, 12);
    assert.deepEqual(reference.get('quest', 2)!.fields.preQuestGroup, [10, 11]);
    assert.deepEqual(reference.get('quest', 2)!.fields.preQuestSingle, [20, 21]);
    assert.equal(reference.search('\u041f\u0440\u043e\u0441\u0442\u0430\u044f \u0434\u0440\u0435\u0432\u0435\u0441\u0438\u043d\u0430', []).hits[0]!.id, 4470);
    assert.equal(reference.search('8670', []).hits[0]!.name, 'Auctioneer Chilton');
    assert.equal(reference.search('a test quest', ['npc']).total, 0);
    assert.deepEqual(reference.locations(reference.get('object', 142075)!).map((p) => [p.uiMapId, p.x, p.y]), [[1429, 42.92, 65.52], [1453, 36.8, 69.17]]);
    assert.equal(reference.locations(reference.get('npc', 54)!).length, 2, 'dungeon and descendant coordinates are not reprojected');
  });

  it('filters services by faction, vendor item and zone and ranks same-map points', () => {
    const reference = source();
    assert.deepEqual(reference.findServices('auctioneer', null, null, who).services.map((s) => s.id), [8670]);
    assert.deepEqual(reference.findServices('auctioneer', null, null, { ...who, faction: 'horde' }).services.map((s) => s.id), [9856]);
    const vendors = reference.findServices('vendor', 4470, null, who);
    assert.deepEqual(vendors.services.map((s) => s.uiMapId), [1453, 1429]);
    assert.equal(vendors.services[0]!.distanceOnMap, Math.hypot(1, 2));
    assert.equal(vendors.services[1]!.distanceOnMap, null);
    assert.equal(reference.findServices('vendor', 99999, null, who).total, 0);
    assert.equal(reference.findServices('mailbox', null, 'Elwynn Forest', who).total, 1);
  });

  it('rejects corrupt CBOR, ambiguous keys, incomplete chunks and the wrong flavor', () => {
    for (const bytes of [Buffer.from([159, 255]), Buffer.from([130, 1]), Buffer.from([161, 1]), Buffer.from([162, 1, 1, 1, 2]), Buffer.concat([cbor(1), cbor(2)]), Buffer.from([27, 255, 255, 255, 255, 255, 255, 255, 255])]) {
      assert.throws(() => decodeCbor(bytes));
    }
    assert.throws(() => decodeCbor(cbor([[[1]]]), 2));
    for (const modify of [
      (toc: string) => toc.replace('X-Flavor: Forever', 'X-Flavor: Vanilla'),
      (toc: string) => toc.replace(/## X-Object-142075-4-2: .+/, ''),
      (toc: string) => `${toc}\n## Version: 1.0.9`,
      (toc: string) => toc.replace(/X-Npc-8670-S: .+/, 'X-Npc-8670-S: invalid!'),
    ]) {
      const files = questieFiles({ chunked: true });
      const path = 'QuestieDB/QuestieDB_Forever.toc';
      files.set(path, Buffer.from(modify(Buffer.from(files.get(path)!).toString())));
      assert.throws(() => decodeQuestieDataset(files, metadata));
    }
  });
});

describe('QuestieDB independent snapshots and updates', () => {
  it('discovers the latest Forever release, verifies digest, caches it and uses its release ETag', async () => {
    const zip = questieZip();
    const calls: { url: string; headers: RequestInit['headers'] }[] = [];
    let discovery = 0;
    const env = environment(async (url, init) => {
      calls.push({ url, headers: init.headers });
      if (url === QUESTIEDB_RELEASE_URL) {
        if (++discovery > 1) return new Response(null, { status: 304 });
        return Response.json({ tag_name: 'v1.0.9', draft: false, prerelease: false, assets: [{ name: 'QuestieDB-Forever.zip', browser_download_url: metadata.sourceUrl, digest: `sha256:${sha256Hex(zip)}` }] }, { headers: { etag: '"release-9"' } });
      }
      assert.equal(url, metadata.sourceUrl);
      return new Response(Buffer.from(zip));
    });
    try {
      assert.equal((await env.manager.checkForUpdate()).status, 'activated');
      const id = env.manager.source!.datasetId;
      assert.equal((await env.manager.checkForUpdate()).status, 'not_modified');
      assert.equal(calls.length, 3);
      assert.equal(new Headers(calls[2]!.headers).get('if-none-match'), '"release-9"');
      const restarted = new QuestieDatasetManager(env);
      assert.equal(restarted.loadActive(), true);
      assert.equal(restarted.source!.datasetId, id);
      assert.equal(restarted.source!.get('item', 4470)!.name, 'Simple Wood');
    } finally { env.store.close(); }
  });

  it('keeps ForeverMaster active and never replaces the working reference with a bad candidate', async () => {
    const env = environment();
    const master = new DatasetManager(env);
    try {
      assert.equal((await master.importArchive(forevermasterZip(minimalData()), { etag: null, lastModified: null })).status, 'activated');
      assert.equal((await env.manager.importArchive(questieZip(), importMeta)).status, 'activated');
      const pinned = env.manager.source!;
      assert.equal((await env.manager.importArchive(questieZip(), importMeta)).status, 'unchanged');
      assert.deepEqual(await env.manager.importArchive(questieZip(), { ...importMeta, releaseTag: 'v1.0.10' }), { status: 'error', code: 'version_mismatch' });
      assert.equal((await env.manager.importArchive(questieZip(), { ...importMeta, digest: `sha256:${'0'.repeat(64)}` })).status, 'error');
      const unsafe = questieZip({}, [{ name: 'QuestieDB/../escape', data: '' }]);
      assert.equal((await env.manager.importArchive(unsafe, importMeta)).status, 'rejected');
      assert.equal((await env.manager.importArchive(questieZip({ version: '1.0.10' }), importMeta)).status, 'rejected');
      assert.equal(env.manager.source!.datasetId, pinned.datasetId);
      assert.equal(env.store.getActiveDataset()!.dataset_id, master.source!.datasetId);
      assert.equal(env.store.getActiveDataset('questiedb')!.dataset_id, pinned.datasetId);
      const meta10 = { ...importMeta, releaseTag: 'v1.0.10', sourceUrl: metadata.sourceUrl.replace('1.0.9', '1.0.10') };
      assert.equal((await env.manager.importArchive(questieZip({ version: '1.0.10' }), meta10)).status, 'activated');
      assert.equal(env.store.getDataset(pinned.datasetId)!.status, 'retired');
      assert.equal(pinned.get('npc', 8670)!.name, 'Auctioneer Chilton', 'already pinned objects remain readable');
      assert.equal(env.store.getActiveDataset()!.dataset_id, master.source!.datasetId);
    } finally { env.store.close(); }
  });

  it('recovers a missing decoded cache without sending a stale validator', async () => {
    let discoveryHeaders: RequestInit['headers'];
    const env = environment(async (url, init) => {
      if (url === QUESTIEDB_RELEASE_URL) {
        discoveryHeaders = init.headers;
        return Response.json({ tag_name: 'v1.0.9', assets: [{ name: 'QuestieDB-Forever.zip', browser_download_url: metadata.sourceUrl }] });
      }
      return new Response(Buffer.from(questieZip()));
    });
    try {
      await env.manager.importArchive(questieZip(), importMeta);
      const id = env.manager.source!.datasetId;
      rmSync(join(env.manager.datasetDir(id), 'dataset.json'));
      const restarted = new QuestieDatasetManager(env);
      assert.equal(restarted.loadActive(), false);
      assert.equal((await restarted.checkForUpdate()).status, 'activated');
      assert.equal(new Headers(discoveryHeaders).get('if-none-match'), null);
      assert.equal(restarted.source!.datasetId, id);
    } finally { env.store.close(); }
  });

  it('handles unavailable releases, missing assets and concurrent checks without damaging the active data', async () => {
    for (const response of [new Response('', { status: 403 }), Response.json({ tag_name: 'v1.0.9', assets: [] }), Response.json({ tag_name: 'v1.0.9', assets: [{ name: 'QuestieDB-Forever.zip', browser_download_url: 'https://example.test/evil.zip' }] })]) {
      const env = environment(async () => response);
      try {
        await env.manager.importArchive(questieZip(), importMeta);
        const id = env.manager.source!.datasetId;
        assert.equal((await env.manager.checkForUpdate()).status, 'error');
        assert.equal(env.manager.source!.datasetId, id);
      } finally { env.store.close(); }
    }
    let release!: (response: Response) => void;
    const env = environment(() => new Promise((resolve) => { release = resolve; }));
    try {
      const pending = env.manager.checkForUpdate();
      assert.equal((await env.manager.checkForUpdate()).status, 'busy');
      const stopping = env.manager.stop();
      release(new Response('', { status: 404 }));
      await pending;
      await stopping;
    } finally { env.store.close(); }
  });
});

describe('QuestieDB model tools', () => {
  it('registers evidence, item refs and map refs, paginates and pins an attempt across updates', async () => {
    const env = environment();
    const model = new ControlledModel();
    const bridge = new Bridge({ ...env, adapter: model });
    try {
      assert.equal((await env.manager.importArchive(questieZip({ many: 24 }), importMeta)).status, 'activated');
      const addon = new AddonSession(identity());
      const { message, key } = addon.query('Where are the auction and mailbox?');
      assert.equal(bridge.receive(message).status, 'accepted');
      const input = model.last().input;
      input.query.snapshot.groups.position = { availability: 'available', coverage: 'complete', observedAtSessionMs: 1, reason: null, value: { mapKey: 'uiMap:1453', x: .6, y: .7, zoneName: 'Stormwind City' } };
      const hub = new ToolChannelHub({ ...env, datasets: { sourceFor: () => null }, questiedb: env.manager });
      const channel: Parameters<ToolChannelHub['handle']>[0] = {
        ctx: { ...input, request: key }, questie: env.manager.source, token: Buffer.alloc(32), server: createServer(), sockets: new Set(),
        cursors: new Map(), abort: new AbortController(), chain: Promise.resolve(),
      };
      const call = (tool: ToolName, args: unknown) => hub.handle(channel, randomId(), tool, ToolArgs[tool].parse(args));
      assert.equal(TOOL_NAMES.filter((name) => name.startsWith('search_')).length, 1);
      const searched = await call('search_game_data', { query: '4470', types: ['item'], cursor: null });
      assert.equal(searched.status, 'ok', 'search works when only QuestieDB is available');
      assert.equal((searched.data as { hits: { records: { source: string }[] }[] }).hits[0]!.records[0]!.source, 'questiedb');
      assert.ok(searched.limitations.includes('forevermaster_unavailable: results from this source are missing'));
      const searchFirst = await call('search_game_data', { query: 'Auctioneer', types: ['npc'], cursor: null });
      assert.ok(searchFirst.cursor);
      const searchSecond = await call('search_game_data', { query: 'Auctioneer', types: ['npc'], cursor: searchFirst.cursor });
      assert.equal((searchSecond.data as { hits: unknown[] }).hits.length, 6);
      assert.equal((await call('search_game_data', { query: 'Mailbox', types: ['object'], cursor: searchFirst.cursor })).status, 'error');
      const item = await call('get_game_record', { type: 'item', id: 4470, recordKey: null, fields: [] });
      assert.equal(item.status, 'ok');
      const itemData = item.data as { itemRefId: string; fields: { vendors: number[] } };
      assert.deepEqual(itemData.fields.vendors, [54]);
      assert.equal(env.store.getVerifiedRef(itemData.itemRefId)!.kind, 'item');
      assert.ok(env.store.isEvidenceLinked([input.attemptId], item.evidenceIds[0]!));
      const first = await call('find_services', { service: 'auctioneer', itemId: null, zoneName: null, forCharacter: null, profession: null, classToken: null, cursor: null });
      assert.equal(first.status, 'ok');
      assert.ok(first.cursor);
      const firstData = first.data as { services: { locationRefId: string }[]; total: number };
      assert.equal(firstData.total, 25);
      assert.equal(firstData.services.length, 20);
      const ref = env.store.getVerifiedRef(firstData.services[0]!.locationRefId)!;
      assert.equal(ref.kind, 'location');
      assert.equal(JSON.parse(ref.body_json).mapKey, 'uiMap:1453');
      const second = await call('find_services', { service: 'auctioneer', itemId: null, zoneName: null, forCharacter: null, profession: null, classToken: null, cursor: first.cursor });
      assert.equal((second.data as { services: unknown[] }).services.length, 5);
      const wrongCursor = await call('find_services', { service: 'mailbox', itemId: null, zoneName: null, forCharacter: null, profession: null, classToken: null, cursor: first.cursor });
      assert.equal(wrongCursor.status, 'error');
      const quest = await call('get_game_record', { type: 'quest', id: 2, recordKey: null, fields: ['preQuestGroup', 'preQuestSingle'] });
      assert.deepEqual((quest.data as { fields: unknown }).fields, { preQuestGroup: [10, 11], preQuestSingle: [20, 21] });
      const pinned = channel.questie!.datasetId;
      await env.manager.importArchive(questieZip({ version: '1.0.10' }), { ...importMeta, releaseTag: 'v1.0.10' });
      const status = await call('get_source_status', {});
      assert.equal((status.data as { questiedb: { datasetId: string } }).questiedb.datasetId, pinned);
      assert.notEqual(env.manager.source!.datasetId, pinned);
      assert.equal((await call('get_game_record', { type: 'npc', id: 99999, recordKey: null, fields: [] })).status, 'not_found');
      channel.questie = null;
      assert.equal((await call('search_game_data', { query: 'mailbox', types: [], cursor: null })).status, 'source_unavailable');
    } finally { await bridge.shutdown(); env.store.close(); }
  });
});

describe('unified reference search', () => {
  async function references(name = 'Wood Name A', many = 0) {
    const env = environment();
    const master = new DatasetManager(env);
    const data = minimalData({
      'Search.lua': `ForeverMasterData.names = [[2 A Test Quest\n${(4470 - 2).toString(36)} ${name}\n]]`,
      'Items.lua': 'ForeverMasterData.items = { [2]="c||Quest reward", [4470]="c|v|A changed item" }',
    });
    assert.equal((await master.importArchive(forevermasterZip(data), { etag: null, lastModified: null })).status, 'activated');
    const dataset = decodeQuestieDataset(questieFiles({ many }), metadata);
    dataset.entities.item['4471'] = { ...dataset.entities.item['4470']!, id: 4471 };
    return { ...env, master: master.source!, questie: new QuestieSource(dataset) };
  }

  it('groups the same item by ID while keeping conflicting source text and original fetch keys', async () => {
    const env = await references();
    try {
      const page = searchGameData(env.master, env.questie, '4470', []);
      assert.equal(page.hits.length, 1);
      const item = page.hits[0]!;
      assert.deepEqual([item.type, item.id, item.name], ['item', 4470, 'Wood Name A']);
      assert.equal(item.totalRecords, 3);
      assert.deepEqual(new Set(item.records.map((record) => record.source)), new Set(['forevermaster', 'questiedb']));
      assert.ok(item.records.some((record) => record.text === 'Simple Wood'));
      assert.ok(item.records.some((record) => record.text === 'Wood Name A'));
      const note = item.records.find((record) => record.type === 'items')!;
      assert.equal(env.master.getGameRecord(note.type as 'items', note.recordKey).status, 'ok');
      const sameName = searchGameData(env.master, env.questie, 'Simple Wood', ['item']);
      assert.deepEqual(sameName.hits.map((hit) => hit.id), [4470, 4471], 'equal names with different IDs stay separate');
      const sameId = searchGameData(env.master, env.questie, '2', []);
      assert.deepEqual(new Set(sameId.hits.filter((hit) => hit.id === 2).map((hit) => hit.type)), new Set(['item', 'quest']), 'different entity kinds never merge');
    } finally { env.store.close(); }
  });

  it('ranks both sources together, paginates without duplicates, and applies common type filters', async () => {
    const env = await references('Auctioneer', 24);
    try {
      const first = searchGameData(env.master, env.questie, 'Auctioneer', []);
      assert.deepEqual([first.hits[0]!.type, first.hits[0]!.id, first.hits[0]!.match], ['item', 4470, 'name']);
      assert.equal(first.hits.length, 20);
      assert.equal(first.total, 27);
      const second = searchGameData(env.master, env.questie, 'Auctioneer', [], first.nextOffset!);
      const hits = [...first.hits, ...second.hits];
      assert.equal(hits.length, first.total);
      assert.equal(new Set(hits.map((hit) => `${hit.type}/${hit.id}`)).size, hits.length);
      assert.equal(second.nextOffset, null);
      assert.ok(searchGameData(env.master, env.questie, 'Auctioneer', ['npc']).hits.every((hit) => hit.type === 'npc'));
      assert.equal(searchGameData(env.master, env.questie, '14293', ['recipe']).hits[0]!.id, 14293);
      assert.equal(searchGameData(env.master, env.questie, '198', ['npc']).hits[0]!.records[0]!.source, 'forevermaster');
      assert.equal(searchGameData(env.master, env.questie, '2', ['quest']).hits[0]!.records[0]!.source, 'questiedb');
      assert.equal(searchGameData(env.master, env.questie, '', []).total, 0);
    } finally { env.store.close(); }
  });

  it('returns partial results when a source is missing and reports unavailable types distinctly', async () => {
    const env = await references();
    try {
      const masterOnly = searchGameData(env.master, null, '4470', []);
      assert.equal(masterOnly.available, true);
      assert.equal(masterOnly.hits[0]!.records[0]!.source, 'forevermaster');
      assert.ok(masterOnly.limitations.some((limitation) => limitation.startsWith('questiedb_unavailable')));
      const questieOnly = searchGameData(null, env.questie, '2', ['quest']);
      assert.equal(questieOnly.available, true);
      assert.equal(questieOnly.limitations.length, 0, 'ForeverMaster is irrelevant to quest-only searches');
      assert.equal(searchGameData(null, env.questie, '14293', ['recipe']).available, false);
      assert.equal(searchGameData(null, null, '4470', []).available, false);
      assert.equal(ToolArgs.search_game_data.safeParse({ query: 'x', types: ['search'], cursor: null }).success, false, 'source-specific aliases are not search types');
    } finally { env.store.close(); }
  });

  it('fetches items, recipes, NPCs and sections with the same selector while retaining source conflicts', async () => {
    const env = await references();
    try {
      const item = getGameRecord(env.master, env.questie, { type: 'item', id: 4470, recordKey: null, fields: [] });
      assert.equal(item.found, true);
      assert.equal(item.facts.length, 2);
      assert.deepEqual(item.fields.vendors, [54]);
      assert.equal(item.fields.name, 'Wood Name A');
      assert.ok(item.conflicts.some(({ field }) => field === 'name'));
      const recipe = getGameRecord(env.master, env.questie, { type: 'recipe', id: 14293, recordKey: null, fields: ['learn'] });
      assert.deepEqual(recipe.fields, { learn: 10 });
      assert.deepEqual(recipe.recipe!.reagents, [{ itemId: 4470, count: 1 }, { itemId: 10938, count: 1 }]);
      const npc = getGameRecord(env.master, null, { type: 'npc', id: 198, recordKey: null, fields: [] });
      assert.equal(npc.found, true);
      assert.deepEqual(npc.fields.trainerGroups, [{ profession: null, classToken: 'MAGE' }]);
      assert.equal(npc.locations[0]!.uiMapId, 1429);
      const hit = searchGameData(env.master, env.questie, 'test', ['pack']).hits[0]!;
      assert.ok(hit.recordKey);
      const pack = getGameRecord(env.master, env.questie, { type: hit.type, id: hit.id, recordKey: hit.recordKey, fields: [] });
      assert.equal(pack.found, true);
      assert.equal(pack.fields.version, 'test');
      assert.equal(getGameRecord(env.master, null, { type: 'quest', id: 2, recordKey: null, fields: [] }).available, false);
      assert.equal(getGameRecord(null, env.questie, { type: 'item', id: 4470, recordKey: null, fields: [] }).found, true);
    } finally { env.store.close(); }
  });

  it('unifies trainers with services, retains specialization and coordinates, and filters known hostile NPCs', async () => {
    const env = await references();
    try {
      const dataset = env.questie.dataset;
      const addTrainer = (id: number, name: string, x: number) => {
        dataset.entities.npc[String(id)] = {
          type: 'npc', id, name, localizedNames: [],
          fields: { name, npcFlags: 16, friendlyToFaction: 'A', spawns: { '1519': [[x, 74.5]] } },
        };
      };
      addTrainer(1317, 'Lucan Cordell', 53);
      addTrainer(10001, 'Unclassified Trainer', 50);
      const questie = new QuestieSource(dataset);
      const filter: ServiceFilter = { service: 'trainer', itemId: null, zoneName: null, profession: 'Enchanting', classToken: null };
      const page = findServices(env.master, questie, filter, who);
      assert.equal(page.available, true);
      assert.equal(page.services.length, 1);
      const lucan = page.services[0]!;
      assert.equal(lucan.id, 1317);
      assert.deepEqual(lucan.trainerGroups, [{ profession: 'Enchanting', classToken: null }]);
      assert.deepEqual(new Set(lucan.sources.map(({ source }) => source)), new Set(['forevermaster', 'questiedb']));
      assert.deepEqual([lucan.x, lucan.y], [53, 74.5]);
      assert.deepEqual(lucan.alternateLocations.map(({ x, y }) => [x, y]), [[52.9, 74.4]]);
      assert.ok(page.limitations.some((limitation) => limitation.startsWith('other_faction_hidden')));
      assert.ok(page.limitations.some((limitation) => limitation.startsWith('coordinate_variants')));
      assert.ok(findServices(env.master, questie, { ...filter, profession: null }, who).services.some(({ id }) => id === 10001));
      assert.deepEqual(findServices(env.master, null, { ...filter, profession: null, classToken: 'mage' }, who).services.map(({ id }) => id), [198]);
      assert.equal(findServices(env.master, null, filter, who).services[0]!.id, 1317, 'specialized services work without QuestieDB');
      assert.equal(findServices(null, questie, filter, who).available, false, 'a generic trainer flag does not establish a profession');
      assert.equal(findServices(env.master, questie, { ...filter, zoneName: 'Elwynn Forest' }, who).services.length, 0);
      assert.equal(ToolArgs.find_services.safeParse({ ...filter, service: 'auctioneer', forCharacter: null, cursor: null }).success, false);
      assert.equal(ToolArgs.get_game_record.safeParse({ type: 'item', id: null, recordKey: 'items/4470', fields: [] }).success, false);
    } finally { env.store.close(); }
  });

  it('issues usable item and complete recipe refs through the common getter and leaves live tools separate', async () => {
    const env = await references();
    const model = new ControlledModel();
    const bridge = new Bridge({ ...env, adapter: model, datasetId: () => env.master.datasetId });
    try {
      assert.equal((await env.manager.importArchive(questieZip(), importMeta)).status, 'activated');
      const addon = new AddonSession(identity());
      const { message, key } = addon.query('Craft a wand');
      assert.equal(bridge.receive(message).status, 'accepted');
      const input = model.last().input;
      input.query.snapshot.groups.position = { availability: 'available', coverage: 'complete', observedAtSessionMs: 1, reason: null, value: { mapKey: 'uiMap:1453', x: .6, y: .7, zoneName: 'Stormwind City' } };
      const hub = new ToolChannelHub({ ...env, datasets: { sourceFor: () => env.master } });
      const channel: Parameters<ToolChannelHub['handle']>[0] = {
        ctx: { ...input, request: key }, questie: env.manager.source, token: Buffer.alloc(32), server: createServer(), sockets: new Set(),
        cursors: new Map(), abort: new AbortController(), chain: Promise.resolve(),
      };
      const call = (tool: ToolName, args: unknown) => hub.handle(channel, randomId(), tool, ToolArgs[tool].parse(args));
      const recipe = await call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: ['learn'] });
      assert.equal(recipe.status, 'ok');
      const data = recipe.data as { recipeRefId: string; fields: unknown };
      assert.deepEqual(data.fields, { learn: 10 });
      const calculation = await call('calculate_craft', { recipeRefId: data.recipeRefId, desiredQuantity: 3, inventoryScope: 'none' });
      assert.equal(calculation.status, 'ok');
      assert.deepEqual((calculation.data as { lines: { needed: number }[] }).lines.map(({ needed }) => needed), [3, 3]);
      const item = await call('get_game_record', { type: 'item', id: 4470, recordKey: null, fields: [] });
      const itemData = item.data as { itemRefId: string; sources: unknown[] };
      assert.equal(itemData.sources.length, 2);
      assert.equal(env.store.getVerifiedRef(itemData.itemRefId)!.kind, 'item');
      const services = await call('find_services', { service: 'trainer', profession: 'Enchanting', classToken: null, itemId: null, zoneName: null, forCharacter: null, cursor: null });
      assert.equal(services.status, 'ok');
      const lucan = (services.data as { services: { id: number; locationRefId: string }[] }).services.find(({ id }) => id === 1317)!;
      const point = env.store.getVerifiedRef(lucan.locationRefId)!;
      assert.equal(JSON.parse(point.body_json).mapKey, 'uiMap:1453');
      assert.equal((await call('find_services', { service: 'trainer', profession: null, classToken: null, itemId: null, zoneName: null, forCharacter: 'Nobody', cursor: null })).status, 'not_found');
      assert.ok(TOOL_NAMES.includes('lookup_prices') && TOOL_NAMES.includes('lookup_items'));
      assert.deepEqual(TOOL_NAMES.filter((name) => name.startsWith('get_') && !['get_source_status', 'get_alts'].includes(name)), ['get_game_record']);
      channel.questie = null;
      assert.equal((await call('get_game_record', { type: 'item', id: 4470, recordKey: null, fields: [] })).status, 'ok');
    } finally { await bridge.shutdown(); env.store.close(); }
  });
});
