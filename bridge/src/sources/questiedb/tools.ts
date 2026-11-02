import { zoneNameOf } from '../zones.js';
import { normalizeText } from '../forevermaster/search.js';
import { ENTITY_TYPES, type EntityType, type QuestieDataset, type QuestieEntity } from './decode.js';
import type { DataValue } from './cbor.js';

export const SERVICE_TYPES = ['auctioneer', 'mailbox', 'banker', 'innkeeper', 'flight_master', 'vendor', 'trainer', 'repair', 'stable_master'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
const FLAGS: Record<Exclude<ServiceType, 'mailbox'>, string> = {
  auctioneer: 'AUCTIONEER', banker: 'BANKER', innkeeper: 'INNKEEPER', flight_master: 'FLIGHT_MASTER',
  vendor: 'VENDOR', trainer: 'TRAINER', repair: 'REPAIR', stable_master: 'STABLEMASTER',
};
export const WORLD_PAGE_SIZE = 20;
export interface WorldLocation {
  type: 'npc' | 'object';
  id: number;
  title: string;
  areaId: number;
  uiMapId: number;
  zoneName: string;
  /** QuestieDB stores percentages, not 0..1 fractions. */
  x: number;
  y: number;
  phase: DataValue;
  approxLocation: { title: string; zoneName: string; x: number; y: number; basis: string; sourceUrl: string };
}
export interface WorldCharacter {
  faction: string | null;
  zoneName: string | null;
  uiMapId: number | null;
  x: number | null;
  y: number | null;
}
interface Indexed { entity: QuestieEntity; texts: string[] }

export class QuestieSource {
  readonly counts: Record<EntityType, number>;
  private readonly index: Indexed[];
  constructor(readonly dataset: QuestieDataset) {
    this.counts = Object.fromEntries(ENTITY_TYPES.map((type) => [type, Object.keys(dataset.entities[type]).length])) as Record<EntityType, number>;
    this.index = ENTITY_TYPES.flatMap((type) => Object.values(dataset.entities[type]).map((entity) => ({
      entity, texts: [entity.name, ...entity.localizedNames, entity.fields.subName].filter((s): s is string => typeof s === 'string').map(normalizeText),
    })));
  }
  get datasetId(): string { return this.dataset.datasetId; }
  get(type: EntityType, id: number): QuestieEntity | null { return this.dataset.entities[type][String(id)] ?? null; }
  status() {
    return { available: true, datasetId: this.datasetId, version: this.dataset.version, flavor: 'Forever', buildCommit: this.dataset.buildCommit, counts: this.counts, sourceUrl: this.dataset.sourceUrl, limitations: this.dataset.limitations };
  }

  search(query: string, types: readonly EntityType[], offset = 0, limit = WORLD_PAGE_SIZE) {
    const text = normalizeText(query);
    const numeric = /^\d+$/.test(text) ? Number(text) : null;
    const matches = this.index.flatMap(({ entity, texts }) => {
      if (types.length && !types.includes(entity.type)) return [];
      let rank = entity.id === numeric ? 0 : 4;
      if (text) for (const candidate of texts) rank = Math.min(rank, candidate === text ? 1 : candidate.startsWith(text) ? 2 : candidate.includes(text) ? 3 : 4);
      if (rank === 4) return [];
      return [{ type: entity.type, id: entity.id, name: entity.name, localizedNames: entity.localizedNames, title: typeof entity.fields.subName === 'string' ? entity.fields.subName : null, rank }];
    });
    matches.sort((a, b) => a.rank - b.rank || a.type.localeCompare(b.type) || a.id - b.id);
    return { hits: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null };
  }

  locations(entity: QuestieEntity): WorldLocation[] {
    if (entity.type !== 'npc' && entity.type !== 'object') return [];
    const spawns = entity.fields.spawns;
    if (!spawns || typeof spawns !== 'object') return [];
    const result: WorldLocation[] = [];
    const areas = Array.isArray(spawns) ? spawns.map((points, index) => [String(index + 1), points] as const) : Object.entries(spawns);
    for (const [areaId, points] of areas) {
      const area = this.dataset.areas[areaId];
      if (!area || !Array.isArray(points)) continue;
      const zoneName = zoneNameOf(area.uiMapId) ?? area.name;
      for (const point of points) {
        if (!Array.isArray(point)) continue;
        const [x, y] = point;
        if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0 || x > 100 || y > 100) continue;
        result.push({
          type: entity.type, id: entity.id, title: entity.name, areaId: Number(areaId), uiMapId: area.uiMapId, zoneName, x, y, phase: point[2] ?? null,
          approxLocation: { title: entity.name, zoneName, x, y, basis: `QuestieDB Forever ${this.dataset.version}, ${entity.type} ${entity.id}, area ${areaId}`, sourceUrl: this.dataset.sourceUrl },
        });
      }
    }
    return result;
  }

  findServices(service: ServiceType, itemId: number | null, zoneName: string | null, who: WorldCharacter, offset = 0, limit = WORLD_PAGE_SIZE) {
    const item = itemId === null ? null : this.get('item', itemId);
    const vendors = item?.fields.vendors;
    const vendorIds = new Set(Array.isArray(vendors) ? vendors.filter((v): v is number => typeof v === 'number') : []);
    const entities = Object.values(this.dataset.entities[service === 'mailbox' ? 'object' : 'npc']);
    const faction = who.faction === 'alliance' ? 'A' : who.faction === 'horde' ? 'H' : null;
    const matches = entities.flatMap((entity) => {
      if (entity.name.startsWith('[DND]')) return [];
      if (service === 'mailbox') {
        if (normalizeText(entity.name) !== 'mailbox') return [];
      } else {
        const mask = this.dataset.npcFlags[FLAGS[service]];
        const flags = entity.fields.npcFlags;
        if (!mask || typeof flags !== 'number' || Math.floor(flags / mask) % 2 !== 1) return [];
        const friendly = entity.fields.friendlyToFaction;
        if (faction && typeof friendly === 'string' && !friendly.includes(faction)) return [];
      }
      if (itemId !== null && !vendorIds.has(entity.id)) return [];
      return this.locations(entity).filter((location) => zoneName === null || normalizeText(location.zoneName) === normalizeText(zoneName)).map((location) => {
        const inCharacterZone = who.uiMapId !== null ? location.uiMapId === who.uiMapId : who.zoneName !== null && normalizeText(location.zoneName) === normalizeText(who.zoneName);
        const distance = inCharacterZone && location.uiMapId === who.uiMapId && who.x !== null && who.y !== null
          ? Math.hypot(location.x - who.x * 100, location.y - who.y * 100) : null;
        return { ...location, service, friendlyToFaction: entity.fields.friendlyToFaction ?? null, factionId: entity.fields.factionID ?? null, inCharacterZone, distanceOnMap: distance };
      });
    });
    matches.sort((a, b) => Number(b.inCharacterZone) - Number(a.inCharacterZone) || (a.distanceOnMap ?? Infinity) - (b.distanceOnMap ?? Infinity) || a.id - b.id || a.areaId - b.areaId || a.x - b.x || a.y - b.y);
    return { services: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null };
  }
}

