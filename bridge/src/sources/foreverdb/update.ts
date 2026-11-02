// Discover the official ForeverDB bundle, verify its published SHA-256 and size,
// and activate a parsed candidate atomically. Lua is parsed in a disposable child
// process, never executed. Keep prior snapshots for offline use and pinned turns.
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Clock } from '../../clock.js';
import type { Diagnostics } from '../../diagnostics.js';
import { randomId, sha256Hex } from '../../ids.js';
import type { Store } from '../../storage/store.js';
import { httpGet, type Fetcher } from '../web.js';
import { ArchiveError, ARCHIVE_LIMITS, readSelectedArchive, type ArchiveLimits } from '../shared/archive.js';
import type { UpdateResult } from '../shared/update.js';
import { DECODER_VERSION, FOREVERDB_DATA_FILES, type DecodedDataset } from './decode.js';
import { buildIndex, type SearchIndex } from './search.js';
import { ForeverDBSource } from './tools.js';

export const FOREVERDB_MANIFEST_URL = 'https://foreverdb.net/data/addon.json';
export const FOREVERDB_URL = 'https://foreverdb.net/downloads/ForeverDB.zip';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FOREVERDB_ARCHIVE_LIMITS: ArchiveLimits = { ...ARCHIVE_LIMITS, selectedBytes: 64 * 1024 * 1024 };
const TOC = 'ForeverDB/ForeverDB.toc';
const NOTICES = ['ForeverDB/LICENSE.txt', 'ForeverDB/NOTICE.txt', 'ForeverDB/COPYING.txt',
  'ForeverDB_Helper/LICENSE.txt', 'ForeverDB_Helper/NOTICE.txt', 'ForeverDB_Helper/COPYING.txt'];

export function datasetIdOf(archiveSha256: string, decoderVersion = DECODER_VERSION): string {
  return sha256Hex(`foreverdb|${archiveSha256}|${decoderVersion}`).slice(0, 32);
}

export interface DatasetManagerOptions {
  store: Store;
  cacheDir: string;
  clock: Clock;
  diag: Diagnostics;
  fetcher?: Fetcher;
  intervalMs?: number;
  candidateTimeoutMs?: number;
  archiveLimits?: ArchiveLimits;
}

interface Manifest { version: string; sha256: string; bytes: number }
interface ImportMetadata {
  etag: string | null;
  lastModified: string | null;
  version?: string;
  sha256?: string;
  bytes?: number;
}

class CandidateError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function parseForeverInProcess(
  files: Map<string, Uint8Array>, metadata: { datasetId: string; archiveSha256: string }, timeoutMs = 60_000,
): Promise<DecodedDataset> {
  return new Promise((resolveResult, reject) => {
    const child = fork(new URL('./parse-worker.ts', import.meta.url), [], {
      execPath: process.execPath, execArgv: ['--no-orphans'], serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new CandidateError('time_limit', 'ForeverDB parsing timed out'))), timeoutMs);
    child.on('message', (message: { ok: true; dataset: DecodedDataset } | { ok: false; code: string; message: string }) => {
      finish(() => message.ok ? resolveResult(message.dataset) : reject(new CandidateError(message.code, message.message)));
    });
    child.on('error', (error) => finish(() => reject(new CandidateError('parser_failed', error.message))));
    child.on('exit', (code, signal) => finish(() => reject(new CandidateError('parser_failed', `parser exited: ${signal ?? code}`))));
    child.send({ files: [...files], metadata }, (error) => {
      if (error) finish(() => reject(new CandidateError('parser_failed', error.message)));
    });
  });
}

function manifestOf(body: Uint8Array, maxBytes: number): Manifest {
  let value: Record<string, unknown>;
  try { value = JSON.parse(Buffer.from(body).toString('utf8')); }
  catch { throw new CandidateError('invalid_manifest', 'manifest is not JSON'); }
  if (!value || typeof value !== 'object' ||
      typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0 || Number(value.bytes) > maxBytes ||
      value.file !== 'downloads/ForeverDB.zip' || !Array.isArray(value.folders) ||
      !value.folders.includes('ForeverDB') || !value.folders.includes('ForeverDB_Helper')) {
    throw new CandidateError('invalid_manifest', 'unsupported ForeverDB manifest');
  }
  return { version: value.version, sha256: value.sha256, bytes: Number(value.bytes) };
}

