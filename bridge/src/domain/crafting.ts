// Crafting material calculations; code performs all arithmetic.
// crafts = ceil(desiredQuantity / outputCount); for effects without an output item,
// desiredQuantity counts applications. missing = max(0, needed - owned);
// with incomplete bags, missing is null while known quantities are preserved.
// Unknown prices are not zero; mark the total incomplete.
// account includes bags, bank and mail across all account characters (domain/alts.ts).
import type { SnapshotGroups } from '../contracts.js';
import type { RecipeRecord } from '../sources/foreverdb/decode.js';
import { purchasePrice, type PriceChoice, type PurchasePrice } from './pricing.js';

export type Inventory =
  | { scope: 'none' }
  | { scope: 'bags'; bags: SnapshotGroups['bags'] }
  | { scope: 'account'; owned: ReadonlyMap<number, number>; limitations: string[] };

export interface CraftLine {
  itemId: number;
  needed: number;
  knownOwned: number | null;
  missing: number | null;
}

export interface CraftResult {
  recipeSpellId: number;
  crafts: number;
  lines: CraftLine[];
  priceTotalCopper: number | null;
  unpricedItemIds: number[];
  prices: PurchasePrice[];
  limitations: string[];
}

export class CraftLimitError extends Error {}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new CraftLimitError('arithmetic exceeds the safe integer range');
  return value;
}

export function calculateCraft(input: {
  recipe: RecipeRecord;
  desiredQuantity: number;
  inventory: Inventory;
  prices: ReadonlyMap<number, PriceChoice>;
}): CraftResult {
  const { recipe, desiredQuantity, inventory, prices } = input;
  if (!Number.isSafeInteger(desiredQuantity) || desiredQuantity < 1) throw new CraftLimitError('desiredQuantity must be a positive integer');
  const limitations = new Set<string>();
  const crafts =
    recipe.outputItemId === null ? desiredQuantity : Math.ceil(desiredQuantity / recipe.outputCount);
  if (recipe.outputItemId === null) limitations.add('effect_applications: the count is effect applications, not created items');

  // Known bag contents: complete, partial or unknown.
  let owned: Map<number, number> | null = null;
  let ownedComplete = false;
  if (inventory.scope === 'none') {
    limitations.add('inventory_not_used');
  } else if (inventory.scope === 'account') {
    owned = new Map(inventory.owned);
    ownedComplete = true;
    limitations.add('account_inventory: bags, bank and mail of all characters; alts as of their last save');
    for (const l of inventory.limitations) limitations.add(l);
  } else if (inventory.bags.availability === 'available') {
    owned = new Map();
    for (const slot of inventory.bags.value) {
      owned.set(slot.item.itemId, safe((owned.get(slot.item.itemId) ?? 0) + slot.count));
    }
    ownedComplete = inventory.bags.coverage === 'complete';
    if (!ownedComplete) limitations.add('inventory_partial: missing is not computed');
  } else {
    limitations.add(`inventory_${inventory.bags.availability}`);
  }

  const lines: CraftLine[] = recipe.reagents.map((reagent) => {
    const needed = safe(reagent.count * crafts);
    const knownOwned = owned ? owned.get(reagent.itemId) ?? 0 : null;
    let missing: number | null;
    if (inventory.scope === 'none') missing = needed;
    else if (owned && ownedComplete) missing = Math.max(0, needed - (knownOwned ?? 0));
    else missing = null;
    return { itemId: reagent.itemId, needed, knownOwned: inventory.scope === 'none' ? null : knownOwned, missing };
  });

  let total = 0;
  let priced = 0;
  const unpricedItemIds: number[] = [];
  const purchasePrices: PurchasePrice[] = [];
  for (const line of lines) {
    if (line.missing === 0) continue;
    const choice = prices.get(line.itemId);
    const price = line.missing === null ? null : purchasePrice(line.itemId, line.missing, choice);
    if (price) purchasePrices.push(price);
    for (const l of price?.limitations ?? choice?.limitations ?? []) limitations.add(l);
    if (price === null || price.totalCopper === null) {
      unpricedItemIds.push(line.itemId);
      continue;
    }
    total = safe(total + safe(price.totalCopper));
    priced++;
  }
  if (unpricedItemIds.length > 0 && priced > 0) limitations.add('price_total_incomplete: the total excludes some items');
  return {
    recipeSpellId: recipe.spellId,
    crafts,
    lines,
    priceTotalCopper: priced > 0 ? total : null,
    unpricedItemIds,
    prices: purchasePrices,
    limitations: [...limitations],
  };
}
