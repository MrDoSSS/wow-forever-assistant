import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSelectedArchive } from '../bridge/src/sources/shared/archive.js';
import { decodeForeverDataset } from '../bridge/src/sources/foreverdb/decode.js';
import { parseDataFile, parseLiteral } from '../bridge/src/sources/foreverdb/parse.js';
import { buildIndex } from '../bridge/src/sources/foreverdb/search.js';
import { ForeverDBSource } from '../bridge/src/sources/foreverdb/tools.js';
import { foreverdbZip, minimalForeverDBData } from './foreverdb-fixture.js';

async function decoded(overrides: Record<string, string | null> = {}) {
  const { files } = await readSelectedArchive(foreverdbZip(minimalForeverDBData(overrides)), { root: '', select: () => true });
  return decodeForeverDataset({ datasetId: 'a'.repeat(32), archiveSha256: 'b'.repeat(64), files });
}
describe('ForeverDB packaged reference', () => {
  it('retains recipes without a created item and keeps unknown learning requirements unknown', async () => {
    const d = await decoded({ 'Recipes.lua': 'local _, ns = ...\nns.recipes={Enchanting={{7418,"An Enchantment",1,20,22,25,0,0,"10940:2","a",0,0},{999,"Unknown Recipe",0,20,22,25,1000,1,"4470:1","",0,1}}}' });
    assert.equal(d.recipes['7418']!.outputItemId, null);
    assert.equal(d.recipes['7418']!.outputCount, 1);
    assert.equal(d.recipes['999']!.learn, null);
    assert.equal(d.skippedCount, 0);
  });
  it('exposes packaged profession learning fees on their recipe without upgrading provenance', async () => {
    const d = await decoded({ 'ForeverDB_Helper/Data/Professions.lua': 'local _, ns = ...\nns.profSrc={enchanting=[=[return {a={steps={{s=14293,L={how="t",cost=50,tr={1317}}}}}}]=]}\nns.profs={enchanting={n="Enchanting"}}' });
    const source = new ForeverDBSource(d, buildIndex(d));
    const recipe = source.getRecipe(14293).data as unknown as { trainingSources: { costCopper: number; provenance: string; side: string }[] };
    assert.equal(recipe.trainingSources[0]!.costCopper, 50);
    assert.equal(recipe.trainingSources[0]!.side, 'alliance');
    assert.equal(recipe.trainingSources[0]!.provenance, 'packaged_profession_guide');
  });
  it('filters gear by requested level before the shared 30-candidate field limit', async () => {
    const high = Array.from({ length: 35 }, (_, i) => (1000+i).toString(36).padStart(4,'0')+'Yzz').join('');
    const low = (11287).toString(36).padStart(4,'0')+'501';
    const d = await decoded({ 'ForeverDB_Helper/Data/Gear.lua': `local _, ns = ...\nns.gearLadder={['9:1:lvl']={ranged='${high+low}'}}` });
    const source = new ForeverDBSource(d, buildIndex(d));
    const record = source.getGameRecord('bis', 'WARLOCK/1/lvl/ranged/level/5');
    const fields = record.data!.fields as { candidates: { itemId: number; minLevel: number }[]; slot: string };
    assert.deepEqual(fields.candidates.map(x => x.itemId), [11287]);
    assert.equal(fields.candidates[0]!.minLevel, 5);
    assert.equal(fields.slot, 'ranged');
    assert.equal(source.getGameRecord('bis', 'WARLOCK/1/lvl/ranged/level/99').status, 'not_found');
  });
  it('rejects executable Lua, including code hidden in lazy-loaded guide strings', async () => {
    assert.throws(() => parseDataFile(Buffer.from('local _, ns = ...\nns.meta=os.execute("never")')), /CallExpression/);
    assert.throws(() => parseLiteral('return (function() return {} end)()'), /CallExpression/);
    await assert.rejects(decoded({ 'ForeverDB_Helper/Data/Professions.lua': 'local _, ns = ...\nns.profSrc={alchemy=[=[return os.execute("never")]=]}' }), /CallExpression/);
  });
  it('rejects ambiguous top-level assignments rather than silently replacing reference data', async () => {
    await assert.rejects(decoded({ 'Meta.lua': 'local _, ns = ...\nns.meta={version="v1",build="1"}\nns.meta={version="v2",build="2"}' }), /duplicate assignment/);
  });
});
