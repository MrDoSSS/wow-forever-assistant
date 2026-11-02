// Crafting plan with intermediate products (plan_craft). Code performs arithmetic:
// first consume character inventory, then craft missing materials with a recipe
// one character knows, or buy them, whichever costs less at known prices.
// Round craft counts up at each level; keep surplus output in inventory
// to satisfy other branches. Bound recursion depth and reject item cycles
// on the current path. An unknown price is not zero.
import type { RecipeRecord } from '../sources/forevermaster/decode.js';
import type { PriceChoice } from './pricing.js';

export class CraftPlanError extends Error {}

export const PLAN_LIMITS = { maxDepth: 4, steps: 50 };

/**
 * Recipe crafters: knownBy lists recipes in saved profession windows;
 * learnableBy lists characters with enough skill but no confirmed recipe.
 * knowledge=false means professions are unknown; allow crafting without assigning a character.
 */
export interface Crafters {
  knowledge: boolean;
  /** Character names in preference order, with the current character first. */
  knownBy(recipe: RecipeRecord): string[];
  learnableBy(recipe: RecipeRecord): string[];
}

/** known means already learned; trainer means learn from a trainer; recipe_item requires a recipe item. */
export type LearnState = 'known' | 'trainer' | 'recipe_item';

export interface PlanInput {
  recipe: RecipeRecord;
  desiredQuantity: number;
  /** Intermediate crafting depth below the top-level recipe; 0 means only that recipe. */
  maxDepth: number;
  recipesByOutput: ReadonlyMap<number, readonly RecipeRecord[]>;
  /** Character inventory from bags, bank and mail; empty means ignore inventory. */
  stock: ReadonlyMap<string, ReadonlyMap<number, number>>;
  /** Buyer: the current character. */
  buyer: string;
  crafters: Crafters;
  prices: ReadonlyMap<number, PriceChoice>;
}

export interface PlanStep {
  recipeSpellId: number;
  profession: string;
  outputItemId: number | null;
  crafts: number;
  produces: number;
  crafter: string | null;
  /** null means the crafter is unknown. */
  learn: LearnState | null;
  /** Item that teaches the recipe (learn = recipe_item). */
  recipeItemId: number | null;
}

export interface CraftPlan {
  steps: PlanStep[];
  buy: { itemId: number; quantity: number; unitPriceCopper: number | null; totalCopper: number | null }[];
  fromInventory: { itemId: number; quantity: number; from: { name: string; quantity: number }[] }[];
  transfers: { itemId: number; quantity: number; from: string; to: string }[];
  leftovers: { itemId: number; quantity: number; holder: string | null }[];
  totalCostCopper: number | null;
  unpricedItemIds: number[];
  limitations: string[];
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new CraftPlanError('arithmetic exceeds the safe integer range');
  return value;
}

type Stock = Map<string, Map<number, number>>;

function cloneStock(stock: ReadonlyMap<string, ReadonlyMap<number, number>>): Stock {
  return new Map([...stock].map(([name, items]) => [name, new Map(items)]));
}

const NO_HOLDER = '';

class Planner {
  readonly steps: PlanStep[] = [];
  readonly buy = new Map<number, number>();
  readonly used = new Map<number, Map<string, number>>();
  readonly transfers = new Map<string, { itemId: number; quantity: number; from: string; to: string }>();
  readonly limitations = new Set<string>();

  constructor(
    private readonly input: PlanInput,
    readonly stock: Stock,
    /** Trial pass: calculate cost without recording a plan. */
    private readonly dry: boolean,
  ) {}

  private price(itemId: number): number | null {
    return this.input.prices.get(itemId)?.priceCopper ?? null;
  }

  /**
   * Prefer a character who knows the recipe; otherwise use sufficient profession skill
   * for trainer recipes. Recipe items are allowed only for the top-level recipe;
   * the plan does not propose buying patterns for intermediate products.
   */
  crafterOf(recipe: RecipeRecord, top = false): { name: string; learn: LearnState } | null {
    const known = this.input.crafters.knownBy(recipe)[0];
    if (known !== undefined) return { name: known, learn: 'known' };
    if (recipe.taughtByItemId !== null && !top) return null;
    const learner = this.input.crafters.learnableBy(recipe)[0];
    if (learner === undefined) return null;
    return { name: learner, learn: recipe.taughtByItemId === null ? 'trainer' : 'recipe_item' };
  }

  /** Recipes that can produce the item at this depth. */
  candidates(itemId: number, depth: number, path: ReadonlySet<number>): RecipeRecord[] {
    if (depth > this.input.maxDepth) return [];
    return (this.input.recipesByOutput.get(itemId) ?? []).filter(
      (r) => r.outputCount >= 1 && !r.reagents.some((g) => path.has(g.itemId)) && (!this.input.crafters.knowledge || this.crafterOf(r) !== null),
    );
  }

