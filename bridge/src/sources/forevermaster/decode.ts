// Normalize ForeverMaster data: Recipes, Trainers and Search decoders;
// other datasets retain their original literal structure and provenance.
import type { DATASET_TYPES } from '../../contracts.js';
import type { Assignment, LiteralValue, ParseResult, ParseSkip } from './parse.js';

export type DatasetType = (typeof DATASET_TYPES)[number];

export const DECODER_VERSION = 1;

export interface DataFileSpec {
  type: DatasetType;
  required: boolean;
}

/** File -> dataset type. Internal table names may differ (Search.lua -> names). */
export const DATA_FILES: Record<string, DataFileSpec> = {
  'Pack.lua': { type: 'pack', required: true },
  'Recipes.lua': { type: 'recipes', required: true },
  'Trainers.lua': { type: 'trainers', required: true },
  'Items.lua': { type: 'items', required: false },
  'Search.lua': { type: 'search', required: false },
  'Dungeons.lua': { type: 'dungeons', required: false },
  'Journal.lua': { type: 'journal', required: false },
  'Leveling.lua': { type: 'leveling', required: false },
  'Professions.lua': { type: 'professions', required: false },
  'Training.lua': { type: 'training', required: false },
  'Talents.lua': { type: 'talents', required: false },
  'Bis.lua': { type: 'bis', required: false },
  'Rewards.lua': { type: 'rewards', required: false },
  'Prices.lua': { type: 'prices', required: false },
};

/** Not read: chains, realms, exports and the observation collection list. */
export const SKIPPED_FILES = ['Chains.lua', 'Realms.lua', 'Uploaded.lua', 'Want.lua'];

/** Maximum skipped Recipes or Trainers fraction before rejecting a candidate. */
export const MAX_SKIPPED_SHARE = 0.25;

export interface Reagent {
  itemId: number;
  count: number;
}

export interface RecipeRecord {
  spellId: number;
  profession: string;
  learn: number | null;
  yellow: number | null;
  green: number | null;
  grey: number | null;
  greenDerived: boolean;
  /** null means an effect without an output item, such as an enchantment. */
  outputItemId: number | null;
  outputCount: number;
  /** Item that teaches the recipe, not an NPC. */
  taughtByItemId: number | null;
  status: 'new' | 'changed' | null;
  reagents: Reagent[];
  limitations: string[];
}

export interface TrainerRecord {
  npcId: number;
  name: string;
  faction: 'alliance' | 'horde' | 'unknown';
  uiMapId: number | null;
  /** Coordinates as 0..1 fractions of uiMapId; null for invalid coordinates. */
  x: number | null;
  y: number | null;
  continentId: number | null;
  continentX: number | null;
  continentY: number | null;
  classToken: string | null;
  profession: string | null;
  limitations: string[];
}

export interface DatasetRecord {
  type: DatasetType;
  recordKey: string;
  sourcePath: string;
  fields: LiteralValue;
  limitations: string[];
}

export type FileStatus =
  | { status: 'decoded'; records: number; skipped: number }
  | { status: 'skipped_file'; reason: string }
  | { status: 'missing' };

export interface SkipEntry {
  type: DatasetType;
  path: string;
  reason: string;
}

export interface DecodedDataset {
  decoderVersion: number;
  datasetId: string;
  archiveSha256: string;
  addonVersion: string | null;
  pack: { version: string | null; build: string | null; hash: string | null; site: string | null };
  files: Record<string, FileStatus>;
  skippedCount: number;
  /** First skipped records and reasons, for get_source_status. */
  skips: SkipEntry[];
  recipes: Record<string, RecipeRecord>;
  trainers: TrainerRecord[];
  names: Record<string, string>;
  /** All records by type and key, including normalized recipes/trainers/search. */
  records: Partial<Record<DatasetType, Record<string, DatasetRecord>>>;
}

export class DecodeError extends Error {
  constructor(
    readonly code: 'required_file_missing' | 'required_file_invalid' | 'too_many_skipped',
    message: string,
  ) {
    super(message);
    this.name = 'DecodeError';
  }
}

const MAX_SKIPS_LISTED = 200;

