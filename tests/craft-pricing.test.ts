import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceObservation } from '../bridge/src/contracts.js';
import { calculateCraft } from '../bridge/src/domain/crafting.js';
import { planCraft } from '../bridge/src/domain/craft-plan.js';
import { chooseCraftPrice, purchasePrice, type VendorPriceQuote } from '../bridge/src/domain/pricing.js';
import { decodeForeverDataset } from '../bridge/src/sources/foreverdb/decode.js';
import { buildIndex } from '../bridge/src/sources/foreverdb/search.js';
import { ForeverDBSource } from '../bridge/src/sources/foreverdb/tools.js';
import { vendorPrices } from '../bridge/src/sources/pricing.js';
import { FOREVERDB_TOC, minimalForeverDBData } from './foreverdb-fixture.js';

const market = 'auctionator:test';
const quote = (overrides: Partial<VendorPriceQuote> = {}): VendorPriceQuote => ({
  datasetId: 'a'.repeat(32), recordKey: 'items/4470', npcId: 1317, npcName: 'Test Supplier', zoneName: 'Stormwind City',
  priceCopper: 38, stack: 1, limitedStock: 0, priceSource: 'unknown', limitations: [], ...overrides,
});
const observation = (itemId: number, priceCopper: number | null, marketKey = market): PriceObservation => ({
  item: { itemId, itemLink: null }, marketKey, unit: 'per_item', priceCopper,
  readOriginSessionId: 'b'.repeat(32), readAtSessionMs: 1000, sourceObservedAtMs: null,
  ageDays: 0, agePrecision: 'day_bucket', rawExactness: true, exactness: 'exact',
  source: 'auctionator_v1', sourceVersion: 'test', unavailableReason: priceCopper === null ? 'no_price' : null,
});

function vendorFixture(): Record<string, string> {
  const data = minimalForeverDBData();
  data['NPCs.lua'] = data['NPCs.lua']!.replace('ns.sold={}', 'ns.sold={[4470]={1317,38,1,0,4213,1,1,0},[10938]={1317,800,1,2}}');
  data['Items.lua'] = 'local _, ns = ...\nns.items={[4470]="v1~Test Supplier~Stormwind City~1",[10940]="u1"}';
  data['ForeverDB_Helper/Data/Professions.lua'] = 'local _, ns = ...\nns.profPrices={[2320]={10,20,0},[2321]={0,30,0}}';
  return data;
}

function source() {
  const files = new Map(Object.entries(vendorFixture()).map(([path, value]) => [path.includes('/') ? path : `ForeverDB/Data/${path}`, Buffer.from(value)]));
  const dataset = decodeForeverDataset({ datasetId: 'a'.repeat(32), archiveSha256: 'b'.repeat(64), files, toc: Buffer.from(FOREVERDB_TOC) });
  return new ForeverDBSource(dataset, buildIndex(dataset));
}

