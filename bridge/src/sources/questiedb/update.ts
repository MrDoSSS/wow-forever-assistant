// Discover the latest stable GitHub release, import its Forever artifact independently
// of ForeverMaster, and retain the last working snapshot on any download or decode error.
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../clock.js';
import type { Diagnostics } from '../../diagnostics.js';
import { randomId, sha256Hex } from '../../ids.js';
import type { Store } from '../../storage/store.js';
import { ArchiveError, readSelectedArchive } from '../forevermaster/archive.js';
import { UPDATE_INTERVAL_MS, type UpdateResult } from '../forevermaster/update.js';
import { httpGet, type Fetcher } from '../web.js';
import { QuestieDataError } from './cbor.js';
import { QUESTIE_DECODER_VERSION, type QuestieDataset } from './decode.js';
import { QuestieSource } from './tools.js';

export const QUESTIEDB_RELEASE_URL = 'https://api.github.com/repos/Questie/QuestieDB/releases/latest';
export const QUESTIEDB_ARCHIVE_LIMITS = {
  archiveBytes: 48 * 1024 * 1024, entries: 4096, fileBytes: 48 * 1024 * 1024,
  totalUncompressedBytes: 192 * 1024 * 1024, selectedBytes: 64 * 1024 * 1024,
};
const SELECTED = /^QuestieDB\/(?:QuestieDB_(?:Forever|Camelot)\.toc|src\/meta\/(?:quest|npc|item|object)Meta\.lua|src\/corrections\/enum\/expansions\.lua|support\/Forever\/Zones\/areaIdToUiMapId\.lua)$/;

export function questieDatasetId(archiveSha256: string): string {
  return sha256Hex(`questiedb|${archiveSha256}|${QUESTIE_DECODER_VERSION}`).slice(0, 32);
}

export function parseQuestieInProcess(
  files: Map<string, Uint8Array>, metadata: Parameters<typeof import('./decode.js').decodeQuestieDataset>[1], timeoutMs = 60_000,
): Promise<QuestieDataset> {
  return new Promise((resolve, reject) => {
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
    const timer = setTimeout(() => finish(() => reject(new QuestieDataError('time_limit', 'QuestieDB parsing timed out'))), timeoutMs);
    child.on('message', (message: { ok: true; dataset: QuestieDataset } | { ok: false; code: string; message: string }) => {
      finish(() => message.ok ? resolve(message.dataset) : reject(new QuestieDataError(message.code, message.message)));
    });
    child.on('error', (error) => finish(() => reject(new QuestieDataError('parser_failed', error.message))));
    child.on('exit', (code, signal) => finish(() => reject(new QuestieDataError('parser_failed', `parser exited: ${signal ?? code}`))));
    child.send({ files: [...files], metadata }, (error) => {
      if (error) finish(() => reject(new QuestieDataError('parser_failed', error.message)));
    });
  });
}

export interface QuestieManagerOptions {
  store: Store;
  cacheDir: string;
  clock: Clock;
  diag: Diagnostics;
  fetcher?: Fetcher;
  intervalMs?: number;
  parseTimeoutMs?: number;
}
interface ImportMetadata {
  sourceUrl: string;
  releaseTag?: string;
  etag: string | null;
  lastModified: string | null;
  digest?: string | null;
}

export class QuestieDatasetManager {
  source: QuestieSource | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;
  private pending: Promise<UpdateResult> | null = null;
  constructor(private readonly options: QuestieManagerOptions) {}

  private get root(): string { return join(this.options.cacheDir, 'questiedb'); }
  datasetDir(id: string): string { return join(this.root, 'datasets', id); }

