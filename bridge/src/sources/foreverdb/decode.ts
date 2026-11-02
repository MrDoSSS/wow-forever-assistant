// Normalize only literal packaged ForeverDB data. Code from the addon is never run.
import type { DecodedDataset as NormalizedDataset, DatasetRecord, DatasetType, TrainerRecord } from '../shared/types.js';
import { DecodeError } from '../shared/types.js';
import { parseDataFile, parseLiteral, type LiteralValue, type ParseResult } from './parse.js';
export type { DatasetRecord, DatasetType, TrainerRecord, RecipeRecord, FileStatus, SkipEntry } from '../shared/types.js';
export { DecodeError };
export const DECODER_VERSION = 1;
export const FOREVERDB_DECODER_VERSION = DECODER_VERSION;
export const FOREVERDB_DATA_FILES = [
  'Meta', 'Recipes', 'NPCs', 'Items', 'SearchNames', 'Spells', 'Talents', 'Dungeons', 'DungeonMaps', 'Gear', 'GearFinder', 'GearSources', 'GearSets', 'Favor', 'Consumables',
].map((name) => `ForeverDB/Data/${name}.lua`).concat(['ForeverDB_Helper/Data/Professions.lua', 'ForeverDB_Helper/Data/Gear.lua']);

export interface ReferenceNpc {
  id: number; name: string; title: string; uiMapId: number | null; x: number | null; y: number | null;
  faction: 'alliance' | 'horde' | 'unknown'; seenInForever: boolean;
}
export interface VendorOffer {
  npcId: number; itemId: number; priceCopper: number; stack: number; limited: number;
  source: 'forever' | 'classic' | 'unknown';
}
export interface DecodedDataset extends NormalizedDataset {
  sourceKind?: 'foreverdb';
  npcs?: Record<string, ReferenceNpc>;
  vendorOffers?: Record<string, VendorOffer[]>;
  itemFacts?: Record<string, Record<string, LiteralValue>>;
  attribution?: string;
  limitations?: string[];
}
const object = (v: LiteralValue | undefined): Record<string, LiteralValue> => v !== null && typeof v === 'object' ? v as Record<string, LiteralValue> : {};
const text = (v: LiteralValue | undefined): string | null => typeof v === 'string' ? v : null;
const integer = (v: LiteralValue | undefined, minimum = 0): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= minimum ? v : null;
const percent = (v: LiteralValue | undefined) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const faction = (v: LiteralValue | undefined): ReferenceNpc['faction'] => v === 'A' || v === 'a' ? 'alliance' : v === 'H' || v === 'h' ? 'horde' : 'unknown';

