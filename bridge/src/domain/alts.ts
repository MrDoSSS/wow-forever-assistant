// Account characters for get_alts, find_items_on_alts,
// find_recipe_crafters and calculate_craft with inventoryScope=account. The current
// character comes from the question snapshot; other characters come from saved
// SavedVariables (sources/alts.ts), with in-game observation times per section.
import type { QueryBody } from '../contracts.js';
import type { AltRecord } from '../sources/alts.js';
import type { RecipeRecord } from '../sources/forevermaster/decode.js';

/** Profession skill IDs by ForeverMaster's English name, matching addon PROFESSION_SKILLS. */
export const PROFESSION_SKILL_IDS: Record<string, number> = {
  Alchemy: 171,
  Blacksmithing: 164,
  Enchanting: 333,
  Engineering: 202,
  Herbalism: 182,
  Leatherworking: 165,
  Mining: 186,
  Skinning: 393,
  Tailoring: 197,
  Cooking: 185,
  'First Aid': 129,
  Fishing: 356,
};

/** snapshot is the state when asked; saved is the client's last save. */
export type DataSource = 'snapshot' | 'saved';

interface Part<T> {
  value: T;
  source: DataSource;
  /** In-game observation time in UTC ms; null for the question snapshot. */
  observedAt: number | null;
  partial: boolean;
}

export interface AccountCharacter {
  characterKey: string;
  name: string;
  /** Full name including surname (required for Forever mail); null if not saved. */
  fullName: string | null;
  realm: string;
  current: boolean;
  summary: Part<{ classToken: string; raceToken: string; faction: string; level: number; moneyCopper: number | null; zoneName: string | null }> | null;
  equipment: Part<{ slot: number; itemId: number }[]> | null;
  professions: Part<{ skillId: number; name: string; rank: number; maxRank: number }[]> | null;
  recipes: Map<number, { spellIds: Set<number>; observedAt: number }>;
  bags: Part<Map<number, number>> | null;
  bank: Part<Map<number, number>> | null;
  mail: Part<Map<number, number>> | null;
}

const ms = (seconds: number) => seconds * 1000;

function counts(items: { itemId: number; count: number }[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const { itemId, count } of items) map.set(itemId, (map.get(itemId) ?? 0) + count);
  return map;
}

function saved<T>(value: T, observedAt: number): Part<T> {
  return { value, source: 'saved', observedAt: ms(observedAt), partial: false };
}

function fromRecord(record: AltRecord, current: boolean): AccountCharacter {
  const recipes = new Map<number, { spellIds: Set<number>; observedAt: number }>();
  for (const r of record.recipes ?? []) recipes.set(r.skillId, { spellIds: new Set(r.spellIds), observedAt: ms(r.observedAt) });
  const s = record.summary;
  return {
    characterKey: record.characterKey,
    name: record.identity.displayName,
    fullName: s?.fullName || null,
    realm: record.identity.realm,
    current,
    summary: s
      ? saved({ classToken: s.classToken, raceToken: s.raceToken, faction: s.faction, level: s.level, moneyCopper: s.moneyCopper ?? null, zoneName: s.zoneName ?? null }, s.observedAt)
      : null,
    equipment: record.equipment ? saved(record.equipment.items, record.equipment.observedAt) : null,
    professions: record.professions ? saved(record.professions.list, record.professions.observedAt) : null,
    recipes,
    bags: record.bags ? saved(counts(record.bags.items), record.bags.observedAt) : null,
    bank: record.bank ? saved(counts(record.bank.items), record.bank.observedAt) : null,
    mail: record.mail ? saved(counts(record.mail.items), record.mail.observedAt) : null,
  };
}

function snapshotPart<T>(value: T, coverage: 'complete' | 'partial'): Part<T> {
  return { value, source: 'snapshot', observedAt: null, partial: coverage === 'partial' };
}

