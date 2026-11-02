// Dataset search index: record names/notes and names from Search.
// Normalize NFKC, lowercase, fold Cyrillic yo to e and collapse whitespace. Rank by
// exact ID -> exact name -> prefix -> substring; break ties by type/recordKey.
import type { DatasetType, DecodedDataset, DatasetRecord, RecipeRecord, TrainerRecord } from './types.js';
import type { LiteralValue } from './lua.js';

export interface IndexEntry {
  type: DatasetType;
  recordKey: string;
  sourcePath: string;
  jsonPointer: string;
  /** Normalized record texts, one per line. */
  searchText: string;
}

export interface SearchIndex {
  decoderVersion: number;
  datasetId: string;
  entries: IndexEntry[];
}

export type MatchKind = 'id' | 'name' | 'prefix' | 'substring';

export interface SearchHit {
  type: DatasetType;
  recordKey: string;
  sourcePath: string;
  match: MatchKind;
  /** First matching original record text for display. */
  text: string;
}

export interface SearchPage {
  hits: SearchHit[];
  nextOffset: number | null;
  total: number;
}

export const SEARCH_LIMITS = { results: 100, bytes: 32 * 1024 } as const;
const MAX_TEXT = 512;

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\u0451/g, '\u0435').replace(/\s+/g, ' ').trim();
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pointer(type: string, key: string): string {
  return `/records/${type}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

function stringLeaves(value: LiteralValue, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (typeof value === 'string') {
    if (value.trim() === '') return;
    const text = value.slice(0, MAX_TEXT);
    out.push(text);
    budget.left -= text.length;
  } else if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, budget);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) stringLeaves(item, out, budget);
  }
}

/** Original record texts: explicit names and notes plus item names from Search. */
export function recordTexts(dataset: DecodedDataset, record: DatasetRecord): string[] {
  const nameOf = (itemId: number | null) => (itemId === null ? null : dataset.names[String(itemId)] ?? null);
  switch (record.type) {
    case 'recipes': {
      const recipe = record.fields as unknown as RecipeRecord;
      return [nameOf(recipe.outputItemId), nameOf(recipe.taughtByItemId)].filter((t): t is string => t !== null);
    }
    case 'trainers': {
      if (record.recordKey === 'cont') return [];
      const trainer = record.fields as unknown as TrainerRecord;
      return [trainer.name];
    }
    case 'search':
      return [record.fields as string];
    case 'items': {
      const itemId = record.recordKey.split('/').pop()!;
      const note = typeof record.fields === 'string' ? record.fields.split('|').slice(2).join('|') : '';
      return [dataset.names[itemId], note].filter((t): t is string => !!t);
    }
    default: {
      const out: string[] = [];
      stringLeaves(record.fields, out, { left: 2048 });
      return out;
    }
  }
}

export function buildIndex(dataset: DecodedDataset): SearchIndex {
  const entries: IndexEntry[] = [];
  for (const [type, records] of Object.entries(dataset.records) as [DatasetType, Record<string, DatasetRecord>][]) {
    for (const record of Object.values(records)) {
      const texts = recordTexts(dataset, record).map(normalizeText).filter((t) => t !== '');
      entries.push({
        type,
        recordKey: record.recordKey,
        sourcePath: record.sourcePath,
        jsonPointer: pointer(type, record.recordKey),
        searchText: texts.join('\n'),
      });
    }
  }
  entries.sort((a, b) => compareCodePoints(a.type, b.type) || compareCodePoints(a.recordKey, b.recordKey));
  return { decoderVersion: dataset.decoderVersion, datasetId: dataset.datasetId, entries };
}

const RANK: Record<MatchKind, number> = { id: 0, name: 1, prefix: 2, substring: 3 };

function matchOf(entry: IndexEntry, query: string, numeric: boolean): { kind: MatchKind; index: number } | null {
  if (numeric && (entry.recordKey === query || entry.recordKey.endsWith(`/${query}`))) return { kind: 'id', index: 0 };
  const texts = entry.searchText === '' ? [] : entry.searchText.split('\n');
  let best: { kind: MatchKind; index: number } | null = null;
  texts.forEach((text, index) => {
    const kind: MatchKind | null = text === query ? 'name' : text.startsWith(query) ? 'prefix' : text.includes(query) ? 'substring' : null;
    if (kind && (!best || RANK[kind] < RANK[best.kind])) best = { kind, index };
  });
  return best;
}

export function searchIndex(
  index: SearchIndex,
  dataset: DecodedDataset,
  query: string,
  types: readonly DatasetType[],
  offset = 0,
  limits: { results: number; bytes: number } = SEARCH_LIMITS,
): SearchPage {
  const q = normalizeText(query);
  if (q === '') return { hits: [], nextOffset: null, total: 0 };
  const numeric = /^[0-9]+$/.test(q);
  const allowed = types.length > 0 ? new Set(types) : null;
  const matches: { entry: IndexEntry; kind: MatchKind; index: number }[] = [];
  for (const entry of index.entries) {
    if (allowed && !allowed.has(entry.type)) continue;
    const match = matchOf(entry, q, numeric);
    if (match) matches.push({ entry, ...match });
  }
  matches.sort(
    (a, b) =>
      RANK[a.kind] - RANK[b.kind] ||
      compareCodePoints(a.entry.type, b.entry.type) ||
      compareCodePoints(a.entry.recordKey, b.entry.recordKey),
  );
  const hits: SearchHit[] = [];
  let bytes = 2;
  let position = offset;
  for (; position < matches.length && hits.length < limits.results; position++) {
    const { entry, kind, index: textIndex } = matches[position]!;
    const record = dataset.records[entry.type]?.[entry.recordKey];
    const texts = record ? recordTexts(dataset, record) : [];
    const hit: SearchHit = {
      type: entry.type,
      recordKey: entry.recordKey,
      sourcePath: entry.sourcePath,
      match: kind,
      text: (texts[textIndex] ?? texts[0] ?? '').slice(0, MAX_TEXT),
    };
    const size = Buffer.byteLength(JSON.stringify(hit)) + 1;
    if (bytes + size > limits.bytes) break;
    bytes += size;
    hits.push(hit);
  }
  return { hits, nextOffset: position < matches.length ? position : null, total: matches.length };
}
