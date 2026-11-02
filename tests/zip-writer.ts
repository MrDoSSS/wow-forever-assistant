// Minimal ZIP writer with stored and deflated entries for synthetic test archives,
// including deliberately unsafe paths, encryption, links and incorrect CRCs.
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: string | Uint8Array;
  /** Bit 0 means the entry is encrypted. */
  flags?: number;
  /** Unix attributes in the upper 16 bits; for example, 0o120777 is a symbolic link. */
  unixMode?: number;
  /** Override the CRC in headers. */
  crc?: number;
  /** Exercise ZIP method 8 as well as stored entries. */
  compress?: boolean;
}

export function makeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const packed = entry.compress ? deflateRawSync(data) : data;
    const method = entry.compress ? 8 : 0;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = entry.crc ?? crc32(data) >>> 0;
    const flags = (entry.flags ?? 0) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((entry.unixMode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

export const TOC = '## Interface: 16001\n## Title: Forever Master\n## Version: 9.9.9\nData\\Pack.lua\n';
export const PACK = 'ForeverMasterData = ForeverMasterData or {}\nForeverMasterData.pack = { version = "test", hash = "h", build = "1.0", site = "s" }\n';
export const TRAINERS =
  'ForeverMasterData = ForeverMasterData or {}\nForeverMasterData.trainers = {\n cont = {},\n class = { ["MAGE"] = { { 198, "Khelden Bremen", "A", 1429, 49.5, 41.2, 1415, 41, 65 } } },\n prof = { ["Enchanting"] = { { 1317, "Lucan Cordell", "A", 1453, 52.9, 74.4, 1415, 43.2, 69.6 }, { 4213, "Taladan", "H", 1456, 140, 20, 1414, 1, 2 } } }\n}\n';

export function recipesLua(lines: Record<string, Record<string, string>>): string {
  const body = Object.entries(lines)
    .map(([profession, recipes]) => ` ["${profession}"] = {\n${Object.entries(recipes).map(([id, line]) => `  [${id}]="${line}",`).join('\n')}\n }`)
    .join(',\n');
  return `ForeverMasterData = ForeverMasterData or {}\nForeverMasterData.recipes = {\n${body}\n}\n`;
}

export const RECIPES = recipesLua({
  Enchanting: { '14293': '10|75||115|11287||||4470,10938', '7418': '1|70||110|||||10940:2,10938' },
  Tailoring: { '2387': '1|30||50|2568|1|||2996:3,2320', '3915': '10|45||70|4307|2|4345|n|2996,2320:2,2996' },
});

export function forevermasterZip(data: Record<string, string>, extra: ZipEntry[] = [], options: { compress?: boolean } = {}): Uint8Array {
  return makeZip([
    { name: 'ForeverMaster/', data: '' },
    { name: 'ForeverMaster/ForeverMaster.toc', data: TOC },
    ...Object.entries(data).map(([file, text]) => ({ name: `ForeverMaster/Data/${file}`, data: text, compress: options.compress })),
    ...extra,
  ]);
}

export function minimalData(overrides: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    'Pack.lua': PACK,
    'Recipes.lua': RECIPES,
    'Trainers.lua': TRAINERS,
    'Search.lua': 'ForeverMasterData = ForeverMasterData or {}\nForeverMasterData.names = [==[\n3a Minor Healing Potion\n15 Refreshing Spring Water\n]==]\n',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== null));
}