describe('vendor purchase prices for crafting', () => {
  it('prices wood and limited-stock essence without Auctionator in both craft calculations', () => {
    const db = source();
    const recipe = db.dataset.recipes['14293']!;
    const prices = new Map(recipe.reagents.map(({ itemId }) => [itemId, chooseCraftPrice(itemId, [observation(itemId, null)], market, vendorPrices(db, null, itemId, { faction: 'alliance', zoneName: 'Stormwind City' }))]));
    const calc = calculateCraft({ recipe, desiredQuantity: 3, inventory: { scope: 'none' }, prices });
    assert.equal(calc.priceTotalCopper, 3 * (38 + 800));
    assert.deepEqual(calc.unpricedItemIds, []);
    assert.deepEqual(calc.prices.map((p) => [p.itemId, p.source, p.unitPriceCopper]), [[4470, 'vendor', 38], [10938, 'vendor', 800]]);
    assert.ok(calc.limitations.some((l) => l.startsWith('vendor_restock_required: item 10938')));
    assert.ok(!calc.limitations.some((l) => l.startsWith('price_unavailable')));
    const plan = planCraft({ recipe, desiredQuantity: 3, maxDepth: 3, recipesByOutput: new Map(), stock: new Map(), buyer: 'Tester', crafters: { knowledge: false, knownBy: () => [], learnableBy: () => [] }, prices });
    assert.equal(plan.totalCostCopper, calc.priceTotalCopper);
    assert.deepEqual(plan.prices.map(({ buyer: _buyer, ...price }) => price), calc.prices);
  });

  it('compares auction and vendor prices without using another market', () => {
    for (const [auction, expected, selected] of [[20, 20, 'auctionator'], [100, 38, 'vendor'], [38, 38, 'vendor']] as const) {
      const choice = chooseCraftPrice(4470, [observation(4470, auction)], market, [quote()]);
      const price = purchasePrice(4470, 3, choice);
      assert.deepEqual([price.totalCopper, price.source], [expected * 3, selected]);
      assert.equal(price.alternatives.length, 1);
      const alternative = price.alternatives[0]!;
      assert.equal(alternative.source, selected === 'vendor' ? 'auctionator' : 'vendor');
      if (alternative.source === 'vendor') {
        assert.deepEqual([alternative.unitPriceCopper, alternative.totalCopper, alternative.vendor!.npcId], [38, 114, 1317]);
      }
    }
    const wrongMarket = chooseCraftPrice(4470, [observation(4470, 1, 'other')], market, [quote()]);
    assert.equal(purchasePrice(4470, 3, wrongMarket).totalCopper, 114);
    assert.ok(!purchasePrice(4470, 3, wrongMarket).limitations.includes('other_market_only'));
    assert.equal(chooseCraftPrice(4470, [], market, [quote({ priceCopper: 0 }), quote({ stack: 0 })]).priceCopper, null);
  });

  it('charges whole vendor packs and compares the actual purchase quantity', () => {
    const choice = chooseCraftPrice(4470, [observation(4470, 30)], market, [quote({ priceCopper: 101, stack: 5 })]);
    assert.deepEqual([purchasePrice(4470, 1, choice).source, purchasePrice(4470, 1, choice).totalCopper], ['auctionator', 30]);
    const four = purchasePrice(4470, 4, choice);
    assert.deepEqual([four.source, four.purchaseQuantity, four.unitPriceCopper, four.totalCopper], ['vendor', 5, 20.2, 101]);
    assert.deepEqual([four.alternatives[0]!.source, four.alternatives[0]!.totalCopper], ['auctionator', 120]);
    assert.deepEqual([purchasePrice(4470, 6, choice).source, purchasePrice(4470, 6, choice).totalCopper], ['auctionator', 180]);
    const db = source();
    const recipe = { ...db.dataset.recipes['14293']!, reagents: [{ itemId: 4470, count: 4 }] };
    assert.equal(calculateCraft({ recipe, desiredQuantity: 1, inventory: { scope: 'none' }, prices: new Map([[4470, choice]]) }).priceTotalCopper, 101);
  });

  it('uses purchase prices when deciding whether to craft an intermediate', () => {
    const db = source();
    const intermediate = { ...db.dataset.recipes['14293']!, outputItemId: 4470, reagents: [{ itemId: 10938, count: 1 }] };
    const recipe = { ...intermediate, spellId: 9999, outputItemId: 11287, reagents: [{ itemId: 4470, count: 2 }] };
    const prices = new Map([
      [4470, chooseCraftPrice(4470, [], market, [quote()])],
      [10938, chooseCraftPrice(10938, [observation(10938, 100)], market, [])],
    ]);
    const plan = planCraft({ recipe, desiredQuantity: 1, maxDepth: 3, recipesByOutput: new Map([[4470, [intermediate]]]), stock: new Map(), buyer: 'Tester', crafters: { knowledge: false, knownBy: () => [], learnableBy: () => [] }, prices });
    assert.deepEqual(plan.steps.map((s) => s.recipeSpellId), [9999]);
    assert.equal(plan.totalCostCopper, 76);
    assert.equal(plan.prices[0]!.source, 'vendor');
  });

  it('filters opposing vendors, uses faction helper prices, and leaves unknown prices unknown', () => {
    const db = source();
    const alliance = { faction: 'alliance', zoneName: 'Stormwind City' };
    const horde = { faction: 'horde', zoneName: null };
    assert.deepEqual(vendorPrices(db, null, 4470, alliance).map((v) => v.npcId), [1317]);
    assert.deepEqual(vendorPrices(db, null, 4470, horde).map((v) => v.npcId), [4213]);
    assert.equal(vendorPrices(db, null, 10938, horde).length, 0);
    assert.equal(vendorPrices(db, null, 2320, alliance)[0]!.priceCopper, 10);
    assert.equal(vendorPrices(db, null, 2320, horde)[0]!.priceCopper, 20);
    assert.deepEqual(vendorPrices(db, null, 2321, alliance), []);
    assert.deepEqual(vendorPrices(db, null, 2320, { faction: null, zoneName: null }), []);
    assert.deepEqual(vendorPrices(null, null, 4470, alliance), []);
    // An item record or a client sell price alone cannot provide a purchase quote.
    db.dataset.itemFacts!['10940'] = { sellPriceCopper: 800 };
    assert.deepEqual(vendorPrices(db, null, 10940, alliance), []);
    const unknown = chooseCraftPrice(10940, [], market, vendorPrices(db, null, 10940, alliance));
    assert.equal(purchasePrice(10940, 1, unknown).totalCopper, null);
  });
});
