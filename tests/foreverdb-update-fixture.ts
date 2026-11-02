import { makeZip, type ZipEntry } from './zip-writer.js';

export function foreverdbFiles(options: { version?: string; name?: string; overrides?: Record<string, string | null> } = {}): Map<string, Uint8Array> {
  const version = options.version ?? '0.54.8';
  const data: Record<string, string> = {
    'ForeverDB/ForeverDB.toc': `## Interface: 16001\n## Title: ForeverDB\n## Version: ${version}\n`,
    'ForeverDB/Data/Meta.lua': `local _, ns = ...\nns.meta = {version="2026-10-31.test",build="1.60.1.70658",addon="${version}"}`,
    'ForeverDB/Data/Recipes.lua': `local _, ns = ...\nns.recipes = {Enchanting={{14293,${JSON.stringify(options.name ?? 'Lesser Magic Wand')},10,75,95,115,11287,1,"4470:1,10938:1","t",0,0}}}\nns.names = {[4470]="Simple Wood",[10938]="Lesser Magic Essence",[11287]="Lesser Magic Wand"}`,
    'ForeverDB/Data/NPCs.lua': `local _, ns = ...\nns.npcs = {[3012]={"Nata Dawnstrider","Enchanting Supplies",1456,45,38,"H",1}}\nns.profTrainers = {Enchanting={3012}}\nns.classTrainers = {}\nns.sold = {[4470]={3012,38,1,0}}\nns.soldNames = {[4470]="Simple Wood"}`,
    'ForeverDB/Data/Items.lua': 'local _, ns = ...\nns.items = {[4470]="v1~Nata Dawnstrider~Thunder Bluff~1"}',
    'ForeverDB/Data/SearchNames.lua': 'local _, ns = ...\nns.searchItemNames = {[4470]="Simple Wood",[11287]="Lesser Magic Wand"}',
    'ForeverDB/LICENSE.txt': 'ForeverDB test fixture; GPL-3.0 with attribution. Data from ForeverDB.net (https://foreverdb.net).',
    'ForeverDB/NOTICE.txt': 'Data from ForeverDB.net (https://foreverdb.net).',
    'ForeverDB/COPYING.txt': 'Synthetic GPL notice fixture.',
    'ForeverDB_Helper/LICENSE.txt': 'Synthetic helper licence fixture.',
    'ForeverDB_Helper/NOTICE.txt': 'Synthetic helper attribution fixture.',
    'ForeverDB_Helper/COPYING.txt': 'Synthetic GPL notice fixture.',
  };
  for (const [name, text] of Object.entries(options.overrides ?? {})) {
    if (text === null) delete data[name];
    else data[name] = text;
  }
  return new Map(Object.entries(data).map(([name, text]) => [name, new Uint8Array(Buffer.from(text))]));
}

export function foreverdbZip(options: Parameters<typeof foreverdbFiles>[0] = {}, extras: ZipEntry[] = []): Uint8Array {
  return makeZip([...foreverdbFiles(options)].map(([name, data]): ZipEntry => ({ name, data, compress: true })).concat(extras));
}
