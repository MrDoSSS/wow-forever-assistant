import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CraftPlanError, planCraft, planItems, type Crafters, type PlanInput } from '../bridge/src/domain/craft-plan.js';
import { purchasePrice, type PriceChoice } from '../bridge/src/domain/pricing.js';
import type { RecipeRecord } from '../bridge/src/sources/shared/types.js';

const ORE = 2770;
const BAR = 2840;
const BELT = 2851;
const THREAD = 2320;
const SILK = 4306;

function recipe(spellId: number, profession: string, outputItemId: number | null, reagents: [number, number][], outputCount = 1): RecipeRecord {
  return {
    spellId,
    profession,
    learn: 1,
    yellow: null,
    green: null,
    grey: null,
    greenDerived: false,
    outputItemId,
    outputCount,
    taughtByItemId: null,
    status: null,
    reagents: reagents.map(([itemId, count]) => ({ itemId, count })),
    limitations: [],
  };
}

const SMELT = recipe(2657, 'Mining', BAR, [[ORE, 1]]);
const MAKE_BELT = recipe(2661, 'Blacksmithing', BELT, [[BAR, 6], [THREAD, 1]]);
const SPIN = recipe(9999, 'Tailoring', THREAD, [[SILK, 1]], 5);

function byOutput(...recipes: RecipeRecord[]): Map<number, RecipeRecord[]> {
  const map = new Map<number, RecipeRecord[]>();
  for (const r of recipes) if (r.outputItemId !== null) map.set(r.outputItemId, [...(map.get(r.outputItemId) ?? []), r]);
  return map;
}

function knownBy(known: Record<string, number[]>, learnable: Record<string, number[]> = {}): Crafters {
  const who = (table: Record<string, number[]>, r: RecipeRecord) => Object.keys(table).filter((name) => table[name]!.includes(r.spellId));
  return { knowledge: true, knownBy: (r) => who(known, r), learnableBy: (r) => who(learnable, r) };
}

function prices(values: Record<number, number>): Map<number, PriceChoice> {
  return new Map(Object.entries(values).map(([id, price]) => [Number(id), { itemId: Number(id), priceCopper: price, observation: null, limitations: [] }]));
}

function input(overrides: Partial<PlanInput>): PlanInput {
  return {
    recipe: MAKE_BELT,
    desiredQuantity: 1,
    maxDepth: 3,
    recipesByOutput: byOutput(SMELT, MAKE_BELT, SPIN),
    stock: new Map(),
    buyer: 'Main',
    crafters: knownBy({ Main: [2657, 2661, 9999] }),
    prices: new Map(),
    ...overrides,
  };
}

