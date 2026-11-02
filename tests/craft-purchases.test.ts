import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceObservation } from '../bridge/src/contracts.js';
import { planCraft } from '../bridge/src/domain/craft-plan.js';
import { createCraftPurchaser, type PurchaseCharacter } from '../bridge/src/sources/craft-purchases.js';
import { decodeForeverDataset } from '../bridge/src/sources/foreverdb/decode.js';
import { buildIndex } from '../bridge/src/sources/foreverdb/search.js';
import { ForeverDBSource } from '../bridge/src/sources/foreverdb/tools.js';
import { decodeQuestieDataset } from '../bridge/src/sources/questiedb/decode.js';
import { QuestieSource } from '../bridge/src/sources/questiedb/tools.js';
import { FOREVERDB_TOC, minimalForeverDBData } from './foreverdb-fixture.js';
import { questieFiles } from './questiedb-fixture.js';

const current: PurchaseCharacter = { name: 'Main', faction: 'alliance', zoneName: 'Stormwind City', uiMapId: 1453, x: .6, y: .7 };
const crafter: PurchaseCharacter = { name: 'Crafter', faction: 'alliance', zoneName: 'Elwynn Forest', uiMapId: null, x: null, y: null };
const observation = (itemId: number, priceCopper: number): PriceObservation => ({ item: { itemId, itemLink: null },
  marketKey: 'auctionator:test', unit: 'per_item', priceCopper, readOriginSessionId: 'b'.repeat(32), readAtSessionMs: 1,
  sourceObservedAtMs: null, ageDays: 0, agePrecision: 'day_bucket', rawExactness: true, exactness: 'exact',
  source: 'auctionator_v1', sourceVersion: 'test', unavailableReason: null });

function references() {
  const data = minimalForeverDBData();
  data['NPCs.lua'] = data['NPCs.lua']!.replace('ns.sold={}', 'ns.sold={[4470]={1317,38,1,0},[10938]={1317,800,1,2}}');
  const files = new Map(Object.entries(data).map(([path, text]) => [path.includes('/') ? path : `ForeverDB/Data/${path}`, Buffer.from(text)]));
  const dataset = decodeForeverDataset({ files, toc: Buffer.from(FOREVERDB_TOC), datasetId: 'a'.repeat(32), archiveSha256: 'b'.repeat(64) });
  const source = new ForeverDBSource(dataset, buildIndex(dataset));
  const q = decodeQuestieDataset(questieFiles(), { datasetId: 'c'.repeat(32), archiveSha256: 'd'.repeat(64), sourceUrl: 'https://example.test/QuestieDB.zip' });
  q.entities.item['10938'] = { ...q.entities.item['4470']!, id: 10938, name: 'Lesser Magic Essence', fields: { vendors: [54] } };
  return { source, questie: new QuestieSource(q) };
}

function purchaser(refs = references(), characters = [crafter]) {
  return createCraftPurchaser({ ...refs, current, characters, observations: [observation(4470, 33), observation(10938, 1450)], expectedMarket: 'auctionator:test' });
}