  /** Consume inventory from the consumer first, then the buyer, then other characters. */
  private take(itemId: number, quantity: number, consumer: string | null): number {
    const order = [consumer, this.input.buyer, ...[...this.stock.keys()].sort()].filter((n, i, a): n is string => n !== null && a.indexOf(n) === i);
    let left = quantity;
    for (const name of order) {
      const items = this.stock.get(name);
      const have = items?.get(itemId) ?? 0;
      if (have <= 0 || left === 0) continue;
      const taken = Math.min(have, left);
      items!.set(itemId, have - taken);
      left -= taken;
      if (!this.dry) {
        if (name !== NO_HOLDER) {
          const byHolder = this.used.get(itemId) ?? new Map<string, number>();
          byHolder.set(name, (byHolder.get(name) ?? 0) + taken);
          this.used.set(itemId, byHolder);
        }
        this.transfer(itemId, taken, name, consumer);
      }
    }
    return quantity - left;
  }

  private transfer(itemId: number, quantity: number, from: string, to: string | null): void {
    if (to === null || from === NO_HOLDER || from === to || quantity === 0) return;
    const key = `${itemId}|${from}|${to}`;
    const entry = this.transfers.get(key) ?? { itemId, quantity: 0, from, to };
    entry.quantity = safe(entry.quantity + quantity);
    this.transfers.set(key, entry);
  }

  private addStock(holder: string | null, itemId: number, quantity: number): void {
    const name = holder ?? NO_HOLDER;
    const items = this.stock.get(name) ?? new Map<number, number>();
    items.set(itemId, safe((items.get(itemId) ?? 0) + quantity));
    this.stock.set(name, items);
  }

  /** Trial cost: null means at least one price is unknown. */
  private trial(run: (p: Planner) => number | null): number | null {
    return run(new Planner(this.input, cloneStock(this.stock), true));
  }

  /** Provide quantity of an item to a consumer; return purchase cost, or null if unknown. */
  need(itemId: number, quantity: number, depth: number, path: ReadonlySet<number>, consumer: string | null): number | null {
    const remaining = quantity - this.take(itemId, quantity, consumer);
    if (remaining === 0) return 0;
    const buyPrice = this.price(itemId);
    const buyCost = buyPrice === null ? null : safe(buyPrice * remaining);

    let best: { recipe: RecipeRecord; cost: number | null } | null = null;
    for (const recipe of this.candidates(itemId, depth, path)) {
      const cost = this.trial((p) => p.craft(recipe, remaining, depth, path, consumer));
      if (!best || (cost !== null && (best.cost === null || cost < best.cost))) best = { recipe, cost };
    }
    // If both costs are known, choose the cheaper; if one is known, choose it; otherwise craft.
    const craft =
      best !== null &&
      (buyCost === null || (best.cost !== null && best.cost < buyCost));
    if (craft) return this.craft(best!.recipe, remaining, depth, path, consumer);

    if (!this.dry) {
      this.buy.set(itemId, safe((this.buy.get(itemId) ?? 0) + remaining));
      this.transfer(itemId, remaining, this.input.buyer, consumer);
    }
    return buyCost;
  }

  craft(recipe: RecipeRecord, quantity: number, depth: number, path: ReadonlySet<number>, consumer: string | null): number | null {
    const outputItemId = recipe.outputItemId;
    const crafts = outputItemId === null ? quantity : Math.ceil(quantity / recipe.outputCount);
    const who = this.crafterOf(recipe, depth === 0);
    const crafter = who?.name ?? null;
    const nextPath = new Set(path);
    if (outputItemId !== null) nextPath.add(outputItemId);
    let cost: number | null = 0;
    for (const reagent of recipe.reagents) {
      const part = this.need(reagent.itemId, safe(reagent.count * crafts), depth + 1, nextPath, crafter);
      cost = cost === null || part === null ? null : safe(cost + part);
    }
    if (outputItemId !== null) {
      const produced = safe(crafts * recipe.outputCount);
      if (produced > quantity) this.addStock(crafter, outputItemId, produced - quantity);
      if (!this.dry) this.transfer(outputItemId, quantity, crafter ?? NO_HOLDER, consumer);
    }
    if (!this.dry) this.addStep(recipe, crafts, crafter, who?.learn ?? null);
    return cost;
  }

  private addStep(recipe: RecipeRecord, crafts: number, crafter: string | null, learn: LearnState | null): void {
    const existing = this.steps.find((s) => s.recipeSpellId === recipe.spellId && s.crafter === crafter);
    const produces = recipe.outputItemId === null ? 0 : recipe.outputCount;
    if (existing) {
      existing.crafts = safe(existing.crafts + crafts);
      existing.produces = safe(existing.crafts * produces);
      return;
    }
    if (this.steps.length >= PLAN_LIMITS.steps) throw new CraftPlanError(`more than ${PLAN_LIMITS.steps} craft steps`);
    this.steps.push({
      recipeSpellId: recipe.spellId,
      profession: recipe.profession,
      outputItemId: recipe.outputItemId,
      crafts,
      produces: safe(crafts * produces),
      crafter,
      learn,
      recipeItemId: learn === 'recipe_item' ? recipe.taughtByItemId : null,
    });
  }
}

