// Handwritten ForeverDB format samples. No extracted addon/database is checked in.
import { makeZip, type ZipEntry } from './zip-writer.js';

const NS = 'local _, ns = ...\n';
export const FOREVERDB_TOC = '## Interface: 16001\n## Title: ForeverDB\n## Version: 0.54.8\nData\\Meta.lua\n';

export function minimalForeverDBData(overrides: Record<string, string | null> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    'Meta.lua': `${NS}ns.meta = {version="test",build="1.60.1.70658",site="https://foreverdb.net",addon="0.54.8",cap=30}\n`,
    'Recipes.lua': `${NS}ns.recipes = {
      Enchanting={{14293,"Lesser Magic Wand",10,75,95,115,11287,1,"4470:1,10938:1","t",0,0},{7418,"Enchant Bracer - Minor Health",1,70,90,110,0,1,"10940:2,10938:1","t",0,0}},
      Tailoring={{2387,"Brown Linen Vest",1,30,40,50,2568,1,"2996:3,2320:1","t",0,0},{3915,"Heavy Linen Gloves",10,45,57,70,4307,2,"2996:1,2320:2,2996:1","i4345",0,1}}
    }\nns.names = {[11287]="Lesser Magic Wand",[4470]="Simple Wood",[10938]="Lesser Magic Essence",[10940]="Strange Dust",[4345]="Pattern: Red Woolen Boots",[4307]="Heavy Linen Gloves",[2568]="Brown Linen Vest"}\n`,
    'NPCs.lua': `${NS}ns.npcs = {
      [198]={"Khelden Bremen","Mage Trainer",1429,49.5,41.2,"A",1},
      [1317]={"Lucan Cordell","Enchanting Trainer",1453,52.9,74.4,"A",1},
      [4213]={"Taladan","Enchanting Trainer",1456,140,20,"H",0}
    }\nns.classTrainers={MAGE={198}}\nns.profTrainers={Enchanting={1317,4213}}\nns.sold={}\nns.soldNames={}\n`,
    'SearchNames.lua': `${NS}ns.searchItemNames = {[118]="Minor Healing Potion",[159]="Refreshing Spring Water"}\n`,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== null));
}

/** Data filenames are relative to ForeverDB/Data, or complete paths for Helper. */
export function foreverdbZip(data = minimalForeverDBData(), extra: ZipEntry[] = [], options: { compress?: boolean } = {}): Uint8Array {
  return makeZip([
    { name: 'ForeverDB/ForeverDB.toc', data: FOREVERDB_TOC },
    { name: 'ForeverDB/LICENSE.txt', data: 'Synthetic license notice; preserve notices.\n' },
    { name: 'ForeverDB/NOTICE.txt', data: 'Synthetic source attribution.\n' },
    { name: 'ForeverDB/COPYING.txt', data: 'Synthetic copying notice.\n' },
    ...Object.entries(data).map(([file, text]) => ({ name: file.includes('/') ? file : `ForeverDB/Data/${file}`, data: text, compress: options.compress })),
    ...extra,
  ]);
}

export function syntheticForeverDBArchive(): Uint8Array {
  const names: Record<string, string> = {
    118: 'Minor Healing Potion', 159: 'Refreshing Spring Water', 11287: 'Lesser Magic Wand',
    4470: 'Simple Wood', 10938: 'Lesser Magic Essence', 10940: 'Strange Dust',
    4345: 'Pattern: Red Woolen Boots', 4307: 'Heavy Linen Gloves', 2568: 'Brown Linen Vest',
  };
  for (let i = 0; i < 105; i++) names[String(910000 + i)] = `Synthetic Material ${i}`;
  const entries = Object.entries(names).map(([id, name]) => `[${id}]=${JSON.stringify(name)}`).join(',');
  const druidIds = Array.from({ length: 101 }, (_, i) => 920000 + i);
  const druidNPCs = druidIds.map((id, i) => `[${id}]={"Synthetic Druid Trainer ${i}","Druid Trainer",1453,40,60,"A",0}`).join(',');
  const data = minimalForeverDBData({
    'Meta.lua': `${NS}ns.meta={version="synthetic-v1",build="0.0.0.1",site="https://foreverdb.net",addon="0.54.8",cap=30}\n`,
    'NPCs.lua': `${NS}ns.npcs={${druidNPCs},
      [1317]={"Lucan Cordell","Enchanting Trainer",1453,52.9,74.4,"A",1},
      [900101]={"Synthetic Ironforge Trainer","Enchanting Trainer",1455,30,40,"A",0},
      [900102]={"Synthetic Horde Trainer","Enchanting Trainer",1420,50,60,"H",0},
      [900103]={"Synthetic Neutral Trainer","Engineering Trainer",1452,50,60,"",0}}
      ns.classTrainers={DRUID={${druidIds.join(',')}}}
      ns.profTrainers={Enchanting={1317,900101,900102},Engineering={900103}}
      ns.sold={}\nns.soldNames={}\n`,
    'SearchNames.lua': `${NS}ns.searchItemNames={${entries}}\n`,
    'Items.lua': `${NS}ns.items={[118]="n|v1~Synthetic Vendor~Elwynn Forest~0"}\n`,
  });
  data['Recipes.lua'] = data['Recipes.lua']!.replace('Tailoring={{', 'Engineering={{900001,"Synthetic Component",1,10,15,20,900002,1,"910000:2","t",0,0}},Tailoring={{');
  return foreverdbZip(data, [{ name: 'ForeverDB/Core.lua', data: 'error("synthetic addon code must never execute")\n' }], { compress: true });
}
