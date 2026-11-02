import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { GameReply, itemLinkId, ModelReply, VerifiedLocation, type PriceObservation, type Snapshot, type SnapshotGroups } from '../bridge/src/contracts.js';
import { calculateCraft, CraftLimitError, type Inventory } from '../bridge/src/domain/crafting.js';
import { confirmedMapOf, verifiedLocationOf } from '../bridge/src/domain/locations.js';
import { choosePrice, type PriceChoice } from '../bridge/src/domain/pricing.js';
import { FONT_RANGES, fitFont } from '../bridge/src/domain/glyphs.js';
import { checkTextMarkers, historyTextOf } from '../bridge/src/domain/reply.js';
import { resourcePath } from '../bridge/src/paths.js';
import type { RecipeRecord } from '../bridge/src/sources/shared/types.js';

function bags(slots: [number, number][], coverage: 'complete' | 'partial' = 'complete'): Inventory {
  const value = slots.map(([itemId, count], i) => ({ bag: 0, slot: i + 1, item: { itemId, itemLink: null }, count }));
  const group =
    coverage === 'complete'
      ? { availability: 'available', coverage, observedAtSessionMs: 1, reason: null, value }
      : { availability: 'available', coverage, observedAtSessionMs: 1, reason: 'not_ready', value };
  return { scope: 'bags', bags: group as SnapshotGroups['bags'] };
}

const unavailableBags: Inventory = {
  scope: 'bags',
  bags: { availability: 'disabled', coverage: 'unknown', observedAtSessionMs: null, reason: 'user_disabled', value: null },
};

function observation(itemId: number, priceCopper: number | null, overrides: Partial<PriceObservation> = {}): PriceObservation {
  return {
    item: { itemId, itemLink: null },
    marketKey: 'forever:Forever:alliance',
    unit: 'per_item',
    priceCopper,
    readOriginSessionId: 'a'.repeat(32),
    readAtSessionMs: 1000,
    sourceObservedAtMs: null,
    ageDays: 1,
    agePrecision: 'day_bucket',
    rawExactness: true,
    exactness: 'exact',
    source: 'auctionator_v1',
    sourceVersion: '341',
    unavailableReason: priceCopper === null ? 'no_price' : null,
    ...overrides,
  };
}

const prices = (...choices: PriceChoice[]) => new Map(choices.map((c) => [c.itemId, c]));

