// Automatic ForeverMaster download and update. Open the last working dataset
// on startup; check for updates in the background every 24 hours using
// If-None-Match. Download, parse and index candidates separately;
// activate only after validation. Errors preserve the previous dataset.
// Never delete pinned datasets.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../clock.js';
import type { Diagnostics } from '../../diagnostics.js';
import { randomId, sha256Hex } from '../../ids.js';
import type { Store } from '../../storage/store.js';
import { httpGet, type Fetcher } from '../web.js';
import { ArchiveError, ARCHIVE_LIMITS, readArchive, type ArchiveLimits } from './archive.js';
import { DATA_FILES, DECODER_VERSION, DecodeError, decodeDataset, SKIPPED_FILES, type DecodedDataset } from './decode.js';
import { LuaDataError, parseInProcess, PARSER_LIMITS, type ParseResult, type ParserLimits } from './parse.js';
import { buildIndex, type SearchIndex } from './search.js';
import { ForeverMasterSource } from './tools.js';

export const FOREVERMASTER_URL = 'https://downloads.foreverchanges.pro/addon/latest/ForeverMaster.zip';
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A safety limit violation in any file rejects the entire candidate. */
const SAFETY_CODES = new Set(['ast_limit', 'depth_limit', 'time_limit', 'parser_failed']);

export function datasetIdOf(archiveSha256: string, decoderVersion = DECODER_VERSION): string {
  return sha256Hex(`${archiveSha256}|${decoderVersion}`).slice(0, 32);
}

export type UpdateResult =
  | { status: 'activated'; datasetId: string }
  | { status: 'not_modified' | 'unchanged'; datasetId: string | null }
  | { status: 'rejected'; datasetId: string; code: string }
  | { status: 'error'; code: string }
  | { status: 'busy' };

export interface DatasetManagerOptions {
  store: Store;
  cacheDir: string;
  clock: Clock;
  diag: Diagnostics;
  url?: string;
  fetcher?: Fetcher;
  parserLimits?: ParserLimits;
  candidateTimeoutMs?: number;
  archiveLimits?: ArchiveLimits;
  intervalMs?: number;
}

interface Loaded {
  source: ForeverMasterSource;
}