  loadActive(): boolean {
    const row = this.options.store.getActiveDataset('questiedb');
    if (!row) return false;
    try {
      const dir = this.datasetDir(row.dataset_id);
      const json = readFileSync(join(dir, 'dataset.json'), 'utf8');
      const manifest = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { sha256: string };
      const dataset = JSON.parse(json) as QuestieDataset;
      if (sha256Hex(json) !== manifest.sha256 || dataset.datasetId !== row.dataset_id || dataset.archiveSha256 !== row.archive_sha256 || dataset.decoderVersion !== QUESTIE_DECODER_VERSION) return false;
      this.source = new QuestieSource(dataset);
      return true;
    } catch (error) {
      this.options.diag.warn('questiedb.active_unreadable', { datasetId: row.dataset_id, error: String(error) });
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    if (!this.source) this.loadActive();
    const run = () => { void this.checkForUpdate().then((result) => this.options.diag.event('questiedb.update', { ...result })); };
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

  async checkForUpdate(): Promise<UpdateResult> {
    if (this.pending) return { status: 'busy' };
    this.pending = this.update().catch((error: unknown): UpdateResult => {
      this.options.diag.warn('questiedb.update_failed', { error: String(error) });
      return { status: 'error', code: 'update_failed' };
    });
    try { return await this.pending; }
    finally { this.pending = null; }
  }

  private async update(): Promise<UpdateResult> {
    const active = this.options.store.getActiveDataset('questiedb');
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'WoW-Forever-Assistant' };
    // A validator only applies when its corresponding decoded snapshot is readable.
    if (this.source && active?.source_etag) headers['If-None-Match'] = active.source_etag;
    const response = await httpGet({ url: QUESTIEDB_RELEASE_URL, headers, maxBytes: 2 * 1024 * 1024 }, this.options.fetcher);
    if (response.status === 'not_modified') return { status: 'not_modified', datasetId: this.source?.datasetId ?? null };
    if (response.status === 'error') return { status: 'error', code: `${response.code}${response.httpStatus ? `:${response.httpStatus}` : ''}` };
    let release: { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: { name?: unknown; browser_download_url?: unknown; digest?: unknown }[] };
    try { release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
    catch { return { status: 'error', code: 'release_format' }; }
    if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Array.isArray(release.assets)) return { status: 'error', code: 'release_format' };
    const assets = release.assets.filter((asset) => asset?.name === 'QuestieDB-Forever.zip');
    if (assets.length !== 1) return { status: 'error', code: 'missing_forever_asset' };
    const asset = assets[0]!;
    const expectedUrl = `https://github.com/Questie/QuestieDB/releases/download/${release.tag_name}/QuestieDB-Forever.zip`;
    if (asset.browser_download_url !== expectedUrl || (asset.digest != null && (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)))) return { status: 'error', code: 'release_format' };
    const download = await httpGet({ url: expectedUrl, maxBytes: QUESTIEDB_ARCHIVE_LIMITS.archiveBytes }, this.options.fetcher);
    if (download.status !== 'ok') return { status: 'error', code: download.status === 'error' ? download.code : 'unexpected_304' };
    return this.importArchive(download.body, {
      sourceUrl: expectedUrl, releaseTag: release.tag_name, etag: response.etag, lastModified: response.lastModified,
      digest: asset.digest as string | null | undefined,
    });
  }

  async importArchive(archive: Uint8Array, meta: ImportMetadata): Promise<UpdateResult> {
    const { store, clock, diag } = this.options;
    const archiveSha256 = sha256Hex(archive);
    const datasetId = questieDatasetId(archiveSha256);
    if (meta.digest && meta.digest !== `sha256:${archiveSha256}`) return { status: 'error', code: 'checksum_mismatch' };
    const existing = store.getDataset(datasetId);
    if (existing?.status === 'active' && this.source?.datasetId === datasetId) {
      if (meta.releaseTag && meta.releaseTag !== `v${this.source.dataset.version}`) return { status: 'error', code: 'version_mismatch' };
      store.transaction('questiedb.source', () => store.setDatasetSource(datasetId, meta.etag, meta.lastModified));
      return { status: 'unchanged', datasetId };
    }
    const finalDir = this.datasetDir(datasetId);
    const candidateDir = join(this.root, 'candidates', `${datasetId}-${randomId()}`);
    try {
      mkdirSync(candidateDir, { recursive: true });
      // Do not demote an existing active row while repairing a missing cache.
      if (existing?.status !== 'active') store.transaction('questiedb.candidate', () => store.upsertCandidateDataset({
        sourceKind: 'questiedb', datasetId, archiveSha256, decoderVersion: QUESTIE_DECODER_VERSION,
        sourceUrl: meta.sourceUrl, etag: meta.etag, lastModified: meta.lastModified,
        archivePath: join(finalDir, 'archive.zip'), indexPath: join(finalDir, 'index.json'), now: clock.now(),
      }));
      const { files } = await readSelectedArchive(archive, { root: 'QuestieDB/', select: (name) => SELECTED.test(name) }, QUESTIEDB_ARCHIVE_LIMITS);
      const dataset = await parseQuestieInProcess(files, { datasetId, archiveSha256, sourceUrl: meta.sourceUrl }, this.options.parseTimeoutMs);
      if (meta.releaseTag && meta.releaseTag !== `v${dataset.version}`) throw new QuestieDataError('version_mismatch', 'release tag and TOC version disagree');
      const source = new QuestieSource(dataset);
      const json = JSON.stringify(dataset);
      writeFileSync(join(candidateDir, 'archive.zip'), archive);
      writeFileSync(join(candidateDir, 'dataset.json'), json);
      writeFileSync(join(candidateDir, 'index.json'), JSON.stringify({ sha256: sha256Hex(json) }));
      mkdirSync(join(this.root, 'datasets'), { recursive: true });
      // Normal imports have unique paths; a repeated hash can repair an unreadable cache.
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(candidateDir, finalDir);
      store.transaction('questiedb.activate', () => {
        store.activateDataset(datasetId, clock.now(), { skippedCount: 0, skippedJson: '[]', packVersion: dataset.version, packBuild: 'Forever', packHash: dataset.buildCommit });
        store.setDatasetSource(datasetId, meta.etag, meta.lastModified);
      });
      this.source = source;
      diag.event('questiedb.activated', { datasetId, version: dataset.version, ...source.counts });
      return { status: 'activated', datasetId };
    } catch (error) {
      const code = error instanceof QuestieDataError || error instanceof ArchiveError ? error.code : 'import_failed';
      diag.warn('questiedb.rejected', { datasetId, code, detail: String(error).slice(0, 300) });
      store.transaction('questiedb.reject', () => store.rejectDataset(datasetId, code));
      return { status: 'rejected', datasetId, code };
    } finally { rmSync(candidateDir, { recursive: true, force: true }); }
  }
}