describe('craft calculation', () => {
  // Second Linen recipe: 2 output items per craft, using 2996x2 and 2320x2.
  const linen: RecipeRecord = {spellId:3915,profession:'Tailoring',learn:10,yellow:45,green:57,grey:70,greenDerived:true,outputItemId:4307,outputCount:2,taughtByItemId:4345,status:'new',reagents:[{itemId:2996,count:2},{itemId:2320,count:2}],limitations:[]};

  it('rounds crafts up by output count and counts missing reagents from complete bags', () => {
    const result = calculateCraft({ recipe: linen, desiredQuantity: 20, inventory: bags([[2996, 7], [2320, 30], [2996, 1]]), prices: new Map() });
    assert.equal(result.crafts, 10);
    assert.deepEqual(result.lines, [
      { itemId: 2996, needed: 20, knownOwned: 8, missing: 12 },
      { itemId: 2320, needed: 20, knownOwned: 30, missing: 0 },
    ]);
    assert.equal(calculateCraft({ recipe: linen, desiredQuantity: 3, inventory: bags([]), prices: new Map() }).crafts, 2);
  });

  it('keeps known amounts but no missing for partial bags; ignores bags on request', () => {
    const partial = calculateCraft({ recipe: linen, desiredQuantity: 2, inventory: bags([[2996, 1]], 'partial'), prices: new Map() });
    assert.deepEqual(partial.lines[0], { itemId: 2996, needed: 2, knownOwned: 1, missing: null });
    assert.ok(partial.limitations.some((l) => l.startsWith('inventory_partial')));
    const none = calculateCraft({ recipe: linen, desiredQuantity: 2, inventory: { scope: 'none' }, prices: new Map() });
    assert.deepEqual(none.lines[0], { itemId: 2996, needed: 2, knownOwned: null, missing: 2 });
    const disabled = calculateCraft({ recipe: linen, desiredQuantity: 2, inventory: unavailableBags, prices: new Map() });
    assert.equal(disabled.lines[0]!.missing, null);
    assert.ok(disabled.limitations.includes('inventory_disabled'));
  });

  it('treats an effect without an output item as a number of applications', () => {
    const enchant: RecipeRecord = {...linen,spellId:7418,profession:'Enchanting',outputItemId:null,outputCount:1,reagents:[{itemId:10940,count:2},{itemId:10938,count:1}]};
    const result = calculateCraft({ recipe: enchant, desiredQuantity: 3, inventory: { scope: 'none' }, prices: new Map() });
    assert.equal(result.crafts, 3);
    assert.deepEqual(result.lines.map((l) => l.needed), [6, 3]);
  });

  it('sums known prices of missing materials and never treats unknown as zero', () => {
    const p2996 = choosePrice(2996, [observation(2996, 15)], 'forever:Forever:alliance');
    const full = calculateCraft({
      recipe: linen,
      desiredQuantity: 4,
      inventory: { scope: 'none' },
      prices: prices(p2996, choosePrice(2320, [observation(2320, 10)], 'forever:Forever:alliance')),
    });
    assert.equal(full.priceTotalCopper, 4 * 15 + 4 * 10);
    assert.deepEqual(full.unpricedItemIds, []);

    const partial = calculateCraft({ recipe: linen, desiredQuantity: 4, inventory: { scope: 'none' }, prices: prices(p2996) });
    assert.equal(partial.priceTotalCopper, 60);
    assert.deepEqual(partial.unpricedItemIds, [2320]);
    assert.ok(partial.limitations.some((l) => l.startsWith('price_total_incomplete')));

    const nothing = calculateCraft({ recipe: linen, desiredQuantity: 4, inventory: { scope: 'none' }, prices: new Map() });
    assert.equal(nothing.priceTotalCopper, null);
    assert.deepEqual(nothing.unpricedItemIds, [2996, 2320]);
  });

  it('does not price lines whose missing amount is unknown', () => {
    const result = calculateCraft({
      recipe: linen,
      desiredQuantity: 2,
      inventory: bags([], 'partial'),
      prices: prices(choosePrice(2996, [observation(2996, 15)], null), choosePrice(2320, [observation(2320, 10)], null)),
    });
    assert.equal(result.priceTotalCopper, null);
    assert.deepEqual(result.unpricedItemIds, [2996, 2320]);
  });

  it('refuses unsafe arithmetic and bad quantities', () => {
    const huge: RecipeRecord = {...linen,outputItemId:5,outputCount:1,reagents:[{itemId:7,count:Number.MAX_SAFE_INTEGER}]};
    assert.throws(() => calculateCraft({ recipe: huge, desiredQuantity: 2, inventory: { scope: 'none' }, prices: new Map() }), CraftLimitError);
    assert.throws(() => calculateCraft({ recipe: linen, desiredQuantity: 0, inventory: { scope: 'none' }, prices: new Map() }), CraftLimitError);
  });
});

