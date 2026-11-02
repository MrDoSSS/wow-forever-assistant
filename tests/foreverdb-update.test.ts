import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { sha256Hex } from '../bridge/src/ids.js';
import { Store } from '../bridge/src/storage/store.js';
import { DatasetManager, FOREVERDB_MANIFEST_URL, FOREVERDB_URL } from '../bridge/src/sources/foreverdb/update.js';
import type { Fetcher } from '../bridge/src/sources/web.js';
import { FakeClock, tempDir } from './fakes.js';
import { foreverdbZip } from './foreverdb-update-fixture.js';

const metadata = { etag: null, lastModified: null };
function environment(fetcher?: Fetcher) {
  const dir = tempDir(), clock = new FakeClock(), diag = new MemoryDiagnostics(clock);
  const store = Store.open({ path: join(dir, 'assistant.sqlite'), clock });
  const options = { store, cacheDir: join(dir, 'cache'), clock, diag, fetcher };
  return { ...options, dir, manager: new DatasetManager(options) };
}
function manifest(archive: Uint8Array, extra = {}) {
  return { version: '0.54.8', sha256: sha256Hex(archive), bytes: archive.byteLength, file: 'downloads/ForeverDB.zip', folders: ['ForeverDB', 'ForeverDB_Helper'], ...extra };
}