/** Keep single-entity tool results bounded while disclosing each truncated field. */
export function boundedFields(entity: Pick<QuestieEntity, 'fields'>, requested: readonly string[] = []): { fields: Record<string, DataValue>; truncatedFields: string[] } {
  const truncated = new Set<string>();
  const fields: Record<string, DataValue> = {};
  let textLeft = 4000;
  let nodesLeft = 800;
  for (const [name, field] of Object.entries(entity.fields)) {
    if (requested.length && !requested.includes(name)) continue;
    let left = 150;
    const trim = (value: DataValue, depth: number): DataValue => {
      if (--left < 0 || --nodesLeft < 0 || depth > 12) { truncated.add(name); return null; }
      if (typeof value === 'string') {
        const text = value.slice(0, Math.min(2000, Math.max(0, textLeft)));
        textLeft -= text.length;
        if (text.length < value.length) truncated.add(name);
        return text;
      }
      if (value === null || typeof value !== 'object') return value;
      if (Array.isArray(value)) {
        const length = Math.min(30, Math.max(0, left), Math.max(0, nodesLeft));
        if (value.length > length) truncated.add(name);
        return value.slice(0, length).map((v) => trim(v, depth + 1));
      }
      const entries = Object.entries(value);
      const length = Math.min(30, Math.max(0, left), Math.max(0, nodesLeft));
      if (entries.length > length) truncated.add(name);
      return Object.fromEntries(entries.slice(0, length).map(([key, v]) => [key, trim(v, depth + 1)]));
    };
    fields[name] = trim(field, 0);
  }
  return { fields, truncatedFields: [...truncated] };
}