/** The question snapshot replaces saved summary, equipment, professions and bags for the current character. */
function applySnapshot(character: AccountCharacter, query: QueryBody): void {
  const g = query.snapshot.groups;
  if (g.character.availability === 'available') {
    const c = g.character.value;
    const zoneName = g.position.availability === 'available' && g.position.value.zoneName !== '' ? g.position.value.zoneName : (character.summary?.value.zoneName ?? null);
    character.summary = snapshotPart({ classToken: c.classToken, raceToken: c.raceToken, faction: c.faction, level: c.level, moneyCopper: c.moneyCopper, zoneName }, g.character.coverage);
  }
  if (g.equipment.availability === 'available') {
    const items = g.equipment.value.flatMap((e) => (e.item ? [{ slot: e.slot, itemId: e.item.itemId }] : []));
    character.equipment = snapshotPart(items, g.equipment.coverage);
  }
  if (g.professions.availability === 'available') {
    character.professions = snapshotPart(
      g.professions.value.map((p) => ({ skillId: p.skillId, name: p.name, rank: p.rank, maxRank: p.maxRank })),
      g.professions.coverage,
    );
  }
  if (g.bags.availability === 'available') {
    character.bags = snapshotPart(counts(g.bags.value.map((b) => ({ itemId: b.item.itemId, count: b.count }))), g.bags.coverage);
  }
}