describe('craft plan', () => {
  it('crafts intermediates a character knows and buys raw materials when prices are unknown', () => {
    const plan = planCraft(input({}));
    assert.deepEqual(plan.steps.map((s) => [s.recipeSpellId, s.crafts, s.crafter]), [[2657, 6, 'Main'], [9999, 1, 'Main'], [2661, 1, 'Main']]);
    assert.deepEqual(plan.buy, [
      { itemId: ORE, quantity: 6, buyer: 'Main', unitPriceCopper: null, totalCopper: null },
      { itemId: SILK, quantity: 1, buyer: 'Main', unitPriceCopper: null, totalCopper: null },
    ]);
    assert.equal(plan.totalCostCopper, null);
    assert.deepEqual(plan.unpricedItemIds, [ORE, SILK]);
    // Thread is crafted in batches of 5; the extra 4 remain with the crafter.
    assert.deepEqual(plan.leftovers, [{ itemId: THREAD, quantity: 4, holder: 'Main' }]);
    assert.ok(plan.limitations.includes('inventory_not_used'));
  });

  it('buys an intermediate when that is cheaper than crafting it', () => {
    const cheapOre = planCraft(input({ prices: prices({ [ORE]: 10, [BAR]: 30, [THREAD]: 5, [SILK]: 100 }) }));
    assert.deepEqual(cheapOre.buy.map((b) => [b.itemId, b.quantity]), [[THREAD, 1], [ORE, 6]]);
    assert.equal(cheapOre.totalCostCopper, 65);
    const dearOre = planCraft(input({ prices: prices({ [ORE]: 50, [BAR]: 30, [THREAD]: 5 }) }));
    assert.deepEqual(dearOre.buy.map((b) => [b.itemId, b.quantity, b.totalCopper]), [[THREAD, 1, 5], [BAR, 6, 180]]);
    assert.deepEqual(dearOre.steps.map((s) => s.recipeSpellId), [2661]);
  });

  it('takes stock of all characters first and plans what to mail to the crafter', () => {
    const plan = planCraft(
      input({
        crafters: knownBy({ Main: [2657, 9999], Smith: [2661] }),
        stock: new Map([
          ['Main', new Map([[ORE, 10]])],
          ['Smith', new Map()],
          ['Bank', new Map([[BAR, 4], [THREAD, 1]])],
        ]),
      }),
    );
    assert.deepEqual(plan.steps.map((s) => [s.recipeSpellId, s.crafts, s.crafter]), [[2657, 2, 'Main'], [2661, 1, 'Smith']]);
    assert.deepEqual(plan.buy, []);
    assert.equal(plan.totalCostCopper, 0);
    assert.deepEqual(plan.fromInventory, [
      { itemId: THREAD, quantity: 1, from: [{ name: 'Bank', quantity: 1 }] },
      { itemId: ORE, quantity: 2, from: [{ name: 'Main', quantity: 2 }] },
      { itemId: BAR, quantity: 4, from: [{ name: 'Bank', quantity: 4 }] },
    ].sort((a, b) => a.itemId - b.itemId));
    assert.deepEqual(
      plan.transfers.map((t) => [t.itemId, t.quantity, t.from, t.to]).sort(),
      [[BAR, 2, 'Main', 'Smith'], [BAR, 4, 'Bank', 'Smith'], [THREAD, 1, 'Bank', 'Smith'], [BELT, 1, 'Smith', 'Main']].sort(),
    );
  });

  it('buys what no character can craft and respects the depth limit', () => {
    const nobody = planCraft(input({ crafters: knownBy({ Main: [2661] }) }));
    assert.deepEqual(nobody.buy.map((b) => b.itemId), [THREAD, BAR]);
    const flat = planCraft(input({ maxDepth: 0 }));
    assert.deepEqual(flat.steps.map((s) => s.recipeSpellId), [2661]);
    assert.ok(planCraft(input({ crafters: knownBy({ Other: [2657] }) })).limitations.some((l) => l.startsWith('top_recipe_unknown')));
    const unknown = planCraft(input({ crafters: { knowledge: false, knownBy: () => [], learnableBy: () => [] } }));
    assert.deepEqual(unknown.steps.map((s) => s.crafter), [null, null, null]);
    assert.ok(unknown.limitations.some((l) => l.startsWith('recipe_knowledge_unknown')));
  });

  it('assigns a character with the profession skill to trainer recipes and marks what to learn', () => {
    const plan = planCraft(input({ crafters: knownBy({ Smith: [2661] }, { Miner: [2657], Tailor: [9999] }) }));
    assert.deepEqual(plan.steps.map((s) => [s.recipeSpellId, s.crafter, s.learn]), [[2657, 'Miner', 'trainer'], [9999, 'Tailor', 'trainer'], [2661, 'Smith', 'known']]);
    assert.ok(plan.limitations.some((l) => l.startsWith('learn_first')));
    assert.deepEqual(plan.transfers.map((t) => [t.itemId, t.from, t.to]).sort(), [[BAR, 'Miner', 'Smith'], [THREAD, 'Tailor', 'Smith'], [BELT, 'Smith', 'Main']].sort());
    assert.deepEqual(plan.buy.map((b) => [b.itemId, b.buyer]).sort(), [[ORE, 'Miner'], [SILK, 'Tailor']].sort());

    // Do not propose intermediate recipes requiring patterns: buy the thread instead.
    const pattern = { ...SPIN, taughtByItemId: 5555 };
    const bought = planCraft(input({ recipesByOutput: byOutput(SMELT, MAKE_BELT, pattern), crafters: knownBy({ Smith: [2661, 2657] }, { Tailor: [9999] }) }));
    assert.deepEqual(bought.buy.map((b) => b.itemId), [THREAD, ORE]);

    // Top-level pattern recipe: choose the crafter by skill; the pattern is required.
    const top = { ...MAKE_BELT, taughtByItemId: 7777 };
    const sash = planCraft(input({ recipe: top, recipesByOutput: byOutput(SMELT, top, SPIN), crafters: knownBy({}, { Smith: [2661], Main: [2657, 9999] }) }));
    assert.deepEqual(sash.steps.at(-1), { ...sash.steps.at(-1)!, crafter: 'Smith', learn: 'recipe_item', recipeItemId: 7777 });
    assert.ok(sash.limitations.some((l) => l.startsWith('recipe_item_needed')));
    assert.ok(!sash.limitations.some((l) => l.startsWith('top_recipe_unknown')));
  });

  it('does not loop on recipes that make each other and lists the tree items for prices', () => {
    const a = recipe(1, 'Alchemy', 101, [[102, 1]]);
    const b = recipe(2, 'Alchemy', 102, [[101, 1]]);
    const top = recipe(3, 'Alchemy', 103, [[101, 2]]);
    const plan = planCraft(input({ recipe: top, recipesByOutput: byOutput(a, b, top), crafters: knownBy({ Main: [1, 2, 3] }) }));
    assert.deepEqual(plan.steps.map((s) => s.recipeSpellId), [1, 3]);
    assert.deepEqual(plan.buy.map((b) => [b.itemId, b.quantity]), [[102, 2]]);
    assert.deepEqual(planItems(input({})), [ORE, BAR, THREAD, SILK].sort((x, y) => x - y));
    assert.throws(() => planCraft(input({ maxDepth: 9 })), CraftPlanError);
  });

  it('uses owned reagents on every character before buying only the shortfall on the crafter', () => {
    const top = recipe(42, 'Blacksmithing', BELT, [[ORE, 5], [THREAD, 2]]);
    const plan = planCraft(input({ recipe: top, crafters: knownBy({ Smith: [42] }),
      stock: new Map([['Main', new Map([[ORE, 2]])], ['Bank', new Map([[ORE, 2], [THREAD, 2]])]]),
      prices: prices({ [ORE]: 1, [THREAD]: 1 }), maxDepth: 0 }));
    assert.deepEqual(plan.buy, [{ itemId: ORE, quantity: 1, buyer: 'Smith', unitPriceCopper: 1, totalCopper: 1 }]);
    assert.equal(plan.fromInventory.find((row) => row.itemId === ORE)!.quantity, 4);
    assert.equal(plan.fromInventory.find((row) => row.itemId === THREAD)!.quantity, 2);
    assert.ok(plan.transfers.some((t) => t.from === 'Bank' && t.to === 'Smith' && t.itemId === THREAD));
    assert.ok(!plan.transfers.some((t) => t.itemId === ORE && t.from === 'Smith'));
  });

  it('uses owned finished items before crafting the missing output', () => {
    const fullyOwned = planCraft(input({ stock: new Map([['Bank', new Map([[BELT, 2]])]]), desiredQuantity: 2 }));
    assert.deepEqual(fullyOwned.steps, []);
    assert.deepEqual(fullyOwned.buy, []);
    assert.equal(fullyOwned.totalCostCopper, 0);
    assert.deepEqual(fullyOwned.transfers, [{ itemId: BELT, quantity: 2, from: 'Bank', to: 'Main' }]);
    const partial = planCraft(input({ stock: new Map([['Bank', new Map([[BELT, 1]])]]), desiredQuantity: 2 }));
    assert.equal(partial.steps.find((step) => step.recipeSpellId === MAKE_BELT.spellId)!.crafts, 1);
  });

  it('keeps intermediate crafts and their purchases on the consumer when it knows those recipes', () => {
    const plan = planCraft(input({ crafters: knownBy({ Main: [2657, 9999], Smith: [2657, 2661, 9999] }) }));
    assert.ok(plan.steps.every((step) => step.crafter === 'Smith'));
    assert.ok(plan.buy.every((row) => row.buyer === 'Smith'));
    assert.deepEqual(plan.transfers, [{ itemId: BELT, quantity: 1, from: 'Smith', to: 'Main' }]);
  });

  it('keeps purchases of the same material separate for different crafters', () => {
    const top = recipe(43, 'Blacksmithing', BELT, [[ORE, 2], [BAR, 1]]);
    const plan = planCraft(input({ recipe: top, crafters: knownBy({ Main: [2657], Smith: [43] }), prices: prices({ [ORE]: 10 }) }));
    assert.deepEqual(plan.buy.map((row) => [row.itemId, row.quantity, row.buyer]), [[ORE, 1, 'Main'], [ORE, 2, 'Smith']]);
    assert.deepEqual(plan.purchaseTotals.map((row) => [row.buyer, row.totalCostCopper]), [['Main', 10], ['Smith', 20]]);
    assert.ok(!plan.transfers.some((transfer) => transfer.itemId === ORE));
  });

  it('keeps cheaper extra-character crafts optional, but uses owned raw materials before local purchases', () => {
    const top = recipe(44, 'Blacksmithing', BELT, [[BAR, 1]]);
    const p = prices({ [ORE]: 1, [BAR]: 100 });
    const base = input({ recipe: top, crafters: knownBy({ Main: [2657], Smith: [44] }), prices: p,
      purchaseFor: (itemId, quantity, buyer) => ({ ...purchasePrice(itemId, quantity, p.get(itemId)), buyer, local: true }) });
    const convenient = planCraft(base);
    assert.deepEqual(convenient.steps.map((step) => step.recipeSpellId), [44]);
    assert.equal(convenient.buy[0]!.buyer, 'Smith');
    assert.deepEqual(convenient.craftAlternatives.map((row) => [row.recipeSpellId, row.crafter, row.estimatedCostCopper]), [[2657, 'Main', 1]]);
    const owned = planCraft({ ...base, stock: new Map([['Bank', new Map([[ORE, 1]])]]) });
    assert.deepEqual(owned.buy, []);
    assert.deepEqual(owned.steps.map((step) => step.recipeSpellId), [2657, 44]);
    assert.ok(owned.transfers.some((row) => row.from === 'Bank' && row.to === 'Main' && row.itemId === ORE));
  });
});
