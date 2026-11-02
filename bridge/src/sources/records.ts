// Common record lookup. Source facts stay separate; item and recipe references
// are issued by the attempt channel from complete normalized records.
import type { SearchType } from '../contracts.js';
import type { RecipeRecord, DatasetType, TrainerRecord, DecodedDataset } from './foreverdb/decode.js';
import type { ForeverDBSource } from './foreverdb/tools.js';
export type ReferenceSource = ForeverDBSource;
export const sourceKindOf = (source: ReferenceSource): 'foreverdb' => source.sourceKind;
import type { DataValue } from './questiedb/cbor.js';
import type { EntityType } from './questiedb/decode.js';
import { boundedFields, type QuestieSource } from './questiedb/tools.js';
import { zoneNameOf } from './zones.js';
import { FOREVERDB_URL } from './foreverdb/update.js';

export interface ReferencePoint {
  source: 'foreverdb' | 'questiedb';
  type: 'npc' | 'object';
  id: number;
  title: string;
  uiMapId: number | null;
  zoneName: string | null;
  /** Percentages, consistently across both sources. */
  x: number | null;
  y: number | null;
  approxLocation: { title: string; zoneName: string; x: number; y: number; basis: string; sourceUrl: string } | null;
}
export interface ReferenceFact {
  source: ReferencePoint['source'];
  datasetId: string;
  recordKey: string;
  sourceUrl: string;
  fields: Record<string, DataValue>;
}
export function trainerPoint(source: ReferenceSource, trainer: TrainerRecord): ReferencePoint {
  const zoneName = zoneNameOf(trainer.uiMapId);
  const x = trainer.x === null ? null : Math.round(trainer.x * 1000) / 10;
  const y = trainer.y === null ? null : Math.round(trainer.y * 1000) / 10;
  return {
    source: sourceKindOf(source), type: 'npc', id: trainer.npcId, title: trainer.name, uiMapId: trainer.uiMapId, zoneName, x, y,
    approxLocation: zoneName !== null && x !== null && y !== null
      ? { title: trainer.name, zoneName, x, y, basis: `Trainer record, NPC ${trainer.npcId}`, sourceUrl: source.dataset.pack.site ?? FOREVERDB_URL } : null,
  };
}

