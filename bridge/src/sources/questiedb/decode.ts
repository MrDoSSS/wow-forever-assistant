import { inflateSync } from 'node:zlib';
import luaparse from 'luaparse';
import { parseSavedVariables } from '../forevermaster/parse.js';
import { decodeCbor, objectOf, QuestieDataError, type DataValue } from './cbor.js';

export const QUESTIE_DECODER_VERSION = 1;
export const ENTITY_TYPES = ['quest', 'npc', 'item', 'object'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const ENTITY_PREFIX: Record<EntityType, string> = { quest: 'Quest', npc: 'Npc', item: 'Item', object: 'Object' };
export interface QuestieEntity {
  type: EntityType;
  id: number;
  name: string;
  /** Search aliases; the English client name remains the display name. */
  localizedNames: string[];
  fields: Record<string, DataValue>;
}
export interface AreaMap { uiMapId: number; name: string }
export interface QuestieDataset {
  decoderVersion: number;
  datasetId: string;
  archiveSha256: string;
  version: string;
  buildCommit: string | null;
  sourceUrl: string;
  entities: Record<EntityType, Record<string, QuestieEntity>>;
  areas: Record<string, AreaMap>;
  npcFlags: Record<string, number>;
  limitations: string[];
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = (message: string): never => { throw new QuestieDataError('unsupported_format', message); };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Read a named literal table from the Lua AST; never evaluate its surrounding code. */
function literalField(bytes: Uint8Array, name: string, within?: string, optional = false): Record<string, DataValue> {
  const source = Buffer.from(bytes).toString('latin1');
  let nodes = 0;
  const ast = luaparse.parse(source, {
    luaVersion: '5.1', ranges: true, comments: false,
    onCreateNode: () => { if (++nodes > 100_000) fail('schema AST limit exceeded'); },
  } as Partial<luaparse.Options>);
  const matches: luaparse.TableConstructorExpression[] = [];
  function visit(value: unknown, inside: boolean, depth: number): void {
    if (depth > 48) fail('schema nesting limit exceeded');
    if (Array.isArray(value)) { for (const child of value) visit(child, inside, depth + 1); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as luaparse.Node;
    if (node.type === 'TableKeyString' && node.key.name === (inside ? name : within) && node.value.type === 'TableConstructorExpression') {
      if (inside) { matches.push(node.value); return; }
      visit(node.value, true, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'range') visit(child, inside, depth + 1);
  }
  visit(ast, within === undefined, 0);
  if (optional && matches.length === 0) return Object.create(null);
  if (matches.length !== 1) fail(`expected one literal ${within ? `${within}.` : ''}${name} table`);
  const range = (matches[0]! as luaparse.TableConstructorExpression & { range: [number, number] }).range;
  const parsed = parseSavedVariables(Buffer.from(`Value = ${source.slice(range[0], range[1])}`, 'latin1'), ['Value']);
  if (parsed.skips.length) fail(`invalid literal ${name} table`);
  return objectOf(parsed.values.Value, name);
}

/** Parse direct map relationships only: descendant mappings do not reproject coordinates. */
function areaMaps(bytes: Uint8Array): Record<string, AreaMap> {
  const source = utf8.decode(bytes);
  const block = /ZoneDB\.private\.areaIdToUiMapId\s*=\s*\[\[return\s*\{([\s\S]*?)\}\]\]/.exec(source);
  if (!block) fail('missing Forever area mapping');
  const result: Record<string, AreaMap> = Object.create(null);
  for (const line of block![1]!.split('\n')) {
    const match = /^\s*\[(\d+)\]\s*=\s*(\d+),?\s*--\s*(.+?)\s*$/.exec(line);
    if (!match || match[3]!.includes('->')) continue;
    const areaId = match[1]!;
    if (result[areaId]) fail('duplicate direct area mapping');
    result[areaId] = { uiMapId: Number(match[2]), name: match[3]! };
  }
  if (!Object.keys(result).length) fail('no direct Forever area mappings');
  return result;
}

export function decodeQuestieDataset(
  files: Map<string, Uint8Array>,
  metadata: { datasetId: string; archiveSha256: string; sourceUrl: string },
): QuestieDataset {
  const file = (path: string): Uint8Array => files.get(`QuestieDB/${path}`) ?? fail(`missing ${path}`);
  const toc = files.get('QuestieDB/QuestieDB_Forever.toc') ?? file('QuestieDB_Camelot.toc');
  const alias = files.get('QuestieDB/QuestieDB_Camelot.toc');
  if (alias && !Buffer.from(alias).equals(Buffer.from(toc))) fail('Forever and Camelot TOCs differ');
  const headers = new Map<string, string>();
  for (const line of utf8.decode(toc).split(/\r?\n/)) {
    const match = /^##\s+([^:]+):\s?(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (headers.has(key)) fail(`duplicate TOC metadata ${key}`);
    headers.set(key, match[2]!.trim());
  }
  if (headers.get('x-flavor') !== 'Forever' || headers.get('x-mode') !== 'baked' || headers.get('x-contract-version') !== '4') {
    fail('expected a baked Forever artifact with QuestieDB contract 4');
  }
  const version = headers.get('version');
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) fail('missing or invalid QuestieDB version');
  function stored(key: string): string | undefined {
    key = key.toLowerCase();
    const value = headers.get(key);
    if (value === undefined) return undefined;
    const chunks = /^~(\d+)~$/.exec(value);
    if (!chunks) return value;
    const count = Number(chunks[1]);
    if (count < 1 || count > 20_000) fail('invalid metadata chunk count');
    return Array.from({ length: count }, (_, i) => headers.get(`${key}-${i + 1}`) ?? fail(`missing ${key} chunk ${i + 1}`)).join('');
  }
  function value(key: string, compressed = false): DataValue {
    const text = stored(key) ?? fail(`missing ${key}`);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text) || text.length === 0) fail(`invalid base64 at ${key}`);
    const bytes = Buffer.from(text, 'base64');
    try { return decodeCbor(compressed ? inflateSync(bytes, { maxOutputLength: 16 * 1024 * 1024 }) : bytes); }
    catch (error) { if (error instanceof QuestieDataError) throw error; return fail(`invalid compressed data at ${key}`); }
  }
  const entities = Object.fromEntries(ENTITY_TYPES.map((type) => [type, Object.create(null)])) as QuestieDataset['entities'];
  for (const type of ENTITY_TYPES) {
    const prefix = `X-${ENTITY_PREFIX[type]}-`;
    const schemaFile = file(`src/meta/${type}Meta.lua`);
    const keys = literalField(schemaFile, 'keys');
    const types = literalField(schemaFile, 'types');
    const constants = literalField(schemaFile, 'constantValues', undefined, true);
    const indices = Object.values(keys);
    if (indices.some((v) => !integer(v) || v < 1 || v > 48) || new Set(indices).size !== indices.length || keys.name !== 1) fail(`invalid ${type} schema keys`);
    const ids = value(`${prefix}IDS`, true);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500_000 || ids.some((id, i) => !integer(id) || id < 1 || (i > 0 && Number(ids[i - 1]) >= id))) fail(`invalid ${type} ID list`);
    const idList = ids as number[];
    const russian = stored(`X-l10n-ruRU-${ENTITY_PREFIX[type]}`) === undefined ? null : value(`X-l10n-ruRU-${ENTITY_PREFIX[type]}`, true);
    if (russian !== null && !Array.isArray(russian)) fail('invalid localization block');
    const localized = Array.isArray(russian) && Array.isArray(russian[0]) ? russian[0] : [];
    for (let position = 0; position < idList.length; position++) {
      const id = idList[position]!;
      const row = objectOf(value(`${prefix}${id}-S`), `${type}/${id}`);
      const presence = row.p ?? 0;
      if (!integer(presence)) fail('invalid table presence mask');
      const fields: Record<string, DataValue> = Object.create(null);
      for (const [name, index] of Object.entries(keys)) {
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) fail('invalid schema field name');
        const fieldIndex = Number(index);
        const fieldType = types[String(fieldIndex)];
        if (!['number', 'string', 'table'].includes(String(fieldType))) fail(`unsupported field type for ${name}`);
        let field = constants[String(fieldIndex)] ?? row[String(fieldIndex)];
        if (fieldType === 'table') {
          field = Math.floor(Number(presence) / 2 ** (fieldIndex - 1)) % 2 === 1 ? value(`${prefix}${id}-${fieldIndex}`) : undefined;
        }
        if (field === undefined || field === null) continue;
        if ((fieldType === 'table' && typeof field !== 'object') || (fieldType !== 'table' && typeof field !== fieldType)) fail(`invalid ${type}/${id}.${name}`);
        fields[name] = field;
      }
      const name = typeof fields.name === 'string' ? fields.name : `${ENTITY_PREFIX[type]} #${id}`;
      entities[type][String(id)] = { type, id, name, fields, localizedNames: typeof localized[position] === 'string' ? [localized[position] as string] : [] };
    }
    // Extra scalar rows indicate an inconsistent ID header instead of valid partial data.
    const count = [...headers.keys()].filter((key) => new RegExp(`^${prefix.toLowerCase()}\\d+-s$`).test(key)).length;
    if (count !== idList.length) fail(`${type} ID header and scalar rows disagree`);
  }
  const flags = literalField(file('src/corrections/enum/expansions.lua'), 'npcFlags', 'Forever');
  if (Object.values(flags).some((flag) => !integer(flag)) || flags.AUCTIONEER !== 4096 || flags.VENDOR !== 4) fail('unsupported Forever NPC flags');
  return {
    ...metadata, decoderVersion: QUESTIE_DECODER_VERSION, version: version!, buildCommit: headers.get('x-build-commit') ?? null,
    entities, areas: areaMaps(file('support/Forever/Zones/areaIdToUiMapId.lua')), npcFlags: flags as Record<string, number>,
    limitations: [
      'questiedb_snapshot: packaged Forever data; missing records do not prove absence from the game',
      'static_data: character-dependent Lua corrections, quest availability and current vendor stock are not evaluated',
      'item_stats: use lookup_items for authoritative item stats from the Forever client',
      'unnamed_records: an entity without a packaged name is labeled by type and ID',
      'map_coordinates: only direct area-to-map relationships are used; dungeon and descendant coordinates are not reprojected',
    ],
  };
}