describe('price semantics', () => {
  it('uses the latest observation of the expected market and marks unverified markets', () => {
    const list = [observation(1, 10), observation(1, 12), observation(1, 99, { marketKey: 'forever:Forever:horde' })];
    assert.equal(choosePrice(1, list, 'forever:Forever:alliance').priceCopper, 12);
    const unverified = choosePrice(1, list.slice(0, 2), null);
    assert.equal(unverified.priceCopper, 12);
    assert.ok(unverified.limitations.includes('market_unverified'));
  });

  it('excludes a known other market and reports unavailable prices with their reason', () => {
    const other = choosePrice(1, [observation(1, 50, { marketKey: 'forever:Forever:horde' })], 'forever:Forever:alliance');
    assert.deepEqual([other.priceCopper, other.limitations], [null, ['other_market_only']]);
    const missing = choosePrice(1, [observation(1, null, { ageDays: null, agePrecision: 'unknown' })], null);
    assert.deepEqual(missing.limitations, ['price_unavailable:no_price']);
  });

  it('flags unknown age, fallback variant and unknown exactness', () => {
    const choice = choosePrice(1, [observation(1, 7, { ageDays: null, agePrecision: 'unknown', exactness: 'fallback', rawExactness: false })], null);
    assert.deepEqual(choice.limitations.sort(), ['market_unverified', 'price_age_unknown', 'price_fallback_variant']);
    const unknownExact = choosePrice(1, [observation(1, 7, { exactness: 'unknown', rawExactness: null })], null);
    assert.ok(unknownExact.limitations.includes('price_exactness_unknown'));
  });
});

describe('map points', () => {
  const at = (mapKey: string | null, zoneName: string) =>
    ({
      snapshotId: 1,
      capturedAtSessionMs: 0,
      groups: { position: { availability: 'available', coverage: 'complete', observedAtSessionMs: 1, reason: null, value: { mapKey, x: 0.5, y: 0.5, zoneName } } },
    }) as unknown as Snapshot;

  it('confirms a uiMapID only when the client reported it with the same zone name', () => {
    assert.equal(confirmedMapOf(at('uiMap:1420', 'Tirisfal Glades')), 1420);
    assert.equal(confirmedMapOf(at('uiMap:1420', ' tirisfal  glades ')), 1420);
    assert.equal(confirmedMapOf(at('uiMap:1420', 'Brill')), null, 'a subzone name does not confirm the map');
    assert.equal(confirmedMapOf(at('uiMap:1420', '\u0422\u0438\u0440\u0438\u0441\u0444\u0430\u043b\u044c\u0441\u043a\u0438\u0435 \u043b\u0435\u0441\u0430')), null, 'another client language is not matched');
    assert.equal(confirmedMapOf(at('uiMap:9999', 'Tirisfal Glades')), null, 'unknown uiMapID');
    assert.equal(confirmedMapOf(at(null, 'Tirisfal Glades')), null);
    const disabled = { snapshotId: 1, capturedAtSessionMs: 0, groups: { position: { availability: 'disabled', coverage: 'unknown', observedAtSessionMs: null, reason: 'user_disabled', value: null } } };
    assert.equal(confirmedMapOf(disabled as unknown as Snapshot), null);
  });

  it('builds a verified location only on the confirmed map and with coordinates', () => {
    const vance = { entityKind: 'npc' as const, entityId: '5695', title: 'Vance Undergloom', uiMapId: 1420, x: 0.618, y: 0.516 };
    assert.deepEqual(verifiedLocationOf(vance, 1420, ['e'.repeat(32)]), { entityKind: 'npc', entityId: '5695', title: 'Vance Undergloom', mapKey: 'uiMap:1420', x: 0.618, y: 0.516, evidenceIds: ['e'.repeat(32)] });
    assert.equal(verifiedLocationOf(vance, 1458, []), null);
    assert.equal(verifiedLocationOf(vance, null, []), null);
    assert.equal(verifiedLocationOf({ ...vance, x: null, y: null }, 1420, []), null);
  });
});

describe('client item links', () => {
  it('accepts classic hex colours and the quality colour format of newer clients', () => {
    assert.equal(itemLinkId('|cff1eff00|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r'), 7046);
    assert.equal(itemLinkId('|cnIQ2:|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r'), 7046);
    assert.equal(itemLinkId('|cnot-a-colour|Hitem:7046|h[x]|h|r'), null);
    assert.equal(itemLinkId('|cff1eff00|Hspell:7046|h[x]|h|r'), null);
  });
});