export function getGameRecord(master: ReferenceSource | null, questie: QuestieSource | null, args: {
  type: SearchType; id: number | null; recordKey: string | null; fields: string[];
}) {
  const { type, id, recordKey } = args;
  const facts: ReferenceFact[] = [];
  const locations: ReferencePoint[] = [];
  const limitations: string[] = [];
  let recipe: RecipeRecord | null = null;
  let fields: Record<string, DataValue> = {};
  let available = false;
  const addMaster = (key: string, value: unknown) => facts.push({ source: sourceKindOf(master!), datasetId: master!.datasetId, sourceUrl: master!.dataset.pack.site ?? FOREVERDB_URL, recordKey: key, fields: value as Record<string, DataValue> });
  if (type === 'item' || type === 'npc') {
    available = master !== null || questie !== null;
    if (!master) limitations.push('foreverdb_unavailable');
    if (!questie) limitations.push('questiedb_unavailable');
  } else if (type === 'quest' || type === 'object') available = questie !== null;
  else available = master !== null;
  if (questie && ['item', 'npc', 'quest', 'object'].includes(type)) {
    const entity = questie.get(type as EntityType, id!);
    if (entity) {
      facts.push({ source: 'questiedb', datasetId: questie.datasetId, recordKey: `${type}/${id}`, sourceUrl: questie.dataset.sourceUrl, fields: entity.fields });
      fields = { ...entity.fields };
      locations.push(...questie.locations(entity).map((point) => ({ ...point, source: 'questiedb' as const })));
      limitations.push(...questie.dataset.limitations);
    }
  }
  if (master) {
    if (type === 'item') {
      const item = master.getItem(id!);
      if (item.data) {
        addMaster(`item/${id}`, item.data);
        limitations.push(...item.limitations);
        fields = { ...fields, ...item.data, name: item.data.name ?? fields.name ?? null } as Record<string, DataValue>;
      } else limitations.push('foreverdb_item_missing: recipe links and change notes are unknown');
    } else if (type === 'recipe') {
      const result = master.getRecipe(id!);
      if (result.data) {
        recipe = result.data;
        const { limitations: _limitations, ...value } = recipe;
        fields = value as unknown as Record<string, DataValue>;
        addMaster(`recipes/${id}`, value);
        limitations.push(...result.limitations);
      }
    } else if (type === 'npc') {
      const dataset = master.dataset as DecodedDataset;
      const npc = dataset.npcs?.[String(id)];
      if (npc) {
        const offers = Object.values(dataset.vendorOffers ?? {}).flat().filter((offer) => offer.npcId === id);
        const value = { ...npc, vendorOffers: offers };
        addMaster(`npc/${id}`, value);
        fields = { ...fields, ...value } as unknown as Record<string, DataValue>;
        const zoneName = zoneNameOf(npc.uiMapId);
        locations.push({
          source: sourceKindOf(master), type: 'npc', id: npc.id, title: npc.name,
          uiMapId: npc.uiMapId, zoneName, x: npc.x, y: npc.y,
          approxLocation: zoneName !== null && npc.x !== null && npc.y !== null
            ? { title: npc.name, zoneName, x: npc.x, y: npc.y, basis: `ForeverDB NPC record, NPC ${npc.id}`, sourceUrl: master.dataset.pack.site ?? FOREVERDB_URL } : null,
        });
      }
      const trainers = master.dataset.trainers.filter((trainer) => trainer.npcId === id);
      if (trainers.length) {
        const groups = trainers.map(({ profession, classToken }) => ({ profession, classToken }));
        addMaster(`trainers/npc/${id}`, { name: trainers[0]!.name, trainerGroups: groups, trainerRecords: trainers });
        fields = { ...fields, name: fields.name ?? trainers[0]!.name, trainerGroups: groups };
        if (!npc) locations.push(...trainers.map((trainer) => trainerPoint(master, trainer)));
        limitations.push('trainer_is_candidate: group membership does not prove teaching a particular recipe');
      }
    } else if (type !== 'quest' && type !== 'object') {
      const result = master.getGameRecord(type as DatasetType, recordKey!);
      if (result.data) {
        const value = result.data.fields;
        fields = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value };
        addMaster(`${type}/${recordKey}`, fields);
        limitations.push(...result.limitations);
      }
    }
  }
  const conflicts: { field: string; values: { source: ReferenceFact['source']; value: DataValue }[] }[] = [];
  for (const field of new Set(facts.flatMap((fact) => Object.keys(fact.fields)))) {
    const values = facts.filter((fact) => fact.fields[field] != null).map((fact) => ({ source: fact.source, value: fact.fields[field]! }));
    if (new Set(values.map(({ value }) => JSON.stringify(value))).size > 1) conflicts.push({ field, values });
  }
  if (conflicts.length) limitations.push(`source_conflicts: ${conflicts.map(({ field }) => field).join(', ')}; inspect each source separately`);
  const project = (value: Record<string, DataValue>) => {
    const result = boundedFields({ fields: value }, args.fields);
    if (result.truncatedFields.length) limitations.push(`truncated_fields: ${result.truncatedFields.join(', ')}`);
    return result.fields;
  };
  const projected = project(fields);
  const projectedFacts = facts.map((fact) => ({ ...fact, fields: project(fact.fields) }));
  const missing = args.fields.filter((field) => !(field in fields));
  if (missing.length) limitations.push(`fields_not_present: ${missing.join(', ')}`);
  if (locations.length > 20) limitations.push(`locations_truncated: first 20 of ${locations.length}`);
  const names: Record<string, string | null> = {};
  if (recipe) for (const item of [recipe.outputItemId, recipe.taughtByItemId, ...recipe.reagents.map(({ itemId }) => itemId)]) {
    if (item !== null) names[String(item)] = master?.dataset.names[String(item)] ?? questie?.get('item', item)?.name ?? null;
  }
  return {
    available, found: facts.length > 0, facts: projectedFacts, recipe, names,
    fields: projected, name: typeof fields.name === 'string' ? fields.name : recipe?.outputItemId ? names[String(recipe.outputItemId)] ?? null : null,
    locations: locations.slice(0, 20), conflicts, limitations: [...new Set(limitations)],
  };
}