/** Characters in the question's server namespace, with the current character first. */
export function accountView(records: AltRecord[], query: QueryBody, characterKey: string): AccountCharacter[] {
  const namespace = query.identity.serverNamespace;
  const list = records.filter((r) => r.identity.serverNamespace === namespace).map((r) => fromRecord(r, r.characterKey === characterKey));
  let current = list.find((c) => c.current);
  if (!current) {
    current = {
      characterKey,
      name: query.identity.displayName,
      fullName: null,
      realm: query.identity.realm,
      current: true,
      summary: null,
      equipment: null,
      professions: null,
      recipes: new Map(),
      bags: null,
      bank: null,
      mail: null,
    };
    list.push(current);
  }
  applySnapshot(current, query);
  return list.sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

function partInfo(part: Part<unknown> | null) {
  return part ? { source: part.source, observedAt: iso(part.observedAt), partial: part.partial } : null;
}

/** Character summary for get_alts. */
export function describeAccount(view: AccountCharacter[]) {
  return view.map((c) => ({
    name: c.name,
    fullName: c.fullName,
    realm: c.realm,
    current: c.current,
    ...(c.summary?.value ?? { classToken: null, raceToken: null, faction: null, level: null, moneyCopper: null, zoneName: null }),
    professions: (c.professions?.value ?? []).map((p) => {
      const recipes = c.recipes.get(p.skillId);
      return { ...p, knownRecipes: recipes ? recipes.spellIds.size : null, recipesObservedAt: iso(recipes?.observedAt ?? null) };
    }),
    equipment: c.equipment?.value ?? null,
    data: {
      summary: partInfo(c.summary),
      equipment: partInfo(c.equipment),
      professions: partInfo(c.professions),
      bags: partInfo(c.bags),
      bank: partInfo(c.bank),
      mail: partInfo(c.mail),
    },
  }));
}

/**
 * Brief summary of other characters for each prompt: class,
 * level, money and professions. The model sees alts without calling tools.
 */
export function accountBrief(view: AccountCharacter[]) {
  return view
    .filter((c) => !c.current)
    .map((c) => ({
      name: c.name,
      fullName: c.fullName,
      classToken: c.summary?.value.classToken ?? null,
      level: c.summary?.value.level ?? null,
      faction: c.summary?.value.faction ?? null,
      moneyCopper: c.summary?.value.moneyCopper ?? null,
      zoneName: c.summary?.value.zoneName ?? null,
      professions: (c.professions?.value ?? []).map((p) => `${p.name} ${p.rank}/${p.maxRank}`),
      savedAt: iso(c.summary?.observedAt ?? null),
    }));
}

/**
 * Single account faction: every character's faction is known and identical.
 * Auctionator prices under the account's factionless market key could then only
 * have come from that faction. Characters without our addon are not visible here.
 */
export function singleFaction(view: AccountCharacter[]): 'alliance' | 'horde' | null {
  const factions = new Set(view.map((c) => c.summary?.value.faction ?? 'unknown'));
  if (factions.size !== 1) return null;
  const [faction] = factions;
  return faction === 'alliance' || faction === 'horde' ? faction : null;
}

/** Item holdings by character and storage: bags, bank and mail. */
export function itemHoldings(view: AccountCharacter[], itemIds: number[]) {
  return itemIds.map((itemId) => {
    const holders = view
      .map((c) => {
        const bags = c.bags?.value.get(itemId) ?? 0;
        const bank = c.bank?.value.get(itemId) ?? 0;
        const mail = c.mail?.value.get(itemId) ?? 0;
        return { name: c.name, current: c.current, bags, bank, mail, total: bags + bank + mail };
      })
      .filter((h) => h.total > 0)
      .sort((a, b) => b.total - a.total);
    return { itemId, total: holders.reduce((sum, h) => sum + h.total, 0), holders };
  });
}

/** Coverage limitations: characters with unknown bags, bank or mail. */
export function coverageLimitations(view: AccountCharacter[]): string[] {
  const missing = (part: 'bags' | 'bank' | 'mail') => view.filter((c) => c[part] === null).map((c) => c.name);
  const limitations: string[] = [];
  const bags = missing('bags');
  const bank = missing('bank');
  const mail = missing('mail');
  if (bags.length > 0) limitations.push(`bags_unknown: ${bags.join(', ')} (log in with the addon once)`);
  if (bank.length > 0) limitations.push(`bank_not_seen: ${bank.join(', ')} (open the bank once on that character)`);
  if (mail.length > 0) limitations.push(`mail_not_seen: ${mail.join(', ')} (open the mailbox once on that character)`);
  if (view.some((c) => c.bags?.partial)) limitations.push('bags_partial: the bag snapshot of the current character is incomplete');
  return limitations;
}

/** Account inventory totals for calculate_craft (inventoryScope=account). */
export function accountInventory(view: AccountCharacter[]): Map<number, number> {
  const total = new Map<number, number>();
  for (const c of view) {
    for (const part of [c.bags, c.bank, c.mail]) {
      for (const [itemId, count] of part?.value ?? []) total.set(itemId, (total.get(itemId) ?? 0) + count);
    }
  }
  return total;
}

export interface CrafterReport {
  recipeSpellId: number;
  profession: string | null;
  learn: number | null;
  knownBy: string[];
  canLearnNow: { name: string; rank: number }[];
  needsSkill: { name: string; rank: number; learn: number }[];
  notScanned: { name: string; rank: number }[];
}

/**
 * Characters who know a recipe from the observed profession window, who can
 * learn it at their current skill, and who need more skill. Without a dataset
 * record, the profession is unknown; check only known recipe lists.
 */
export function recipeCrafters(view: AccountCharacter[], recipeSpellId: number, recipe: RecipeRecord | null): CrafterReport {
  const report: CrafterReport = {
    recipeSpellId,
    profession: recipe?.profession ?? null,
    learn: recipe?.learn ?? null,
    knownBy: [],
    canLearnNow: [],
    needsSkill: [],
    notScanned: [],
  };
  const skillId = recipe ? (PROFESSION_SKILL_IDS[recipe.profession] ?? null) : null;
  for (const c of view) {
    if (skillId === null) {
      if ([...c.recipes.values()].some((r) => r.spellIds.has(recipeSpellId))) report.knownBy.push(c.name);
      continue;
    }
    const profession = c.professions?.value.find((p) => p.skillId === skillId);
    if (!profession) continue;
    const scanned = c.recipes.get(skillId);
    if (scanned?.spellIds.has(recipeSpellId)) report.knownBy.push(c.name);
    else if (!scanned) report.notScanned.push({ name: c.name, rank: profession.rank });
    else if (report.learn === null || profession.rank >= report.learn) report.canLearnNow.push({ name: c.name, rank: profession.rank });
    else report.needsSkill.push({ name: c.name, rank: profession.rank, learn: report.learn });
  }
  return report;
}