function isObject(value: LiteralValue | undefined): value is { [key: string]: LiteralValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: LiteralValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

/** File tables: merge assignments to paths and subpaths. */
export function tablesOf(result: ParseResult): { tables: Record<string, LiteralValue>; conflicts: string[] } {
  const tables: Record<string, LiteralValue> = Object.create(null);
  const conflicts: string[] = [];
  for (const assignment of result.assignments as Assignment[]) {
    const [name, sub] = assignment.path as [string, string?];
    if (sub === undefined) {
      if (name in tables) conflicts.push(name);
      else tables[name] = assignment.value;
      continue;
    }
    // An empty {} is parsed as an array; subpaths turn it into a dictionary.
    if (Array.isArray(tables[name]) && (tables[name] as LiteralValue[]).length === 0) tables[name] = Object.create(null);
    const parent = tables[name];
    if (!isObject(parent) || sub in parent) {
      conflicts.push(`${name}.${sub}`);
      continue;
    }
    parent[sub] = assignment.value;
  }
  return { tables, conflicts };
}

// ---------------------------------------------------------------------------
// Recipes: recipes[profession][spellId] = "learn|yellow|green|grey|makes|count|taughtBy|status|reagents"

const UINT = /^[0-9]+$/;

function optionalInt(text: string): number | null | 'bad' {
  if (text === '') return null;
  if (!UINT.test(text)) return 'bad';
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 'bad';
}

export function decodeRecipe(profession: string, spellKey: string, line: string): RecipeRecord | string {
  if (!UINT.test(spellKey) || Number(spellKey) < 1) return 'bad_spell_id';
  const parts = line.split('|');
  if (parts.length !== 9) return 'field_count';
  const [learnT, yellowT, greenT, greyT, makesT, countT, taughtT, statusT, reagentsT] = parts as [
    string, string, string, string, string, string, string, string, string,
  ];
  const ints = [learnT, yellowT, greenT, greyT, makesT, countT, taughtT].map(optionalInt);
  if (ints.includes('bad')) return 'bad_number';
  const [learn, yellow, green, grey, makes, count, taughtBy] = ints as [
    number | null, number | null, number | null, number | null, number | null, number | null, number | null,
  ];
  const limitations: string[] = [];
  const outputCount = count ?? 1;
  if (outputCount < 1) return 'bad_count';

  let greenValue = green ?? null;
  let greenDerived = false;
  if (greenValue === null && yellow != null && grey != null) {
    greenValue = Math.floor((yellow + grey) / 2);
    greenDerived = true;
  }

  let status: RecipeRecord['status'] = null;
  if (statusT === 'n') status = 'new';
  else if (statusT === 'c') status = 'changed';
  else if (statusT !== '') limitations.push(`unknown_status:${statusT.slice(0, 16)}`);

  const reagents = new Map<number, number>();
  if (reagentsT !== '') {
    for (const part of reagentsT.split(',')) {
      const match = /^([0-9]+)(?::([0-9]+))?$/.exec(part);
      if (!match) return 'bad_reagent';
      const itemId = Number(match[1]);
      const amount = match[2] === undefined ? 1 : Number(match[2]);
      if (!Number.isSafeInteger(itemId) || itemId < 1 || !Number.isSafeInteger(amount) || amount < 1) return 'bad_reagent';
      const total = (reagents.get(itemId) ?? 0) + amount;
      if (!Number.isSafeInteger(total)) return 'bad_reagent';
      reagents.set(itemId, total);
    }
  }
  if (makes === 0 || taughtBy === 0) return 'bad_item_id';
  return {
    spellId: Number(spellKey),
    profession,
    learn,
    yellow,
    green: greenValue,
    grey,
    greenDerived,
    outputItemId: makes,
    outputCount,
    taughtByItemId: taughtBy,
    status,
    reagents: [...reagents].map(([itemId, count]) => ({ itemId, count })),
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Trainers: { cont, class = { TOKEN = {rows} }, prof = { Name = {rows} } }
// row = { npcId, name, faction, uiMapId, x, y, continentId, continentX, continentY }

const FACTIONS: Record<string, TrainerRecord['faction']> = { A: 'alliance', H: 'horde' };

function num(value: LiteralValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function id(value: LiteralValue | undefined): number | null {
  const n = num(value);
  return n !== null && Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function percent(value: LiteralValue | undefined): number | null {
  const n = num(value);
  // Round to 1e-6 to avoid binary division tails (74.4 -> 0.744).
  return n !== null && n >= 0 && n <= 100 ? Math.round(n * 1e4) / 1e6 : null;
}

export function decodeTrainer(row: LiteralValue, group: { classToken: string | null; profession: string | null }): TrainerRecord | string {
  if (!Array.isArray(row) || row.length !== 9) return 'field_count';
  const npcId = id(row[0]);
  const name = str(row[1]);
  if (npcId === null) return 'bad_npc_id';
  if (!name) return 'bad_name';
  const limitations: string[] = [];
  const faction = FACTIONS[str(row[2]) ?? ''] ?? 'unknown';
  let x = percent(row[4]);
  let y = percent(row[5]);
  const uiMapId = id(row[3]);
  if (x === null || y === null || uiMapId === null) {
    limitations.push('invalid_coordinates');
    x = null;
    y = null;
  }
  return {
    npcId,
    name,
    faction,
    uiMapId,
    x,
    y,
    continentId: id(row[6]),
    continentX: num(row[7]),
    continentY: num(row[8]),
    classToken: group.classToken,
    profession: group.profession,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Search names: long string of "<base36 ID delta> <name>" lines, starting at 0.

export function decodeNames(text: string): { names: Record<string, string>; skipped: number } {
  const names: Record<string, string> = Object.create(null);
  let previous = 0;
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const match = /^([0-9a-z]+) (.+)$/.exec(line);
    if (!match) {
      skipped++;
      continue;
    }
    const itemId = previous + Number.parseInt(match[1]!, 36);
    if (!Number.isSafeInteger(itemId)) {
      skipped++;
      continue;
    }
    previous = itemId;
    names[String(itemId)] = match[2]!;
  }
  return { names, skipped };
}

// ---------------------------------------------------------------------------

export interface DecodeInput {
  datasetId: string;
  archiveSha256: string;
  toc: Uint8Array;
  /** Parsed files; a missing map entry means the archive did not contain the file. */
  parsed: Map<string, ParseResult | { error: string }>;
}

export function decodeDataset(input: DecodeInput): DecodedDataset {
  const files: Record<string, FileStatus> = {};
  const skips: SkipEntry[] = [];
  let skippedCount = 0;
  const records: DecodedDataset['records'] = {};
  const addRecord = (record: DatasetRecord) => {
    (records[record.type] ??= Object.create(null) as Record<string, DatasetRecord>)[record.recordKey] = record;
  };
  const skip = (type: DatasetType, path: string, reason: string) => {
    skippedCount++;
    if (skips.length < MAX_SKIPS_LISTED) skips.push({ type, path, reason });
  };

  const tocText = Buffer.from(input.toc).toString('utf8');
  const addonVersion = /^## Version:\s*(.+?)\s*$/m.exec(tocText)?.[1] ?? null;
  const dataset: DecodedDataset = {
    decoderVersion: DECODER_VERSION,
    datasetId: input.datasetId,
    archiveSha256: input.archiveSha256,
    addonVersion,
    pack: { version: null, build: null, hash: null, site: null },
    files,
    skippedCount: 0,
    skips,
    recipes: Object.create(null),
    trainers: [],
    names: Object.create(null),
    records,
  };

  for (const [file, spec] of Object.entries(DATA_FILES)) {
    const parsed = input.parsed.get(file);
    if (!parsed) {
      files[file] = { status: 'missing' };
      if (spec.required) throw new DecodeError('required_file_missing', `${file} is missing`);
      continue;
    }
    if ('error' in parsed) {
      files[file] = { status: 'skipped_file', reason: parsed.error };
      if (spec.required) throw new DecodeError('required_file_invalid', `${file}: ${parsed.error}`);
      continue;
    }
    const { tables, conflicts } = tablesOf(parsed);
    const before = skippedCount;
    for (const s of parsed.skips as ParseSkip[]) skip(spec.type, `Data/${file}#${s.path}`, s.reason);
    for (const c of conflicts) skip(spec.type, `Data/${file}#${c}`, 'duplicate_assignment');
    let count = 0;

    switch (spec.type) {
      case 'pack': {
        const pack = tables.pack;
        if (!isObject(pack)) throw new DecodeError('required_file_invalid', 'Pack.lua has no pack table');
        dataset.pack = { version: str(pack.version), build: str(pack.build), hash: str(pack.hash), site: str(pack.site) };
        addRecord({ type: 'pack', recordKey: 'pack', sourcePath: 'Data/Pack.lua#pack', fields: pack, limitations: [] });
        count = 1;
        break;
      }
      case 'recipes': {
        const all = tables.recipes;
        if (!isObject(all)) throw new DecodeError('required_file_invalid', 'Recipes.lua has no recipes table');
        for (const [profession, list] of Object.entries(all)) {
          if (!isObject(list)) {
            skip('recipes', `Data/Recipes.lua#recipes[${JSON.stringify(profession)}]`, 'unsupported_format');
            continue;
          }
          for (const [spellKey, line] of Object.entries(list)) {
            const path = `Data/Recipes.lua#recipes[${JSON.stringify(profession)}][${spellKey}]`;
            const recipe = typeof line === 'string' ? decodeRecipe(profession, spellKey, line) : 'not_a_string';
            if (typeof recipe === 'string') {
              skip('recipes', path, `unsupported_format:${recipe}`);
              continue;
            }
            if (spellKey in dataset.recipes) {
              skip('recipes', path, 'unsupported_format:duplicate_spell');
              continue;
            }
            dataset.recipes[spellKey] = recipe;
            addRecord({ type: 'recipes', recordKey: spellKey, sourcePath: path, fields: recipe as unknown as LiteralValue, limitations: recipe.limitations });
            count++;
          }
        }
        break;
      }
      case 'trainers': {
        const all = tables.trainers;
        if (!isObject(all)) throw new DecodeError('required_file_invalid', 'Trainers.lua has no trainers table');
        for (const [kind, groups] of [['class', all.class], ['prof', all.prof]] as const) {
          if (!isObject(groups)) {
            skip('trainers', `Data/Trainers.lua#trainers.${kind}`, 'unsupported_format');
            continue;
          }
          for (const [groupKey, rows] of Object.entries(groups)) {
            if (!Array.isArray(rows)) {
              skip('trainers', `Data/Trainers.lua#trainers.${kind}[${JSON.stringify(groupKey)}]`, 'unsupported_format');
              continue;
            }
            const group = kind === 'class' ? { classToken: groupKey, profession: null } : { classToken: null, profession: groupKey };
            rows.forEach((row, i) => {
              const path = `Data/Trainers.lua#trainers.${kind}[${JSON.stringify(groupKey)}][${i + 1}]`;
              const trainer = decodeTrainer(row, group);
              if (typeof trainer === 'string') {
                skip('trainers', path, `unsupported_format:${trainer}`);
                return;
              }
              dataset.trainers.push(trainer);
              addRecord({
                type: 'trainers',
                recordKey: `${kind}/${groupKey}/${trainer.npcId}`,
                sourcePath: path,
                fields: trainer as unknown as LiteralValue,
                limitations: trainer.limitations,
              });
              count++;
            });
          }
        }
        if (isObject(all.cont)) {
          addRecord({ type: 'trainers', recordKey: 'cont', sourcePath: 'Data/Trainers.lua#trainers.cont', fields: all.cont, limitations: [] });
        }
        break;
      }
      case 'search': {
        const text = str(tables.names);
        if (text === null) {
          files[file] = { status: 'skipped_file', reason: 'no names string' };
          continue;
        }
        const decoded = decodeNames(text);
        dataset.names = decoded.names;
        for (let i = 0; i < decoded.skipped; i++) skip('search', 'Data/Search.lua#names', 'unsupported_format:line');
        for (const [itemId, name] of Object.entries(decoded.names)) {
          addRecord({ type: 'search', recordKey: itemId, sourcePath: `Data/Search.lua#names:${itemId}`, fields: name, limitations: [] });
          count++;
        }
        break;
      }
      default: {
        // Original literal structure: each root table element is a record.
        for (const [table, value] of Object.entries(tables)) {
          const entries: [string, LiteralValue][] = Array.isArray(value)
            ? value.map((v, i) => [String(i + 1), v])
            : isObject(value)
              ? Object.entries(value)
              : [['value', value]];
          for (const [key, fields] of entries) {
            addRecord({
              type: spec.type,
              recordKey: `${table}/${key}`,
              sourcePath: `Data/${file}#${table}[${JSON.stringify(key)}]`,
              fields,
              limitations: ['raw_literal'],
            });
            count++;
          }
        }
      }
    }
    files[file] = { status: 'decoded', records: count, skipped: skippedCount - before };
    if (spec.type === 'recipes' || spec.type === 'trainers') {
      const skipped = skippedCount - before;
      if (skipped > 0 && skipped / (count + skipped) > MAX_SKIPPED_SHARE) {
        throw new DecodeError('too_many_skipped', `${file}: ${skipped} of ${count + skipped} records skipped`);
      }
    }
  }
  for (const file of input.parsed.keys()) {
    if (!(file in DATA_FILES) && !SKIPPED_FILES.includes(file)) files[file] = { status: 'skipped_file', reason: 'unknown_file' };
  }
  dataset.skippedCount = skippedCount;
  return dataset;
}
