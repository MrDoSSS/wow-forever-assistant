// Queries against the pinned ForeverMaster dataset for model tools.
// Only dataset data lives here; attempt evidence, refIds and cursors are managed elsewhere.
import type { DATASET_TYPES } from '../../contracts.js';
import type { DatasetRecord, DatasetType, DecodedDataset, RecipeRecord, TrainerRecord } from './decode.js';
import { searchIndex, type SearchIndex, type SearchPage } from './search.js';

export type ToolStatus = 'ok' | 'not_found' | 'source_unavailable' | 'unsupported_format' | 'limit';

export interface ToolOutcome<T> {
  status: ToolStatus;
  data: T | null;
  limitations: string[];
  nextOffset: number | null;
}

export interface ItemInfo {
  itemId: number;
  /** English name from Search; null means absent from the dataset, not proof that the item does not exist. */
  name: string | null;
  /** Items.lua "label|source type|description" string, when present. */
  note: string | null;
  recipeSpellIds: { produces: number[]; reagentFor: number[]; taughtBy: number[] };
}

export interface SourceStatus {
  datasetId: string;
  addonVersion: string | null;
  pack: DecodedDataset['pack'];
  files: DecodedDataset['files'];
  skippedCount: number;
  skips: DecodedDataset['skips'];
  limitations: string[];
}

const PAGE = 100;

/** General source limitations included in model replies. */
export const SOURCE_LIMITATIONS = [
  'forevermaster_snapshot: data as of the Pack date and build; a missing record does not prove the object is absent from the game',
  'trainer_is_candidate: a profession/class trainer does not prove that a specific recipe is taught',
  'taught_by_is_item: a recipe taughtBy is the item that teaches it, not an NPC',
];

function ok<T>(data: T, limitations: string[] = [], nextOffset: number | null = null): ToolOutcome<T> {
  return { status: 'ok', data, limitations, nextOffset };
}

function notFound<T>(limitation: string): ToolOutcome<T> {
  return { status: 'not_found', data: null, limitations: [limitation], nextOffset: null };
}

export class ForeverMasterSource {
  private readonly reverse = new Map<number, ItemInfo['recipeSpellIds']>();

  constructor(
    readonly dataset: DecodedDataset,
    readonly index: SearchIndex,
  ) {
    const links = (itemId: number) => {
      let entry = this.reverse.get(itemId);
      if (!entry) {
        entry = { produces: [], reagentFor: [], taughtBy: [] };
        this.reverse.set(itemId, entry);
      }
      return entry;
    };
    for (const recipe of Object.values(dataset.recipes)) {
      if (recipe.outputItemId !== null) links(recipe.outputItemId).produces.push(recipe.spellId);
      if (recipe.taughtByItemId !== null) links(recipe.taughtByItemId).taughtBy.push(recipe.spellId);
      for (const reagent of recipe.reagents) links(reagent.itemId).reagentFor.push(recipe.spellId);
    }
    for (const entry of this.reverse.values()) {
      entry.produces.sort((a, b) => a - b);
      entry.reagentFor.sort((a, b) => a - b);
      entry.taughtBy.sort((a, b) => a - b);
    }
  }

  get datasetId(): string {
    return this.dataset.datasetId;
  }

  searchGameData(query: string, types: readonly (typeof DATASET_TYPES)[number][], offset = 0): ToolOutcome<SearchPage> {
    const page = searchIndex(this.index, this.dataset, query, types as DatasetType[], offset);
    const limitations = page.hits.length === 0 ? ['no_match: no match does not prove the object is absent'] : [];
    return ok(page, limitations, page.nextOffset);
  }

  getItem(itemId: number): ToolOutcome<ItemInfo> {
    const name = this.dataset.names[String(itemId)] ?? null;
    const noteRecord = this.dataset.records.items?.[`items/${itemId}`];
    const note = typeof noteRecord?.fields === 'string' ? noteRecord.fields : null;
    const recipes = this.reverse.get(itemId) ?? { produces: [], reagentFor: [], taughtBy: [] };
    if (name === null && note === null && this.reverse.get(itemId) === undefined) {
      return notFound(`item ${itemId} is not in the ForeverMaster dataset`);
    }
    const limitations = name === null ? ['name_unknown: the name is not in Search.lua'] : [];
    return ok({ itemId, name, note, recipeSpellIds: { ...recipes } }, limitations);
  }

  getGameRecord(type: DatasetType, recordKey: string): ToolOutcome<DatasetRecord> {
    const record = this.dataset.records[type]?.[recordKey];
    if (!record) return notFound(`no ${type} record ${recordKey}`);
    return ok(record, record.limitations);
  }

  getRecipe(spellId: number): ToolOutcome<RecipeRecord> {
    const recipe = this.dataset.recipes[String(spellId)];
    if (!recipe) return notFound(`recipe ${spellId} is not in the ForeverMaster dataset`);
    const limitations = [...recipe.limitations];
    if (recipe.greenDerived) limitations.push('green_derived: green = floor((yellow+grey)/2)');
    if (recipe.outputItemId === null) limitations.push('no_output_item: an effect without a created item');
    return ok(recipe, limitations);
  }

  /** Character faction hides other-faction trainers; neutral (unknown) trainers remain. */
  findTrainers(profession: string | null, classToken: string | null, faction: 'alliance' | 'horde' | null = null, offset = 0): ToolOutcome<TrainerRecord[]> {
    const group = this.dataset.trainers
      .filter((t) => (profession === null || t.profession?.toLowerCase() === profession.toLowerCase()))
      .filter((t) => (classToken === null || t.classToken?.toUpperCase() === classToken.toUpperCase()));
    if (group.length === 0) return notFound('no trainers for the given profession/class');
    const matches = group.filter((t) => faction === null || t.faction === faction || t.faction === 'unknown').sort((a, b) => a.npcId - b.npcId);
    const limitations = ['trainer_is_candidate: a trainer of the group does not prove that a specific recipe is taught'];
    const hidden = group.length - matches.length;
    if (hidden > 0) limitations.push(`other_faction_hidden: ${hidden} trainers of the other faction are omitted`);
    if (matches.length === 0) return { status: 'not_found', data: null, limitations, nextOffset: null };
    const page = matches.slice(offset, offset + PAGE);
    const next = offset + PAGE < matches.length ? offset + PAGE : null;
    return ok(page, limitations, next);
  }

  status(): ToolOutcome<SourceStatus> {
    const d = this.dataset;
    return ok({
      datasetId: d.datasetId,
      addonVersion: d.addonVersion,
      pack: d.pack,
      files: d.files,
      skippedCount: d.skippedCount,
      skips: d.skips.slice(0, 20),
      limitations: SOURCE_LIMITATIONS,
    });
  }
}