export class DatasetManager {
  private active: Loaded | null = null;
  private readonly pinned = new Map<string, Loaded>();
  private updating = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: DatasetManagerOptions) {}

  private get root(): string {
    return join(this.options.cacheDir, 'forevermaster');
  }

  datasetDir(datasetId: string): string {
    return join(this.root, 'datasets', datasetId);
  }

  /** Current working dataset; null means none exists and the source is unavailable. */
  get source(): ForeverMasterSource | null {
    return this.active?.source ?? null;
  }

  /** Dataset pinned to an attempt; older datasets remain readable after updates. */
  sourceFor(datasetId: string): ForeverMasterSource | null {
    if (this.active?.source.datasetId === datasetId) return this.active.source;
    const cached = this.pinned.get(datasetId);
    if (cached) return cached.source;
    const loaded = this.load(datasetId);
    if (loaded) this.pinned.set(datasetId, loaded);
    return loaded?.source ?? null;
  }

  private load(datasetId: string): Loaded | null {
    const dir = this.datasetDir(datasetId);
    try {
      const dataset = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8')) as DecodedDataset;
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as SearchIndex;
      if (dataset.decoderVersion !== DECODER_VERSION || index.datasetId !== datasetId || dataset.datasetId !== datasetId) return null;
      return { source: new ForeverMasterSource(dataset, index) };
    } catch {
      return null;
    }
  }

  /** Open the last working dataset on startup. */
  loadActive(): boolean {
    const row = this.options.store.getActiveDataset();
    if (!row) return false;
    const loaded = this.load(row.dataset_id);
    if (!loaded) {
      this.options.diag.error('forevermaster.active_unreadable', { datasetId: row.dataset_id });
      return false;
    }
    this.active = loaded;
    return true;
  }

  start(): void {
    this.loadActive();
    const run = () => {
      void this.checkForUpdate().then((result) => this.options.diag.event('forevermaster.update', { ...flatten(result) }));
    };
    setTimeout(run, 0).unref();
    this.timer = setInterval(run, this.options.intervalMs ?? UPDATE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async checkForUpdate(): Promise<UpdateResult> {
    if (this.updating) return { status: 'busy' };
    this.updating = true;
    try {
      const { store } = this.options;
      const activeRow = store.getActiveDataset();
      const headers: Record<string, string> = {};
      if (activeRow?.source_etag) headers['If-None-Match'] = activeRow.source_etag;
      const limits = this.options.archiveLimits ?? ARCHIVE_LIMITS;
      const response = await httpGet(
        { url: this.options.url ?? FOREVERMASTER_URL, headers, maxBytes: limits.archiveBytes },
        this.options.fetcher,
      );
      if (response.status === 'not_modified') return { status: 'not_modified', datasetId: activeRow?.dataset_id ?? null };
      if (response.status === 'error') return { status: 'error', code: `${response.code}${response.httpStatus ? `:${response.httpStatus}` : ''}` };
      return await this.importArchive(response.body, { etag: response.etag, lastModified: response.lastModified });
    } finally {
      this.updating = false;
    }
  }

  /** Import an archive as a candidate; activate only after all checks pass. */
  async importArchive(archive: Uint8Array, meta: { etag: string | null; lastModified: string | null }): Promise<UpdateResult> {
    const { store, clock, diag } = this.options;
    const archiveSha256 = sha256Hex(archive);
    const datasetId = datasetIdOf(archiveSha256);
    const existing = store.getDataset(datasetId);
    if (existing?.status === 'active') {
      store.transaction('dataset.source', () => store.setDatasetSource(datasetId, meta.etag, meta.lastModified));
      if (!this.active) this.loadActive();
      return { status: 'unchanged', datasetId };
    }
    if (existing?.status === 'rejected') return { status: 'rejected', datasetId, code: existing.error_code ?? 'rejected' };

    const finalDir = this.datasetDir(datasetId);
    const candidateDir = join(this.root, 'candidates', `${datasetId}-${randomId().slice(0, 8)}`);
    mkdirSync(join(candidateDir, 'Data'), { recursive: true });
    store.transaction('dataset.candidate', () =>
      store.upsertCandidateDataset({
        datasetId,
        archiveSha256,
        decoderVersion: DECODER_VERSION,
        sourceUrl: this.options.url ?? FOREVERMASTER_URL,
        etag: meta.etag,
        lastModified: meta.lastModified,
        archivePath: join(finalDir, 'archive.zip'),
        indexPath: join(finalDir, 'index.json'),
        now: clock.now(),
      }),
    );

    const reject = (code: string, detail: string): UpdateResult => {
      diag.warn('forevermaster.rejected', { datasetId, code, detail: detail.slice(0, 300) });
      store.transaction('dataset.reject', () => store.rejectDataset(datasetId, code));
      rmSync(candidateDir, { recursive: true, force: true });
      return { status: 'rejected', datasetId, code };
    };

    try {
      writeFileSync(join(candidateDir, 'archive.zip'), archive);
      const contents = await readArchive(archive, this.options.archiveLimits ?? { ...ARCHIVE_LIMITS });
      const deadline = Date.now() + (this.options.candidateTimeoutMs ?? 60_000);
      const parsed = new Map<string, ParseResult | { error: string }>();
      let totalNodes = 0;
      for (const [file, bytes] of contents.dataFiles) {
        writeFileSync(join(candidateDir, 'Data', file), bytes);
        if (SKIPPED_FILES.includes(file) || !(file in DATA_FILES)) {
          parsed.set(file, { error: 'skipped' });
          continue;
        }
        const left = deadline - Date.now();
        if (left <= 0) return reject('time_limit', 'candidate parsing exceeded its time budget');
        const limits = this.options.parserLimits ?? PARSER_LIMITS;
        try {
          const result = await parseInProcess(bytes, { ...limits, timeoutMs: Math.min(limits.timeoutMs, left) });
          totalNodes += result.nodes;
          if (totalNodes > 2_000_000) return reject('ast_limit', 'candidate exceeds 2000000 AST nodes');
          parsed.set(file, result);
        } catch (error) {
          if (!(error instanceof LuaDataError)) throw error;
          if (SAFETY_CODES.has(error.code)) return reject(error.code, `${file}: ${error.message}`);
          // Forbidden construct or format: a required file will reject the candidate during decoding.
          parsed.set(file, { error: error.code });
        }
      }
      const dataset = decodeDataset({ datasetId, archiveSha256, toc: contents.toc, parsed });
      const index = buildIndex(dataset);
      writeFileSync(join(candidateDir, 'dataset.json'), JSON.stringify(dataset));
      writeFileSync(join(candidateDir, 'index.json'), JSON.stringify(index));

      mkdirSync(join(this.root, 'datasets'), { recursive: true });
      if (!existsSync(finalDir)) renameSync(candidateDir, finalDir);
      else rmSync(candidateDir, { recursive: true, force: true });
      store.transaction('dataset.activate', () =>
        store.activateDataset(datasetId, clock.now(), {
          skippedCount: dataset.skippedCount,
          skippedJson: JSON.stringify(dataset.skips.slice(0, 50)),
          packVersion: dataset.pack.version,
          packBuild: dataset.pack.build,
          packHash: dataset.pack.hash,
        }),
      );
      if (this.active) this.pinned.set(this.active.source.datasetId, this.active);
      this.active = { source: new ForeverMasterSource(dataset, index) };
      diag.event('forevermaster.activated', {
        datasetId,
        recipes: Object.keys(dataset.recipes).length,
        trainers: dataset.trainers.length,
        skipped: dataset.skippedCount,
        pack: dataset.pack.version,
      });
      return { status: 'activated', datasetId };
    } catch (error) {
      if (error instanceof ArchiveError || error instanceof DecodeError) return reject(error.code, error.message);
      return reject('import_failed', String(error));
    }
  }
}

function flatten(result: UpdateResult): Record<string, string | null> {
  return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, v === null ? null : String(v)]));
}