export function decodeForeverDataset(input: { datasetId: string; archiveSha256: string; files: Map<string, Uint8Array>; toc?: Uint8Array }): DecodedDataset {
  const dataset: DecodedDataset = {
    sourceKind: 'foreverdb', decoderVersion: DECODER_VERSION, datasetId: input.datasetId, archiveSha256: input.archiveSha256,
    addonVersion: null, pack: { version: null, build: null, hash: null, site: 'https://foreverdb.net' }, files: {}, skippedCount: 0, skips: [],
    recipes: Object.create(null), trainers: [], names: Object.create(null), records: {}, npcs: Object.create(null), vendorOffers: Object.create(null), itemFacts: Object.create(null),
    attribution: 'Data from ForeverDB.net (https://foreverdb.net)',
    limitations: ['foreverdb_snapshot: packaged data is not current stock or a personal vendor quote', 'source_labels: preserve Forever observations, client data and Classic fallbacks; NPC seen status alone does not verify every offer or price'],
  };
  const all = new Map<string, Record<string, LiteralValue>>();
  let nodes = 0;
  const skip = (type: DatasetType, path: string, reason: string) => {
    dataset.skippedCount++;
    if (dataset.skips.length < 200) dataset.skips.push({ type, path, reason });
  };
  const record = (type: DatasetType, key: string, fields: unknown, sourcePath: string, limitations: string[] = []) => {
    (dataset.records[type] ??= Object.create(null))[key] = { type, recordKey: key, sourcePath, fields: fields as LiteralValue, limitations };
  };
  const countNodes = (parsed: ParseResult) => { nodes += parsed.nodes; if (nodes > 3_000_000) throw new DecodeError('required_file_invalid', 'AST node budget exceeded'); };
  for (const path of FOREVERDB_DATA_FILES) {
    const bytes = input.files.get(path);
    const required = /\/(Meta|Recipes|NPCs)\.lua$/.test(path);
    if (!bytes) { dataset.files[path] = { status: 'missing' }; if (required) throw new DecodeError('required_file_missing', path); continue; }
    // Optional files with a changed format are disclosed; safety limits always reject.
    let parsed: ParseResult;
    try { parsed = parseDataFile(bytes); }
    catch (error) {
      if (required || !(error instanceof Error) || !('code' in error) || ['ast_limit', 'depth_limit', 'time_limit'].includes(String(error.code))) throw error;
      dataset.files[path] = { status: 'skipped_file', reason: String(error.code) }; skip('pack', path, String(error)); continue;
    }
    countNodes(parsed);
    const tables: Record<string, LiteralValue> = Object.create(null);
    for (const a of parsed.assignments) {
      const root = a.path[0]!;
      if (a.path.length === 1) {
        if (root in tables) throw new DecodeError('required_file_invalid', `duplicate assignment in ${path}`);
        tables[root] = a.value;
      } else if (a.path.length === 2) {
        const base = tables[root];
        if (!base || typeof base !== 'object' || a.path[1]! in base) throw new DecodeError('required_file_invalid', `ambiguous nested assignment in ${path}`);
        (base as Record<string, LiteralValue>)[a.path[1]!] = a.value;
      } else throw new DecodeError('required_file_invalid', `unsupported assignment in ${path}`);
    }
    all.set(path, tables);
    dataset.files[path] = { status: 'decoded', records: parsed.assignments.length, skipped: parsed.skips.length };
    for (const s of parsed.skips) skip('pack', `${path}#${s.path}`, s.reason);
  }
  const file = (name: string) => all.get(`ForeverDB/Data/${name}.lua`) ?? {};
  const meta = object(file('Meta').meta);
  if (!text(meta.version) || !text(meta.build)) throw new DecodeError('required_file_invalid', 'missing ForeverDB version/build');
  dataset.pack = { version: text(meta.version), build: text(meta.build), hash: input.archiveSha256, site: 'https://foreverdb.net' };
  const toc = input.toc ?? input.files.get('ForeverDB/ForeverDB.toc') ?? input.files.get('ForeverDB/ForeverDB_Camelot.toc');
  dataset.addonVersion = toc ? /^## Version:\s*(.+?)\s*$/m.exec(Buffer.from(toc).toString('utf8'))?.[1] ?? null : null;
  if (!dataset.addonVersion || text(meta.addon) && meta.addon !== dataset.addonVersion) throw new DecodeError('required_file_invalid', 'ForeverDB TOC/meta version mismatch');
  record('pack', 'pack', { ...meta, attribution: dataset.attribution }, 'ForeverDB/Data/Meta.lua#meta');
  for (const table of [file('SearchNames').searchItemNames, file('Recipes').names, file('NPCs').soldNames]) {
    for (const [id, name] of Object.entries(object(table))) if (/^[1-9]\d*$/.test(id) && typeof name === 'string') dataset.names[id] = name;
  }
  const npcs = file('NPCs');
  for (const [key, value] of Object.entries(object(npcs.npcs))) {
    if (!Array.isArray(value) || integer(Number(key), 1) === null || !text(value[0])) { skip('trainers', `npc/${key}`, 'bad_npc'); continue; }
    dataset.npcs![key] = { id: Number(key), name: text(value[0])!, title: text(value[1]) ?? '', uiMapId: integer(value[2], 1), x: percent(value[3]), y: percent(value[4]), faction: faction(value[5]), seenInForever: value[6] === 1 };
  }
  for (const [kind, groups] of [['class', npcs.classTrainers], ['prof', npcs.profTrainers]] as const) {
    for (const [group, rows] of Object.entries(object(groups))) {
      for (const id of new Set(Object.values(object(rows)))) {
        const npc = dataset.npcs![String(id)];
        if (!npc) { skip('trainers', `${kind}/${group}/${id}`, 'npc_missing'); continue; }
        const trainer: TrainerRecord = { npcId: npc.id, name: npc.name, faction: npc.faction, uiMapId: npc.uiMapId,
          x: npc.x === null ? null : npc.x / 100, y: npc.y === null ? null : npc.y / 100,
          continentId: null, continentX: null, continentY: null, classToken: kind === 'class' ? group : null, profession: kind === 'prof' ? group : null,
          limitations: [npc.seenInForever ? 'npc_seen_in_forever: not proof this recipe is taught' : 'classic_trainer: not confirmed in Forever'],
        };
        dataset.trainers.push(trainer);
        record('trainers', `${kind}/${group}/${id}`, trainer, 'ForeverDB/Data/NPCs.lua', trainer.limitations);
      }
    }
  }
  if (!Object.keys(dataset.npcs!).length || !dataset.trainers.length) throw new DecodeError('required_file_invalid', 'missing NPC/trainer tables');
  for (const npc of Object.values(dataset.npcs!)) record('trainers', `npc/${npc.id}`, { ...npc, npcId: npc.id }, 'ForeverDB/Data/NPCs.lua#npcs', [npc.seenInForever ? 'npc_seen_in_forever' : 'classic_npc: not confirmed in Forever']);
  const recipeGroups = object(file('Recipes').recipes);
  let totalRecipes = 0, badRecipes = 0;
  for (const [profession, rows] of Object.entries(recipeGroups)) for (const row of Object.values(object(rows))) {
    totalRecipes++;
    if (!Array.isArray(row) || integer(row[0], 1) === null || !text(row[1]) || integer(row[2]) === null || integer(row[7]) === null || text(row[9]) === null || (integer(row[6], 1) !== null && integer(row[7], 1) === null)) { badRecipes++; skip('recipes', profession, 'bad_recipe_row'); continue; }
    const spellId = row[0] as number;
    const materials = new Map<number, number>();
    let invalid = false;
    for (const token of (text(row[8]) ?? '').split(',').filter(Boolean)) {
      const match = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(token);
      if (!match) { invalid = true; break; }
      const id = Number(match[1]), qty = Number(match[2] ?? 1), sum = (materials.get(id) ?? 0) + qty;
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(sum)) { invalid = true; break; }
      materials.set(id, sum);
    }
    if (invalid) { badRecipes++; skip('recipes', String(spellId), 'bad_reagents'); continue; }
    const learnMethod = text(row[9])!;
    const recipe = { spellId, name: text(row[1])!, profession, learn: row[2] === 0 && learnMethod === '' ? null : integer(row[2]), yellow: integer(row[3]), green: integer(row[4]), grey: integer(row[5]), greenDerived: false,
      outputItemId: integer(row[6], 1), outputCount: integer(row[7], 1) ?? 1, taughtByItemId: /^i[1-9]\d*$/.test(learnMethod) ? Number(learnMethod.slice(1)) : null,
      status: row[11] === 1 ? 'new' as const : null, reagents: [...materials].map(([itemId, count]) => ({ itemId, count })), learnMethod,
      limitations: ['learning_source: packaged method, not proof of a specific trainer offer'],
    };
    const previous = dataset.recipes[String(spellId)];
    if (previous && JSON.stringify(previous) !== JSON.stringify(recipe)) {
      const old = previous as typeof recipe;
      if (JSON.stringify({...old,profession}) === JSON.stringify(recipe)) {
        const limit = `alternate_profession: also listed under ${profession}; recipe lookup uses ${old.profession}`;
        old.limitations.push(limit);
        continue;
      }
      badRecipes++; skip('recipes', String(spellId), 'duplicate_spell_conflict'); continue;
    }
    dataset.recipes[String(spellId)] = recipe;
    if (recipe.outputItemId) dataset.names[String(recipe.outputItemId)] ??= recipe.name;
    record('recipes', String(spellId), recipe, `ForeverDB/Data/Recipes.lua#${profession}/${spellId}`, recipe.limitations);
  }
  if (!totalRecipes || badRecipes / totalRecipes > .25 || !Object.keys(dataset.recipes).length) throw new DecodeError('required_file_invalid', 'invalid recipes coverage');
  for (const [itemKey, value] of Object.entries(object(npcs.sold))) {
    if (!Array.isArray(value) || value.length % 4 || integer(Number(itemKey), 1) === null) { skip('items', itemKey, 'bad_vendor_offers'); continue; }
    const offers: VendorOffer[] = [];
    for (let i = 0; i < value.length; i += 4) {
      const npcId = integer(value[i], 1), priceCopper = integer(value[i + 1]), stack = integer(value[i + 2], 1), limited = integer(value[i + 3]);
      if (npcId === null || priceCopper === null || stack === null || limited === null || !dataset.npcs![String(npcId)]) { skip('items', itemKey, 'bad_vendor_offer'); continue; }
      offers.push({ itemId: Number(itemKey), npcId, priceCopper, stack, limited, source: 'unknown' });
    }
    dataset.vendorOffers![itemKey] = offers;
  }
  for (const [id, facts] of Object.entries(object(file('Items').items))) {
    dataset.itemFacts![id] = { sourceEncoding: facts, sourceLegend: 'n=new; c=changed; r=reputation; m=made by profession; u=used in recipes; v=vendors; d=drops; q=quest; s=Forever observations' };
  }
  for (const [id, name] of Object.entries(dataset.names)) record('search', id, name, 'ForeverDB/Data/SearchNames.lua');
  const itemKeys = new Set([...Object.keys(dataset.itemFacts!), ...Object.keys(dataset.vendorOffers!)]);
  for (const id of itemKeys) record('items', `items/${id}`, { name: dataset.names[id] ?? null, ...dataset.itemFacts![id], vendorOffers: dataset.vendorOffers![id] ?? [] }, 'ForeverDB/Data/Items.lua;ForeverDB/Data/NPCs.lua');
  const generic = (fileName: string, tableName: string, type: DatasetType, prefix: string) => {
    const value = file(fileName)[tableName];
    for (const [key, row] of Object.entries(object(value))) record(type, `${prefix}/${key}`, row, `ForeverDB/Data/${fileName}.lua#${tableName}/${key}`);
  };
  generic('Spells', 'classSpells', 'training', 'training');
  generic('Spells', 'builds', 'talents', 'builds');
  generic('Talents', 'talentTrees', 'talents', 'trees');
  generic('Dungeons', 'dungeons', 'dungeons', 'dungeons');
  generic('DungeonMaps', 'dungeonMaps', 'journal', 'maps');
  generic('GearSets', 'gearSets', 'bis', 'sets');
  generic('Consumables', 'consumables', 'bis', 'consumables');
  generic('Favor', 'favor', 'rewards', 'favor');
  const helper = all.get('ForeverDB_Helper/Data/Professions.lua') ?? {};
  const returned = (value: LiteralValue) => {
    if (typeof value !== 'string') throw new DecodeError('required_file_invalid', 'expected packed literal source');
    const parsed = parseLiteral(value); countNodes(parsed);
    if (parsed.skips.length) throw new DecodeError('required_file_invalid', 'packed data contains ambiguous records');
    return parsed.assignments[0]!.value;
  };
  for (const [slug, value] of Object.entries(object(helper.profSrc))) {
    const guide = returned(value);
    record('leveling', `leveling/${slug}`, guide, 'ForeverDB_Helper/Data/Professions.lua#profSrc', ['guide_routes: selected recipes, not exhaustive training prices; preserve source flags']);
    record('professions', `professions/${slug}`, { summary: object(helper.profs)[slug] ?? null, guide }, 'ForeverDB_Helper/Data/Professions.lua');
    for (const side of ['a', 'h']) for (const step of Object.values(object(object(object(guide)[side]).steps))) {
      const entry = object(step), learned = object(entry.L), spellId = integer(entry.s, 1), costCopper = integer(learned.cost);
      if (spellId === null || costCopper === null) continue;
      const recipe = dataset.recipes[String(spellId)] as typeof dataset.recipes[string] & { trainingSources?: LiteralValue[] };
      if (!recipe) continue;
      // Keep the guide's source flags; a trainer being seen does not verify this fee.
      const learningSource = { side: side === 'a' ? 'alliance' : 'horde', costCopper, provenance: 'packaged_profession_guide', details: learned };
      (recipe.trainingSources ??= []).push(learningSource);
      const limitation = 'training_cost: packaged guide; inspect source flags, personal price may differ';
      if (!recipe.limitations.includes(limitation)) recipe.limitations.push(limitation);
      const original = dataset.records.recipes?.[String(spellId)];
      if (original) original.sourcePath = 'ForeverDB/Data/Recipes.lua;ForeverDB_Helper/Data/Professions.lua';
    }
  }
  for (const [slug, value] of Object.entries(object(helper.profBisSrc))) record('bis', `crafted/${slug}`, returned(value), 'ForeverDB_Helper/Data/Professions.lua#profBisSrc');
  for (const [id, row] of Object.entries(object(helper.profPrices))) {
    if (!Array.isArray(row)) continue;
    record('prices', `vendor/${id}`, { itemId: Number(id), name: dataset.names[id] ?? null, allianceUnitPriceCopper: row[0], hordeUnitPriceCopper: row[1], seenInForever: row[2] === 1, zeroMeansUnavailable: true }, 'ForeverDB_Helper/Data/Professions.lua#profPrices');
  }
  // Helper's seven-character ladder records are already sorted by its scoring.
  // Preserve minimum level and source labels so the model can filter an exact level.
  const gear = all.get('ForeverDB_Helper/Data/Gear.lua') ?? {};
  const classes: Record<string,string> = {1:'WARRIOR',2:'PALADIN',3:'HUNTER',4:'ROGUE',5:'PRIEST',7:'SHAMAN',8:'MAGE',9:'WARLOCK',11:'DRUID'};
  const specs: Record<string,string> = {};
  for (const [classToken, packed] of Object.entries(object(file('GearFinder').gfClass))) {
    if (typeof packed !== 'string') continue;
    for (const line of packed.split('\n')) {
      const fields = line.split('\t');
      if (fields[0] === 'S' && fields[1] && fields[2]) specs[`${classToken}/${fields[1]}`] = fields[2];
    }
  }
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const [key, slots] of Object.entries(object(gear.gearLadder))) {
    const [classId,spec,mode] = key.split(':');
    for (const [slot, packed] of Object.entries(object(slots))) {
      if (typeof packed !== 'string' || packed.length % 7) { skip('bis', key, 'invalid_ladder'); continue; }
      const candidates = [];
      for (let i=0;i<packed.length;i+=7) {
        const itemId = Number.parseInt(packed.slice(i,i+4),36), minLevel = alphabet.indexOf(packed[i+4]!), score = Number.parseInt(packed.slice(i+5,i+7),36);
        if (!Number.isSafeInteger(itemId) || minLevel<0 || !Number.isFinite(score)) throw new DecodeError('required_file_invalid','bad gear ladder encoding');
        candidates.push({itemId,name:dataset.names[String(itemId)] ?? null,minLevel,score,source:object(gear.gearSrc)[String(itemId)] ?? null,itemConstraints:object(gear.gearItems)[String(itemId)] ?? null});
      }
      record('bis', `${classes[classId!] ?? classId}/${spec}/${mode}/${slot}`, {classToken:classes[classId!] ?? classId,specIndex:Number(spec),specName:specs[`${classes[classId!]}/${spec}`] ?? null,mode,slot,weaponStyle:object(gear.gearStyle)[`${classId}:${spec}`] ?? null,weights:object(gear.gearWeights)[`${classId}:${spec}`] ?? null,candidates,sourceLegend:'s=seen in Forever; c=unconfirmed clue; f=Forever client; k=Classic'}, 'ForeverDB_Helper/Data/Gear.lua#gearLadder', ['gear_scoring: ForeverDB weights, not proof of current availability; filter minLevel, faction and weapon constraints']);
    }
  }
  return dataset;
}
