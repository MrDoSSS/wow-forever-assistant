// Handwritten format samples, not an extracted addon or a snapshot of its database.
// A few game IDs/names are shared with the craft/tool tests; all bulk rows are invented.
// Tests and diagnostics generate the ZIP in memory and never download game data.
import { forevermasterZip, minimalData, recipesLua } from './zip-writer.js';

export function syntheticForeverMasterArchive(): Uint8Array {
  const names: Record<string, string> = {
    118: 'Minor Healing Potion', 159: 'Refreshing Spring Water', 11287: 'Lesser Magic Wand',
    4470: 'Simple Wood', 10938: 'Lesser Magic Essence', 10940: 'Strange Dust',
    4345: 'Pattern: Red Woolen Boots', 4307: 'Heavy Linen Gloves', 2568: 'Brown Linen Vest',
  };
  // Enough matching names and trainers to exercise a second page of results.
  for (let i = 0; i < 105; i++) names[String(910000 + i)] = `Synthetic Material ${i}`;
  let previousId = 0;
  const encodedNames = Object.entries(names).sort(([a], [b]) => Number(a) - Number(b)).map(([id, name]) => {
    const itemId = Number(id);
    const delta = itemId - previousId;
    previousId = itemId;
    return `${delta.toString(36)} ${name}`;
  }).join('\n');
  const druidTrainers = Array.from({ length: 101 }, (_, i) =>
    `{ ${920000 + i}, "Synthetic Druid Trainer ${i}", "A", 1453, 40, 60, 1415, 40, 60 }`,
  ).join(',\n');
  const init = 'ForeverMasterData = ForeverMasterData or {}\n';
  const data = minimalData({
    'Pack.lua': `${init}ForeverMasterData.pack = { version = "synthetic-v1", hash = "synthetic", build = "0.0.0.1", site = "https://example.test/forevermaster" }\n`,
    'Recipes.lua': recipesLua({
      Enchanting: { '14293': '10|75||115|11287||||4470,10938', '7418': '1|70||110|||||10940:2,10938' },
      Tailoring: { '2387': '1|30||50|2568|1|||2996:3,2320', '3915': '10|45||70|4307|2|4345|n|2996,2320:2,2996' },
      Engineering: { '900001': '1|10|15|20|900002|1|||910000:2' },
    }),
    'Trainers.lua': `${init}ForeverMasterData.trainers = {
 cont = {},
 class = { DRUID = { ${druidTrainers} } },
 prof = {
  Enchanting = {
   { 1317, "Lucan Cordell", "A", 1453, 52.9, 74.4, 1415, 43.2, 69.6 },
   { 900101, "Synthetic Ironforge Trainer", "A", 1455, 30, 40, 1415, 40, 60 },
   { 900102, "Synthetic Horde Trainer", "H", 1420, 50, 60, 1415, 40, 60 }
  },
  Engineering = { { 900103, "Synthetic Neutral Trainer", "", 1452, 50, 60, 1414, 40, 60 } }
 }
}\n`,
    'Search.lua': `${init}ForeverMasterData.names = [==[\n${encodedNames}\n]==]\n`,
    'Items.lua': `${init}ForeverMasterData.items = { [118] = "|test|Synthetic item note" }\n`,
    'Dungeons.lua': `${init}ForeverMasterData.dungeons = { { id = "synthetic-dungeon", name = "Synthetic Dungeon", levels = { 1, 5 } } }\n`,
    'Journal.lua': `${init}ForeverMasterData.maps = { ["synthetic-dungeon"] = { floors = { { pins = { { "Synthetic Boss", 40, 60 } } } } } }\n`,
    'Leveling.lua': `${init}ForeverMasterData.leveling = { Alchemy = { slug = "alchemy", advice = { "Synthetic advice" } }, ids = { [118] = "Synthetic Potion" } }\n`,
    'Professions.lua': `${init}ForeverMasterData.professions = { Enchanting = { slug = "enchanting", learn = { [14293] = 10 } } }\n`,
    'Training.lua': `${init}ForeverMasterData.training = { MAGE = { { name = "Synthetic Spell", ranks = { { 930001, 1 } } } } }\n`,
    'Talents.lua': `${init}ForeverMasterData.talents = { MAGE = { { level = 10, name = "Synthetic Build", code = "1--" } } }\n`,
    'Bis.lua': `${init}ForeverMasterData.bis = { MAGE = { name = "Synthetic Gear", items = { 11287 } } }\n`,
    'Rewards.lua': `${init}ForeverMasterData.reputation = { items = { [900002] = { "synthetic-faction", "Friendly", 10 } } }\n`,
    'Prices.lua': `${init}ForeverMasterData.prices = {}\n`,
  });
  return forevermasterZip(data, [
    // Import must ignore addon code rather than executing it.
    { name: 'ForeverMaster/Core.lua', data: 'error("synthetic addon code must never execute")\n' },
  ], { compress: true });
}