describe('history text of a clarification', () => {
  const reply = (text: string, clarification: string | null) =>
    ({ status: clarification ? 'needs_data' : 'answer', text, itemRefs: [], evidenceIds: [], locationRef: null, approxLocation: null, calculationIds: [], limitations: [], clarification }) as Parameters<typeof historyTextOf>[0];

  it('appends the question only when the text does not already contain it', () => {
    assert.equal(historyTextOf(reply('What would you like help with?', 'What would you like help with?')), 'What would you like help with?');
    assert.equal(historyTextOf(reply('The item is unclear.', 'Which item?')), 'The item is unclear.\n\nWhich item?');
    assert.equal(historyTextOf(reply('Done.', null)), 'Done.');
  });
});

describe('reply text markers and point titles', () => {
  const a = 'a'.repeat(32);

  it('accepts known item and map markers and rejects the rest', () => {
    assert.equal(checkTextMarkers(`Take [[item:${a}]] to [[map]].`, [a], true), null);
    assert.equal(checkTextMarkers('No markers [x] [[ ]', [], false), null);
    assert.match(checkTextMarkers(`[[item:${'b'.repeat(32)}]]`, [a], false) ?? '', /not in itemRefIds/);
    assert.match(checkTextMarkers('Go [[map]]', [], false) ?? '', /needs locationRefId or approxLocation/);
    assert.match(checkTextMarkers('[[npc:5695]]', [], true) ?? '', /unknown text marker/);
  });

  it('requires a title from the model but reads stored points without one', () => {
    const approx = { zoneName: 'Undercity', x: 61.8, y: 51.6, basis: 'b', sourceUrl: 'u' };
    const reply = { status: 'answer', text: 't', itemRefIds: [], evidenceIds: [], locationRefId: null, calculationIds: [], limitations: [], clarification: null };
    assert.equal(ModelReply.safeParse({ ...reply, approxLocation: approx }).success, false);
    assert.equal(ModelReply.safeParse({ ...reply, approxLocation: { ...approx, title: 'Vance Undergloom' } }).success, true);
    const stored = GameReply.parse({ ...reply, itemRefs: [], locationRef: null, approxLocation: approx, itemRefIds: undefined, locationRefId: undefined });
    assert.equal(stored.approxLocation?.title, null);
    const location = { refId: a, entityKind: 'npc', entityId: '5695', mapKey: 'uiMap:1420', x: 0.6, y: 0.5, evidenceIds: [a] };
    assert.equal(VerifiedLocation.parse(location).title, null);
  });

  it('validates indexed map markers and one source per point in a multi-location answer', () => {
    const point = { locationRefId: null, approxLocation: { title: 'Camp', zoneName: 'Elwynn Forest', x: 40, y: 60, basis: 'fixture', sourceUrl: 'https://example.test/map' } };
    const reply = { status: 'answer', text: 'Visit [[map:1]] and [[map:2]].', itemRefIds: [], evidenceIds: [],
      locationRefId: null, approxLocation: null, locations: [point, point], calculationIds: [], limitations: [], clarification: null };
    assert.equal(ModelReply.safeParse(reply).success, true);
    assert.equal(checkTextMarkers(reply.text, [], 2), null);
    assert.match(checkTextMarkers('[[map]]', [], 2) ?? '', /indexed markers/);
    assert.match(checkTextMarkers('[[map:3]]', [], 2) ?? '', /outside/);
    for (const marker of ['[[map:0]]', '[[map:-1]]', '[[map:1.5]]']) assert.ok(checkTextMarkers(marker, [], 2));
    assert.equal(ModelReply.safeParse({ ...reply, locations: [{ locationRefId: null, approxLocation: null }] }).success, false);
    assert.equal(ModelReply.safeParse({ ...reply, locations: [{ ...point, locationRefId: a }] }).success, false);
    assert.equal(ModelReply.safeParse({ ...reply, locations: [{ ...point, approxLocation: { ...point.approxLocation, x: 101 } }] }).success, false);
    assert.equal(ModelReply.safeParse({ ...reply, locations: Array(21).fill(point) }).success, false);
    assert.equal(ModelReply.safeParse({ ...reply, approxLocation: point.approxLocation }).success, false);
  });
});