describe('ForeverDB automatic snapshots', () => {
  it('does not resolve datasets owned by another reference source', async () => {
    const env = environment();
    try {
      const id = 'a'.repeat(32);
      env.store.upsertCandidateDataset({ sourceKind: 'questiedb', datasetId: id, archiveSha256: 'b'.repeat(64), decoderVersion: 1,
        sourceUrl: 'https://example.test/retired', archivePath: 'unused', indexPath: 'unused', etag: null, lastModified: null, now: env.clock.now() });
      assert.equal(env.manager.sourceFor(id), null);
      assert.equal(env.manager.source, null);
    } finally { await env.manager.stop(); env.store.close(); }
  });
  it('discovers the official bundle, checks its digest and caches it with preserved notices', async () => {
    const archive = foreverdbZip(), calls: string[] = [];
    let manifestHeaders: Headers | null = null;
    const env = environment(async (url, init) => {
      calls.push(url);
      if (url === FOREVERDB_MANIFEST_URL) {
        manifestHeaders = new Headers(init.headers);
        return manifestHeaders.has('if-none-match') ? new Response(null, { status: 304 })
          : Response.json(manifest(archive), { headers: { ETag: '"manifest-1"' } });
      }
      assert.equal(url, `${FOREVERDB_URL}?v=${sha256Hex(archive).slice(0, 10)}`);
      return new Response(Buffer.from(archive));
    });
    try {
      assert.equal((await env.manager.checkForUpdate()).status, 'activated');
      const source = env.manager.source!, id = source.datasetId;
      assert.equal(source.dataset.addonVersion, '0.54.8');
      assert.equal(source.getRecipe(14293).data!.outputItemId, 11287);
      assert.equal(env.store.getActiveDataset('foreverdb')!.dataset_id, id);
      assert.equal(env.store.getActiveDataset()!.dataset_id, id);
      assert.equal(env.store.getActiveDataset('questiedb'), undefined, 'does not activate another reference source');
      assert.ok(readFileSync(join(env.manager.datasetDir(id), 'ForeverDB', 'NOTICE.txt'), 'utf8').includes('ForeverDB.net'));
      assert.ok(existsSync(join(env.manager.datasetDir(id), 'ForeverDB_Helper', 'LICENSE.txt')));
      assert.equal((await env.manager.checkForUpdate()).status, 'not_modified');
      assert.equal(manifestHeaders!.get('if-none-match'), '"manifest-1"');
      assert.equal(calls.filter((url) => url.startsWith(FOREVERDB_URL)).length, 1);
      const restarted = new DatasetManager(env);
      assert.equal(restarted.loadActive(), true);
      assert.equal(restarted.source!.datasetId, id);
    } finally { await env.manager.stop(); env.store.close(); }
  });

  it('rejects unsafe URLs, corrupt downloads and mismatched versions without replacing the working snapshot', async () => {
    const archive = foreverdbZip();
    for (const extra of [{ file: 'https://example.test/evil.zip' }, { sha256: '0'.repeat(64) }, { bytes: archive.byteLength + 1 }, { version: '0.54.9' }]) {
      const env = environment(async (url) => url === FOREVERDB_MANIFEST_URL ? Response.json(manifest(archive, extra)) : new Response(Buffer.from(archive)));
      try {
        assert.equal((await env.manager.importArchive(archive, metadata)).status, 'activated');
        const id = env.manager.source!.datasetId;
        const result = await env.manager.checkForUpdate();
        assert.equal(result.status, 'error');
        assert.equal(env.manager.source!.datasetId, id);
        assert.equal(env.store.getActiveDataset('foreverdb')!.dataset_id, id);
      } finally { await env.manager.stop(); env.store.close(); }
    }
  });

  it('keeps pinned older sources across upgrades and restarts', async () => {
    const env = environment();
    try {
      assert.equal((await env.manager.importArchive(foreverdbZip(), metadata)).status, 'activated');
      const original = env.manager.source!, oldId = original.datasetId;
      assert.equal((await env.manager.importArchive(foreverdbZip({ version: '0.54.9', name: 'Updated Wand' }), metadata)).status, 'activated');
      assert.notEqual(env.manager.source!.datasetId, oldId);
      assert.equal(env.store.getDataset(oldId)!.status, 'retired');
      assert.equal(env.manager.sourceFor(oldId), original);
      const restarted = new DatasetManager(env);
      assert.equal(restarted.loadActive(), true);
      assert.equal(restarted.sourceFor(oldId)!.getRecipe(14293).data!.outputItemId, 11287);
    } finally { await env.manager.stop(); env.store.close(); }
  });

  it('retains the working cache when a candidate is unsafe or missing required attribution/data', async () => {
    const env = environment();
    try {
      await env.manager.importArchive(foreverdbZip(), metadata);
      const id = env.manager.source!.datasetId;
      for (const archive of [
        foreverdbZip({}, [{ name: 'ForeverDB/../escape', data: '' }]),
        foreverdbZip({ overrides: { 'ForeverDB/NOTICE.txt': null } }),
        foreverdbZip({ overrides: { 'ForeverDB/Data/Recipes.lua': 'local _, ns = ...; ns.recipes = os.execute("bad")' } }),
      ]) {
        assert.equal((await env.manager.importArchive(archive, metadata)).status, 'rejected');
        assert.equal(env.manager.source!.datasetId, id);
      }
      assert.equal(env.store.getActiveDataset('foreverdb')!.dataset_id, id);
    } finally { await env.manager.stop(); env.store.close(); }
  });

  it('repairs a missing cache without a stale validator and preserves offline availability on HTTP failure', async () => {
    const archive = foreverdbZip(); let headers: Headers | null = null, unavailable = false;
    const env = environment(async (url, init) => {
      if (unavailable) return new Response('', { status: 403 });
      if (url === FOREVERDB_MANIFEST_URL) { headers = new Headers(init.headers); return Response.json(manifest(archive), { headers: { ETag: '"m1"' } }); }
      return new Response(Buffer.from(archive));
    });
    try {
      await env.manager.importArchive(archive, { ...metadata, etag: '"m1"' });
      const id = env.manager.source!.datasetId;
      rmSync(join(env.manager.datasetDir(id), 'dataset.json'));
      const restarted = new DatasetManager(env);
      assert.equal(restarted.loadActive(), false);
      assert.equal((await restarted.checkForUpdate()).status, 'activated');
      assert.equal(headers!.get('if-none-match'), null);
      rmSync(join(restarted.datasetDir(id), 'archive.zip'));
      assert.equal((await restarted.checkForUpdate()).status, 'activated');
      assert.equal(headers!.get('if-none-match'), null);
      assert.ok(existsSync(join(restarted.datasetDir(id), 'archive.zip')));
      unavailable = true;
      assert.equal((await restarted.checkForUpdate()).status, 'error');
      assert.equal(restarted.source!.datasetId, id);
    } finally { await env.manager.stop(); env.store.close(); }
  });

  it('serializes update checks and waits for an in-flight request when stopped', async () => {
    let release!: (response: Response) => void;
    const env = environment(() => new Promise((resolve) => { release = resolve; }));
    try {
      const pending = env.manager.checkForUpdate();
      assert.equal((await env.manager.checkForUpdate()).status, 'busy');
      let stopped = false;
      const stopping = env.manager.stop().then(() => { stopped = true; });
      assert.equal(stopped, false);
      release(new Response('', { status: 403 }));
      await pending; await stopping;
      assert.equal(stopped, true);
    } finally { env.store.close(); }
  });
});