describe('craft purchase convenience', () => {
  it('keeps an unpriced local vendor on the crafter and labels another vendor quote as an estimate', () => {
    const refs = references();
    const purchase = purchaser(refs);
    const wood = purchase(4470, 1, 'Crafter');
    assert.deepEqual([wood.buyer, wood.purchaseAt?.npcId, wood.local, wood.source], ['Crafter', 54, true, 'vendor']);
    assert.deepEqual([wood.unitPriceCopper, wood.priceBasis, wood.vendor, wood.referenceQuote?.npcId], [38, 'reference_estimate', null, 1317]);
    assert.ok(wood.alternatives.some((option) => option.source === 'auctionator' && option.unitPriceCopper === 33));
    const plan = planCraft({ recipe: refs.source.dataset.recipes['14293']!, desiredQuantity: 1, maxDepth: 3, recipesByOutput: new Map(),
      stock: new Map(), buyer: 'Main', crafters: { knowledge: true, knownBy: () => ['Crafter'], learnableBy: () => [] }, prices: new Map(), purchaseFor: purchase });
    assert.ok(plan.buy.every((row) => row.buyer === 'Crafter'));
    assert.equal(plan.totalCostCopper, 838);
    assert.deepEqual(plan.transfers, [{ itemId: 11287, quantity: 1, from: 'Crafter', to: 'Main' }]);
    assert.equal(plan.purchaseTotals[0]!.estimated, true);
  });

  it('uses items already owned by another character before local purchases or estimates', () => {
    const refs = references();
    const plan = planCraft({ recipe: refs.source.dataset.recipes['14293']!, desiredQuantity: 2, maxDepth: 3, recipesByOutput: new Map(),
      stock: new Map([['Bank', new Map([[4470, 2], [10938, 1]])]]), buyer: 'Main',
      crafters: { knowledge: true, knownBy: () => ['Crafter'], learnableBy: () => [] }, prices: new Map(), purchaseFor: purchaser(refs) });
    assert.deepEqual(plan.buy.map((row) => [row.itemId, row.quantity, row.buyer]), [[10938, 1, 'Crafter']]);
    assert.ok(plan.transfers.some((row) => row.itemId === 4470 && row.quantity === 2 && row.from === 'Bank' && row.to === 'Crafter'));
    assert.equal(plan.totalCostCopper, 800);
  });

  it('uses a quoted local vendor even if a remote quote or auction observation is cheaper', () => {
    const refs = references();
    refs.source.dataset.npcs!['54'] = { id: 54, name: 'Test Vendor', title: 'Supplies', uiMapId: 1429, x: 42, y: 65, faction: 'alliance', seenInForever: true };
    refs.source.dataset.vendorOffers!['4470']!.push({ itemId: 4470, npcId: 54, priceCopper: 50, stack: 1, limited: 0, source: 'unknown' });
    const wood = purchaser(refs)(4470, 1, 'Crafter');
    assert.deepEqual([wood.buyer, wood.vendor?.npcId, wood.unitPriceCopper, wood.priceBasis], ['Crafter', 54, 50, 'vendor_quote']);
    assert.ok(wood.alternatives.some((option) => option.vendor?.npcId === 1317 && option.unitPriceCopper === 38));
    assert.ok(wood.alternatives.some((option) => option.source === 'auctionator' && option.unitPriceCopper === 33));
  });

  it('keeps the local route when no vendor quote exists anywhere', () => {
    const refs = references();
    refs.source.dataset.vendorOffers!['4470'] = [];
    const wood = purchaser(refs)(4470, 1, 'Crafter');
    assert.deepEqual([wood.buyer, wood.purchaseAt?.npcId, wood.unitPriceCopper, wood.priceBasis], ['Crafter', 54, null, 'unknown']);
    assert.equal(wood.alternatives[0]!.unitPriceCopper, 33);
  });

  it('uses another local purchaser only when no local service is found for the crafter', () => {
    const remoteCrafter = { ...crafter, zoneName: 'Ironforge' };
    const wood = purchaser(references(), [remoteCrafter])(4470, 1, 'Crafter');
    assert.equal(wood.buyer, 'Main');
    assert.ok(wood.local);
    assert.ok(wood.limitations.some((line) => line.startsWith('purchase_elsewhere:')));
    const unknownZone = purchaser(references(), [{ ...crafter, zoneName: null }])(4470, 1, 'Crafter');
    assert.equal(unknownZone.buyer, 'Crafter', 'unknown location cannot justify moving a purchase to Main');
    const refs = references();
    const noQuestie = createCraftPurchaser({ source: refs.source, questie: null, current, characters: [remoteCrafter], observations: [], expectedMarket: null });
    assert.equal(noQuestie(4470, 1, 'Crafter').buyer, 'Crafter', 'missing world coverage cannot justify moving a purchase to Main');
  });

  it('does not reuse auction prices of another faction for the purchasing alt', () => {
    const wood = purchaser(references(), [{ ...crafter, faction: 'horde', zoneName: 'Orgrimmar' }])(4470, 1, 'Crafter');
    assert.deepEqual([wood.buyer, wood.purchaseAt?.npcId, wood.source, wood.totalCopper], ['Crafter', 9856, 'auctionator', null]);
  });
});