// Glyph code points from the font's cmap table, formats 4 and 12.
function fontCodes(path: string): Set<number> {
  const data = readFileSync(path);
  const tables = new Map<string, number>();
  for (let i = 0; i < data.readUInt16BE(4); i++) tables.set(data.toString('latin1', 12 + 16 * i, 16 + 16 * i), data.readUInt32BE(20 + 16 * i));
  const cmap = tables.get('cmap')!;
  const codes = new Set<number>();
  for (let i = 0; i < data.readUInt16BE(cmap + 2); i++) {
    const sub = cmap + data.readUInt32BE(cmap + 8 + 8 * i);
    const format = data.readUInt16BE(sub);
    if (format === 4) {
      const segments = data.readUInt16BE(sub + 6) / 2;
      const ends = sub + 14, starts = ends + 2 * segments + 2, deltas = starts + 2 * segments, offsets = deltas + 2 * segments;
      for (let k = 0; k < segments; k++) {
        const start = data.readUInt16BE(starts + 2 * k), end = data.readUInt16BE(ends + 2 * k);
        const delta = data.readInt16BE(deltas + 2 * k), offset = data.readUInt16BE(offsets + 2 * k);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph = offset === 0 ? (c + delta) & 0xffff : data.readUInt16BE(offsets + 2 * k + offset + 2 * (c - start));
          if (offset !== 0 && glyph !== 0) glyph = (glyph + delta) & 0xffff;
          if (glyph !== 0) codes.add(c);
        }
      }
    } else if (format === 12) {
      for (let k = 0; k < data.readUInt32BE(sub + 12); k++) {
        for (let c = data.readUInt32BE(sub + 16 + 12 * k); c <= data.readUInt32BE(sub + 20 + 12 * k); c++) codes.add(c);
      }
    }
  }
  return codes;
}

describe('text in the addon font', () => {
  it('lists exactly the printable characters of the bundled font', () => {
    const codes = [...fontCodes(resourcePath('addon', 'ForeverAssistant', 'Fonts', 'NotoSans-Regular.ttf'))].filter((c) => c >= 0x20).sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    for (const c of codes) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === c - 1) last[1] = c;
      else ranges.push([c, c]);
    }
    assert.deepEqual(ranges, FONT_RANGES.map(([a, b]) => [a, b]));
  });

  it('replaces arrows and signs with ASCII and drops other missing glyphs', () => {
    assert.equal(fitFont('\u041f\u043e\u0440\u0442\u043d\u044f\u0436\u043d\u043e\u0435 \u0434\u0435\u043b\u043e: 1→75'), '\u041f\u043e\u0440\u0442\u043d\u044f\u0436\u043d\u043e\u0435 \u0434\u0435\u043b\u043e: 1->75');
    assert.equal(fitFont('\u041d\u0430\u0432\u044b\u043a ≥ 50 ≈ 2 \u0447\u0430\u0441\u0430 ✓ ★'), '\u041d\u0430\u0432\u044b\u043a >= 50 ~ 2 \u0447\u0430\u0441\u0430 + *');
    assert.equal(fitFont('\u0413\u043e\u0442\u043e\u0432\u043e 🎉\n\u0434\u0430\u043b\u044c\u0448\u0435 — «\u0413\u043e\u0431\u043b\u0438\u043d» … № 3'), '\u0413\u043e\u0442\u043e\u0432\u043e \n\u0434\u0430\u043b\u044c\u0448\u0435 — «\u0413\u043e\u0431\u043b\u0438\u043d» … № 3');
  });
});
