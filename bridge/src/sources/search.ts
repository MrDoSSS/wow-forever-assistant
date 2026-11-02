// One ranked search across immutable ForeverMaster and QuestieDB snapshots.
// Group only by entity kind and ID; source records and conflicting text remain separate.
import { DATASET_TYPES, type SearchType } from '../contracts.js';
import type { DatasetType, TrainerRecord, RecipeRecord } from './forevermaster/decode.js';
import { searchIndex, type MatchKind } from './forevermaster/search.js';
import type { ForeverMasterSource } from './forevermaster/tools.js';
import { ENTITY_TYPES, type EntityType } from './questiedb/decode.js';
import type { QuestieSource } from './questiedb/tools.js';

export const GAME_SEARCH_LIMITS = { results: 20, bytes: 20 * 1024, recordsPerHit: 8 };
export interface SearchRecord {
  source: 'forevermaster' | 'questiedb';
  datasetId: string;
  /** Original source type/key for fetching details; not the unified search type. */
  type: DatasetType | EntityType;
  recordKey: string;
  text: string;
  match: MatchKind;
}
export interface GameSearchHit {
  type: SearchType;
  id: number | null;
  recordKey: string | null;
  name: string;
  match: MatchKind;
  records: SearchRecord[];
  totalRecords: number;
}
export interface GameSearchPage {
  hits: GameSearchHit[];
  total: number;
  nextOffset: number | null;
  available: boolean;
  sources: { forevermaster: string | null; questiedb: string | null };
  limitations: string[];
}
const RANK: Record<MatchKind, number> = { id: 0, name: 1, prefix: 2, substring: 3 };
const MATCHES: MatchKind[] = ['id', 'name', 'prefix', 'substring'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const typeOf = (type: DatasetType): SearchType => type === 'items' || type === 'search' ? 'item' : type === 'recipes' ? 'recipe' : type === 'trainers' ? 'npc' : type;

export function searchGameData(
  master: ForeverMasterSource | null, questie: QuestieSource | null,
  query: string, types: readonly SearchType[], offset = 0,
): GameSearchPage {
  const allowed = new Set(types);
  const masterTypes = DATASET_TYPES.filter((type) => !allowed.size || allowed.has(typeOf(type)));
  const questieTypes = ENTITY_TYPES.filter((type) => !allowed.size || allowed.has(type));
  const limitations: string[] = [];
  if (masterTypes.length && !master) limitations.push('forevermaster_unavailable: results from this source are missing');
  if (questieTypes.length && !questie) limitations.push('questiedb_unavailable: results from this source are missing');
  const groups = new Map<string, GameSearchHit>();
  const add = (type: SearchType, id: number | null, name: string, record: SearchRecord) => {
    // Non-entity records use their source key; equal names never establish identity.
    const key = JSON.stringify([type, id ?? `${record.source}/${record.type}/${record.recordKey}`]);
    const group = groups.get(key);
    if (!group) groups.set(key, { type, id, recordKey: id === null ? record.recordKey : null, name: name.slice(0, 256), match: record.match, records: [record], totalRecords: 1 });
    else {
      if (RANK[record.match] < RANK[group.match]) { group.match = record.match; group.name = name.slice(0, 256); }
      group.records.push(record);
      group.totalRecords++;
    }
  };
  if (master && masterTypes.length) {
    const page = searchIndex(master.index, master.dataset, query, masterTypes, 0, { results: Infinity, bytes: Infinity });
    for (const hit of page.hits) {
      const type = typeOf(hit.type);
      const raw = master.dataset.records[hit.type]?.[hit.recordKey];
      let id: number | null = null;
      let name = hit.text;
      if (type === 'item') {
        const number = /(?:^|\/)(\d+)$/.exec(hit.recordKey)?.[1];
        if (number) { id = Number(number); name = master.dataset.names[number] ?? name; }
      } else if (type === 'recipe') {
        const recipe = raw?.fields as unknown as RecipeRecord | undefined;
        id = recipe?.spellId ?? null;
        if (recipe?.outputItemId) name = master.dataset.names[String(recipe.outputItemId)] ?? name;
      } else if (type === 'npc') {
        const trainer = raw?.fields as unknown as TrainerRecord | undefined;
        id = trainer?.npcId ?? null;
        name = trainer?.name ?? name;
      }
      add(type, id, name, { source: 'forevermaster', datasetId: master.datasetId, type: hit.type, recordKey: hit.recordKey, text: hit.text.slice(0, 256), match: hit.match });
    }
  }
  if (questie && questieTypes.length) {
    for (const hit of questie.search(query, questieTypes, 0, Infinity).hits) {
      add(hit.type, hit.id, hit.name, { source: 'questiedb', datasetId: questie.datasetId, type: hit.type, recordKey: String(hit.id), text: hit.name.slice(0, 256), match: MATCHES[hit.rank]! });
    }
  }
  const ranked = [...groups.values()].sort((a, b) => RANK[a.match] - RANK[b.match] || compare(a.type, b.type) ||
    (a.id !== null && b.id !== null ? a.id - b.id : a.id !== null ? -1 : b.id !== null ? 1 : compare(a.name, b.name)) ||
    compare(a.records[0]!.recordKey, b.records[0]!.recordKey));
  const hits: GameSearchHit[] = [];
  let bytes = 2;
  let position = offset;
  for (; position < ranked.length && hits.length < GAME_SEARCH_LIMITS.results; position++) {
    const group = ranked[position]!;
    group.records.sort((a, b) => RANK[a.match] - RANK[b.match] || compare(a.source, b.source) || compare(a.type, b.type) || compare(a.recordKey, b.recordKey));
    const hit = { ...group, records: group.records.slice(0, GAME_SEARCH_LIMITS.recordsPerHit) };
    const size = Buffer.byteLength(JSON.stringify(hit)) + 1;
    if (bytes + size > GAME_SEARCH_LIMITS.bytes) break;
    if (hit.records.length < hit.totalRecords) limitations.push(`source_records_truncated: ${hit.type}/${hit.id ?? hit.name}; first ${hit.records.length} of ${hit.totalRecords}`);
    hits.push(hit);
    bytes += size;
  }
  if (!ranked.length) limitations.push('no_match: no match does not prove absence from the game');
  return {
    hits, total: ranked.length, nextOffset: position < ranked.length ? position : null,
    available: !!(master && masterTypes.length || questie && questieTypes.length),
    sources: { forevermaster: master?.datasetId ?? null, questiedb: questie?.datasetId ?? null }, limitations,
  };
}
