// Small synthetic baked artifact. Uses an independent CBOR encoder so tests exercise
// the actual TOC/base64/zlib format without bundling a third-party database.
import { deflateSync } from 'node:zlib';
import { makeZip, type ZipEntry } from './zip-writer.js';

export function cbor(value: unknown): Buffer {
  const head = (major: number, size: number): Buffer => {
    if (size < 24) return Buffer.from([(major << 5) | size]);
    if (size <= 255) return Buffer.from([(major << 5) | 24, size]);
    const bytes = size <= 65535 ? 2 : size <= 0xffffffff ? 4 : 8;
    const out = Buffer.alloc(bytes + 1);
    out[0] = (major << 5) | ({ 2: 25, 4: 26, 8: 27 }[bytes]!);
    if (bytes === 8) out.writeBigUInt64BE(BigInt(size), 1);
    else out.writeUIntBE(size, 1, bytes);
    return out;
  };
  if (value === null) return Buffer.from([246]);
  if (typeof value === 'boolean') return Buffer.from([value ? 245 : 244]);
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return head(value >= 0 ? 0 : 1, value >= 0 ? value : -value - 1);
    const out = Buffer.alloc(9); out[0] = 251; out.writeDoubleBE(value, 1); return out;
  }
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(2, bytes.length), bytes]); }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = Object.entries(value as object);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, field]) => [cbor(/^\d+$/.test(key) ? Number(key) : key), cbor(field)])]);
}

const schema = (fields: Record<string, [number, string]>) => `local _, DB = ...
local meta = {
  keys = { ${Object.entries(fields).map(([name, [index]]) => `["${name}"]=${index}`).join(',')} },
  types = { ${Object.values(fields).map(([index, type]) => `[${index}]="${type}"`).join(',')} },
  constantValues = {},
}
return meta
`;

export function questieFiles(options: { version?: string; many?: number; chunked?: boolean } = {}): Map<string, Uint8Array> {
  const version = options.version ?? '1.0.9';
  const headers = new Map<string, string>([
    ['Version', version], ['X-Mode', 'baked'], ['X-Flavor', 'Forever'], ['X-Contract-Version', '4'],
  ]);
  const set = (key: string, value: unknown, compressed = false) => {
    const bytes = cbor(value);
    headers.set(key, (compressed ? deflateSync(bytes) : bytes).toString('base64'));
  };
  const rows: Record<string, Record<number, Record<string, unknown> | unknown[]>> = {
    Quest: { 2: { 1: 'A Test Quest', 4: 10, p: 2 ** 1 + 2 ** 11 + 2 ** 12 }, 3: ['An Array Row', null, null, 12] },
    Npc: {
      54: { 1: 'Test Vendor', 13: 'A', 15: 4, p: 64 },
      8670: { 1: 'Auctioneer Chilton', 13: 'A', 15: 4096, p: 64 },
      9856: { 1: 'Auctioneer Grimful', 13: 'H', 15: 4096, p: 64 },
    },
    Item: { 4470: { 1: 'Simple Wood', 16: 1234, p: 2 ** 13 } },
    Object: { 142075: { 1: 'Mailbox', 6: 12, p: 8 } },
  };
  for (let i = 0; i < (options.many ?? 0); i++) rows.Npc![10000 + i] = { 1: `Auctioneer Extra ${i}`, 13: 'A', 15: 4096, p: 64 };
  for (const [type, entities] of Object.entries(rows)) {
    const ids = Object.keys(entities).map(Number).sort((a, b) => a - b);
    set(`X-${type}-IDS`, ids, true);
    for (const id of ids) set(`X-${type}-${id}-S`, entities[id]);
    set(`X-l10n-ruRU-${type}`, [ids.map((id) => type === 'Item' ? '\u041f\u0440\u043e\u0441\u0442\u0430\u044f \u0434\u0440\u0435\u0432\u0435\u0441\u0438\u043d\u0430' : `${type} translation ${id}`)], true);
  }
  set('X-Quest-2-2', [[54]]);
  set('X-Quest-2-12', [10, 11]);
  set('X-Quest-2-13', [20, 21]);
  set('X-Item-4470-14', [54]);
  set('X-Npc-54-7', { 12: [[42, 65]], 1519: [[61, 72]], 209: [[30, 40]], 87: [[5, 6]] });
  set('X-Npc-8670-7', { 1519: [[60.85, 71.52]] });
  set('X-Npc-9856-7', { 1637: [[55.25, 61.79]] });
  set('X-Object-142075-4', { 12: [[42.92, 65.52]], 1519: [[36.8, 69.17]] });
  for (let i = 0; i < (options.many ?? 0); i++) set(`X-Npc-${10000 + i}-7`, { 1519: [[40 + i / 10, 50]] });
  if (options.chunked) {
    const key = 'X-Object-142075-4';
    const encoded = headers.get(key)!;
    headers.set(key, '~2~');
    headers.set(`${key}-1`, encoded.slice(0, 10));
    headers.set(`${key}-2`, encoded.slice(10));
  }
  const text: Record<string, string> = {
    'QuestieDB_Forever.toc': [...headers].map(([key, value]) => `## ${key}: ${value}`).join('\n'),
    'src/meta/questMeta.lua': schema({ name: [1, 'string'], startedBy: [2, 'table'], requiredLevel: [4, 'number'], preQuestGroup: [12, 'table'], preQuestSingle: [13, 'table'] }),
    'src/meta/npcMeta.lua': schema({ name: [1, 'string'], spawns: [7, 'table'], friendlyToFaction: [13, 'string'], npcFlags: [15, 'number'] }),
    'src/meta/itemMeta.lua': schema({ name: [1, 'string'], vendors: [14, 'table'], teachesSpell: [16, 'number'] }),
    'src/meta/objectMeta.lua': schema({ name: [1, 'string'], spawns: [4, 'table'], factionID: [6, 'number'] }),
    'src/corrections/enum/expansions.lua': 'local enum = { Forever = { npcFlags = { AUCTIONEER=4096, VENDOR=4, BANKER=256, TRAINER=16 } } }',
    'support/Forever/Zones/areaIdToUiMapId.lua': `ZoneDB.private.areaIdToUiMapId = [[return {
      [12] = 1429, -- Elwynn Forest
      [1519] = 1453, -- Stormwind City
      [1637] = 1454, -- Orgrimmar
      [87] = 1429, -- Goldshire -> Elwynn Forest
    }]]`,
  };
  return new Map(Object.entries(text).map(([name, data]) => [`QuestieDB/${name}`, Buffer.from(data)]));
}

export function questieZip(options: Parameters<typeof questieFiles>[0] = {}, extra: ZipEntry[] = []): Uint8Array {
  return makeZip([...questieFiles(options)].map<ZipEntry>(([name, data]) => ({ name, data })).concat(extra));
}