/** Items in the tree up to maxDepth, used to request prices before planning. */
export function planItems(input: Pick<PlanInput, 'recipe' | 'maxDepth' | 'recipesByOutput' | 'crafters'>): number[] {
  const items = new Set<number>();
  const visit = (recipe: RecipeRecord, depth: number, path: Set<number>) => {
    for (const reagent of recipe.reagents) {
      items.add(reagent.itemId);
      if (depth + 1 > input.maxDepth || path.has(reagent.itemId)) continue;
      for (const sub of input.recipesByOutput.get(reagent.itemId) ?? []) {
        const able = input.crafters.knownBy(sub).length > 0 || (sub.taughtByItemId === null && input.crafters.learnableBy(sub).length > 0);
        if (input.crafters.knowledge && !able) continue;
        visit(sub, depth + 1, new Set([...path, reagent.itemId]));
      }
    }
  };
  visit(input.recipe, 0, new Set(input.recipe.outputItemId === null ? [] : [input.recipe.outputItemId]));
  return [...items].sort((a, b) => a - b);
}

export function planCraft(input: PlanInput): CraftPlan {
  if (!Number.isSafeInteger(input.desiredQuantity) || input.desiredQuantity < 1) throw new CraftPlanError('desiredQuantity must be a positive integer');
  if (!Number.isInteger(input.maxDepth) || input.maxDepth < 0 || input.maxDepth > PLAN_LIMITS.maxDepth) {
    throw new CraftPlanError(`maxDepth must be 0..${PLAN_LIMITS.maxDepth}`);
  }
  const stock = cloneStock(input.stock);
  const planner = new Planner(input, stock, false);
  const top = input.recipe;
  const path = new Set(top.outputItemId === null ? [] : [top.outputItemId]);
  planner.craft(top, input.desiredQuantity, 0, path, null);

  const limitations = new Set<string>();
  if (top.outputItemId === null) limitations.add('effect_applications: the count is effect applications, not created items');
  if (!input.crafters.knowledge) limitations.add('recipe_knowledge_unknown: the recipes of the characters are not known; intermediate crafts have no assigned character');
  else if (planner.crafterOf(top, true) === null) limitations.add('top_recipe_unknown: no character has this recipe or the profession at its skill');
  if (planner.steps.some((s) => s.learn === 'trainer')) {
    limitations.add('learn_first: some steps use a trainer recipe the character may still need to learn (its recipe list was not confirmed)');
  }
  if (planner.steps.some((s) => s.learn === 'recipe_item')) {
    limitations.add('recipe_item_needed: the character must first get and learn the recipe item (recipeItemId)');
  }
  if (input.stock.size === 0) limitations.add('inventory_not_used');

  const buy = [...planner.buy].sort(([a], [b]) => a - b).map(([itemId, quantity]) => {
    const unit = input.prices.get(itemId)?.priceCopper ?? null;
    for (const l of input.prices.get(itemId)?.limitations ?? []) limitations.add(l);
    return { itemId, quantity, unitPriceCopper: unit, totalCopper: unit === null ? null : safe(unit * quantity) };
  });
  const unpricedItemIds = buy.filter((b) => b.unitPriceCopper === null).map((b) => b.itemId);
  const priced = buy.filter((b) => b.totalCopper !== null);
  let total = 0;
  for (const b of priced) total = safe(total + b.totalCopper!);
  if (unpricedItemIds.length > 0 && priced.length > 0) limitations.add('price_total_incomplete: the total excludes some items');

  const leftovers: CraftPlan['leftovers'] = [];
  for (const step of planner.steps) {
    if (step.outputItemId === null) continue;
    for (const [holder, items] of stock) {
      const original = input.stock.get(holder)?.get(step.outputItemId) ?? 0;
      const extra = (items.get(step.outputItemId) ?? 0) - original;
      if (extra > 0 && !leftovers.some((l) => l.itemId === step.outputItemId && l.holder === (holder || null))) {
        leftovers.push({ itemId: step.outputItemId, quantity: extra, holder: holder || null });
      }
    }
  }

  return {
    steps: planner.steps,
    buy,
    fromInventory: [...planner.used].sort(([a], [b]) => a - b).map(([itemId, byHolder]) => ({
      itemId,
      quantity: [...byHolder.values()].reduce((s, n) => s + n, 0),
      from: [...byHolder].map(([name, quantity]) => ({ name, quantity })),
    })),
    transfers: [...planner.transfers.values()],
    leftovers,
    totalCostCopper: buy.length === 0 ? 0 : priced.length > 0 ? total : null,
    unpricedItemIds,
    limitations: [...limitations],
  };
}