export class DatasetManager {
  private active: ForeverDBSource | null = null;
  private readonly pinned = new Map<string, ForeverDBSource>();
  private pending: Promise<UpdateResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DatasetManagerOptions) {}

  private get root(): string { return join(this.options.cacheDir, 'foreverdb'); }
  datasetDir(id: string): string { return join(this.root, 'datasets', id); }
  get source(): ForeverDBSource | null { return this.active; }

  sourceFor(id: string): ForeverDBSource | null {
    if (this.options.store.getDataset(id)?.source_kind !== 'foreverdb') return null;
    if (this.active?.datasetId === id) return this.active;
    const cached = this.pinned.get(id);
    if (cached) return cached;
    const loaded = this.load(id);
    if (loaded) this.pinned.set(id, loaded);
    return loaded;
  }

  private load(id: string): ForeverDBSource | null {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    try {
      const dir = this.datasetDir(id);
      const json = readFileSync(join(dir, 'dataset.json'), 'utf8');
      const saved = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { sha256: string; index: SearchIndex };
      const dataset = JSON.parse(json) as DecodedDataset;
      if (sha256Hex(json) !== saved.sha256 || dataset.decoderVersion !== DECODER_VERSION ||
          dataset.datasetId !== id || saved.index.datasetId !== id ||
          datasetIdOf(dataset.archiveSha256) !== id) return null;
      return new ForeverDBSource(dataset, saved.index);
    } catch { return null; }
  }

  loadActive(): boolean {
    const row = this.options.store.getActiveDataset('foreverdb');
    if (!row) return false;
    const loaded = this.load(row.dataset_id);
    if (!loaded) {
      this.options.diag.warn('foreverdb.active_unreadable', { datasetId: row.dataset_id });
      return false;
    }
    this.active = loaded;
    return true;
  }

  start(): void {
    if (this.timer) return;
    this.loadActive();
    const run = () => { void this.checkForUpdate().then((result) => this.options.diag.event('foreverdb.update', { ...result })); };
    this.startup = setTimeout(run, 0);
    this.startup.unref();
    this.timer = setInterval(run, this.options.intervalMs ?? UPDATE_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.startup) clearTimeout(this.startup);
    if (this.timer) clearInterval(this.timer);
    this.startup = this.timer = null;
    await this.pending;
  }

  checkForUpdate(): Promise<UpdateResult> {
    if (this.pending) return Promise.resolve({ status: 'busy' });
    const run = this.check().catch((error): UpdateResult => {
      this.options.diag.warn('foreverdb.update_failed', { error: String(error).slice(0, 300) });
      return { status: 'error', code: error instanceof CandidateError ? error.code : 'update_failed' };
    });
    this.pending = run;
    void run.finally(() => { if (this.pending === run) this.pending = null; });
    return run;
  }

  private async check(): Promise<UpdateResult> {
    const active = this.options.store.getActiveDataset('foreverdb');
    const headers: Record<string, string> = {};
    // Never send a cache validator when the decoded local copy cannot be read.
    const cached = active && this.source?.datasetId === active.dataset_id ? this.load(active.dataset_id) : null;
    if (active?.source_etag && cached && existsSync(join(this.datasetDir(active.dataset_id), 'archive.zip'))) headers['If-None-Match'] = active.source_etag;
    const response = await httpGet({ url: FOREVERDB_MANIFEST_URL, headers, maxBytes: 2 * 1024 * 1024 }, this.options.fetcher);
    if (response.status === 'not_modified') return cached
      ? { status: 'not_modified', datasetId: active?.dataset_id ?? null }
      : { status: 'error', code: 'unexpected_not_modified' };
    if (response.status === 'error') return { status: 'error', code: `${response.code}${response.httpStatus ? `:${response.httpStatus}` : ''}` };
    const limits = this.options.archiveLimits ?? FOREVERDB_ARCHIVE_LIMITS;
    const manifest = manifestOf(response.body, limits.archiveBytes);
    const id = datasetIdOf(manifest.sha256);
    if (active?.dataset_id === id && this.source?.datasetId === id && cached && existsSync(join(this.datasetDir(id), 'archive.zip'))) {
      if (this.source.dataset.addonVersion !== manifest.version) return { status: 'error', code: 'version_mismatch' };
      if (statSync(join(this.datasetDir(id), 'archive.zip')).size !== manifest.bytes) return { status: 'error', code: 'size_mismatch' };
      this.options.store.transaction('foreverdb.source', () => this.options.store.setDatasetSource(id, response.etag, response.lastModified));
      return { status: 'unchanged', datasetId: id };
    }
    const download = await httpGet({ url: `${FOREVERDB_URL}?v=${manifest.sha256.slice(0, 10)}`, maxBytes: limits.archiveBytes }, this.options.fetcher);
    if (download.status !== 'ok') return { status: 'error', code: download.status === 'error' ? download.code : 'unexpected_not_modified' };
    return this.importArchive(download.body, { ...manifest, etag: response.etag, lastModified: response.lastModified });
  }

  async importArchive(archive: Uint8Array, meta: ImportMetadata): Promise<UpdateResult> {
    const { store, clock, diag } = this.options;
    const archiveSha256 = sha256Hex(archive);
    const datasetId = datasetIdOf(archiveSha256);
    if (meta.sha256 && archiveSha256 !== meta.sha256) return { status: 'error', code: 'checksum_mismatch' };
    if (meta.bytes !== undefined && archive.byteLength !== meta.bytes) return { status: 'error', code: 'size_mismatch' };
    const existing = store.getDataset(datasetId);
    if (existing?.status === 'active' && this.source?.datasetId === datasetId && this.load(datasetId) && existsSync(join(this.datasetDir(datasetId), 'archive.zip'))) {
      if (meta.version && this.source.dataset.addonVersion !== meta.version) return { status: 'error', code: 'version_mismatch' };
      store.transaction('foreverdb.source', () => store.setDatasetSource(datasetId, meta.etag, meta.lastModified));
      return { status: 'unchanged', datasetId };
    }
    const candidateDir = join(this.root, 'candidates', `${datasetId}-${randomId()}`);
    const finalDir = this.datasetDir(datasetId);
    const cleanup = (path: string) => {
      // The only recursive removals are checked descendants of this cache root.
      const absolute = resolve(path), root = resolve(this.root) + sep;
      if (!absolute.startsWith(root)) throw new Error('cache path outside ForeverDB root');
      rmSync(absolute, { recursive: true, force: true });
    };
    try {
      mkdirSync(candidateDir, { recursive: true });
      if (existing?.status !== 'active') store.transaction('foreverdb.candidate', () => store.upsertCandidateDataset({
        sourceKind: 'foreverdb', datasetId, archiveSha256, decoderVersion: DECODER_VERSION,
        sourceUrl: FOREVERDB_URL, etag: meta.etag, lastModified: meta.lastModified,
        archivePath: join(finalDir, 'archive.zip'), indexPath: join(finalDir, 'index.json'), now: clock.now(),
      }));
      const selected = new Set([...FOREVERDB_DATA_FILES, TOC, ...NOTICES]);
      const { files } = await readSelectedArchive(archive, { root: '', select: (name) => selected.has(name) }, this.options.archiveLimits ?? FOREVERDB_ARCHIVE_LIMITS);
      for (const name of [TOC, 'ForeverDB/LICENSE.txt', 'ForeverDB/NOTICE.txt', 'ForeverDB/COPYING.txt']) {
        if (!files.has(name)) throw new CandidateError('required_file_missing', `${name} is missing`);
      }
      const dataset = await parseForeverInProcess(files, { datasetId, archiveSha256 }, this.options.candidateTimeoutMs);
      if (meta.version && dataset.addonVersion !== meta.version) throw new CandidateError('version_mismatch', 'manifest and addon versions disagree');
      const index = buildIndex(dataset);
      const json = JSON.stringify(dataset);
      writeFileSync(join(candidateDir, 'archive.zip'), archive);
      writeFileSync(join(candidateDir, 'dataset.json'), json);
      writeFileSync(join(candidateDir, 'index.json'), JSON.stringify({ sha256: sha256Hex(json), index }));
      for (const name of NOTICES) {
        const bytes = files.get(name);
        if (!bytes) continue;
        const dest = join(candidateDir, name);
        mkdirSync(join(candidateDir, name.split('/')[0]!), { recursive: true });
        writeFileSync(dest, bytes);
      }
      // Construct before activation so malformed decoded shapes cannot retire a working source.
      const source = new ForeverDBSource(dataset, index);
      mkdirSync(join(this.root, 'datasets'), { recursive: true });
      if (existsSync(finalDir)) cleanup(finalDir);
      renameSync(candidateDir, finalDir);
      store.transaction('foreverdb.activate', () => {
        store.activateDataset(datasetId, clock.now(), {
          skippedCount: dataset.skippedCount, skippedJson: JSON.stringify(dataset.skips.slice(0, 50)),
          packVersion: dataset.pack.version, packBuild: dataset.pack.build, packHash: dataset.pack.hash,
        });
        store.setDatasetSource(datasetId, meta.etag, meta.lastModified);
      });
      if (this.active) this.pinned.set(this.active.datasetId, this.active);
      this.active = source;
      diag.event('foreverdb.activated', { datasetId, version: dataset.addonVersion, recipes: Object.keys(dataset.recipes).length, trainers: dataset.trainers.length });
      return { status: 'activated', datasetId };
    } catch (error) {
      const code = error instanceof CandidateError || error instanceof ArchiveError ? error.code : 'import_failed';
      diag.warn('foreverdb.rejected', { datasetId, code, detail: String(error).slice(0, 300) });
      store.transaction('foreverdb.reject', () => store.rejectDataset(datasetId, code));
      return { status: 'rejected', datasetId, code };
    } finally { cleanup(candidateDir); }
  }
}
