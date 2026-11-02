// Service lookup across the same snapshots as record lookup and search.
// ForeverDB supplies trainer specializations; QuestieDB supplies general services.
import type { TrainerRecord, DecodedDataset } from './foreverdb/decode.js';
import { normalizeText } from './foreverdb/search.js';
import { type QuestieSource, type ServiceType, type WorldCharacter } from './questiedb/tools.js';
import { trainerPoint, sourceKindOf, type ReferenceSource, type ReferencePoint } from './records.js';
import { zoneNameOf } from './zones.js';

export interface ServiceFilter {
  service: ServiceType;
  itemId: number | null;
  zoneName: string | null;
  profession: string | null;
  classToken: string | null;
}
export interface ServiceRecord {
  source: ReferencePoint['source'];
  datasetId: string;
  profession: string | null;
  classToken: string | null;
}
export interface ServicePoint extends ReferencePoint {
  service: ServiceType;
  friendlyToFaction: string | null;
  factionId: number | null;
  trainerGroups: { profession: string | null; classToken: string | null }[];
  sources: ServiceRecord[];
  alternateLocations: ReferencePoint[];
  inCharacterZone: boolean;
  distanceOnMap: number | null;
  /** Static purchase quote; price is for vendorStack items, not a live stock check. */
  vendorPriceCopper?: number;
  vendorStack?: number;
  unitPriceCopper?: number;
  limitedStock?: number;
  priceSource?: 'forever' | 'classic' | 'unknown';
}
const matchesTrainer = (trainer: TrainerRecord, filter: ServiceFilter) =>
  (filter.profession === null || trainer.profession?.toLowerCase() === filter.profession.toLowerCase()) &&
  (filter.classToken === null || trainer.classToken?.toUpperCase() === filter.classToken.toUpperCase());

export function findServices(master: ReferenceSource | null, questie: QuestieSource | null, filter: ServiceFilter, who: WorldCharacter, offset = 0) {
  const specialized = filter.profession !== null || filter.classToken !== null;
  const trainer = filter.service === 'trainer';
  const vendor = filter.service === 'vendor';
  const vendorData = master?.dataset as DecodedDataset | undefined;
  const limitations: string[] = [];
  const available = specialized ? master !== null : questie !== null || trainer && master !== null || vendor && vendorData?.vendorOffers !== undefined;
  if (trainer && !master) limitations.push('trainer_specializations_unavailable: ForeverDB is required to confirm profession or class');
  if (!questie) limitations.push('questiedb_unavailable');
  if (trainer) limitations.push('trainer_is_candidate: group membership does not prove teaching a particular recipe');
  const faction = who.faction === 'alliance' ? 'A' : who.faction === 'horde' ? 'H' : null;
  const eligible = (master?.dataset.trainers ?? []).filter((candidate) => matchesTrainer(candidate, filter));
  const allowedIds = new Set(eligible.map(({ npcId }) => npcId));
  const groups = new Map<string, ServicePoint>();
  const specializationOf = (id: number) => eligible.filter(({ npcId }) => npcId === id);
  const add = (point: ReferencePoint & Partial<Pick<ServicePoint, 'vendorPriceCopper' | 'vendorStack' | 'unitPriceCopper' | 'limitedStock' | 'priceSource'>>, friendly: string | null, factionId: number | null, records: ServiceRecord[]) => {
    if (filter.zoneName !== null && (point.zoneName === null || normalizeText(point.zoneName) !== normalizeText(filter.zoneName))) return;
    if (faction !== null && friendly !== null && !friendly.includes(faction)) return;
    // Honor known faction metadata from either source, even when the other is missing it.
    const specialization = point.type === 'npc' && trainer ? specializationOf(point.id) : [];
    if (trainer && faction && specialization.length && specialization.every((candidate) => candidate.faction !== 'unknown' && candidate.faction !== who.faction)) return;
    const qFaction = questie?.get('npc', point.id)?.fields.friendlyToFaction;
    if (point.type === 'npc' && faction && typeof qFaction === 'string' && !qFaction.includes(faction)) return;
    const key = `${point.type}/${point.id}/${point.uiMapId}`;
    const existing = groups.get(key);
    const sourceRecords = records.filter((record, index) => records.findIndex((other) => JSON.stringify(other) === JSON.stringify(record)) === index);
    if (existing) {
      existing.sources = [...existing.sources, ...sourceRecords].filter((record, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(record)) === index);
      if (existing.x !== point.x || existing.y !== point.y) existing.alternateLocations.push(point);
      return;
    }
    const inCharacterZone = who.uiMapId !== null ? point.uiMapId === who.uiMapId : !!who.zoneName && !!point.zoneName && normalizeText(who.zoneName) === normalizeText(point.zoneName);
    const distance = inCharacterZone && point.uiMapId === who.uiMapId && who.x !== null && who.y !== null && point.x !== null && point.y !== null
      ? Math.hypot(point.x - who.x * 100, point.y - who.y * 100) : null;
    groups.set(key, {
      ...point, service: filter.service, friendlyToFaction: friendly, factionId,
      trainerGroups: specialization.map(({ profession, classToken }) => ({ profession, classToken })).filter((group, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(group)) === index),
      sources: sourceRecords, alternateLocations: [], inCharacterZone, distanceOnMap: distance,
    });
  };
  if (vendor && master && vendorData?.vendorOffers && vendorData.npcs) {
    const offers = filter.itemId === null ? Object.values(vendorData.vendorOffers).flat() : vendorData.vendorOffers[String(filter.itemId)] ?? [];
    for (const offer of offers) {
      const npc = vendorData.npcs[String(offer.npcId)];
      if (!npc) continue;
      const friendly = npc.faction === 'alliance' ? 'A' : npc.faction === 'horde' ? 'H' : null;
      const zoneName = zoneNameOf(npc.uiMapId);
      add({
        source: sourceKindOf(master), type: 'npc', id: npc.id, title: npc.name,
        uiMapId: npc.uiMapId, zoneName, x: npc.x, y: npc.y,
        approxLocation: zoneName !== null && npc.x !== null && npc.y !== null
          ? { title: npc.name, zoneName, x: npc.x, y: npc.y, basis: `ForeverDB vendor record, NPC ${npc.id}`, sourceUrl: master.dataset.pack.site ?? 'https://foreverdb.net' } : null,
        ...(filter.itemId !== null ? {
          vendorPriceCopper: offer.priceCopper, vendorStack: offer.stack,
          unitPriceCopper: offer.priceCopper / offer.stack,
          limitedStock: offer.limited, priceSource: offer.source,
        } : {}),
      }, friendly, null, [{ source: sourceKindOf(master), datasetId: master.datasetId, profession: null, classToken: null }]);
    }
    limitations.push('vendor_quote: static price per purchase and stack; current stock, discounts and dynamic requirements are not confirmed');
    if (offers.some((offer) => offer.priceCopper === 0)) limitations.push('zero_gold_quote: zero copper is not proof of a free purchase; check additional currency or item costs in the reference');
  }
  if (questie && available) {
    for (const point of questie.findServices(filter.service, filter.itemId, filter.zoneName, who, 0, Infinity).services) {
      if (specialized && !allowedIds.has(point.id)) continue;
      add({ ...point, source: 'questiedb' }, typeof point.friendlyToFaction === 'string' ? point.friendlyToFaction : null, typeof point.factionId === 'number' ? point.factionId : null,
        [{ source: 'questiedb', datasetId: questie.datasetId, profession: null, classToken: null }]);
    }
  }
  if (trainer && master) {
    let hidden = 0;
    for (const candidate of eligible) {
      const friendly = candidate.faction === 'alliance' ? 'A' : candidate.faction === 'horde' ? 'H' : null;
      if (faction && friendly && !friendly.includes(faction)) { hidden++; continue; }
      add(trainerPoint(master, candidate), friendly, null, [{ source: sourceKindOf(master), datasetId: master.datasetId, profession: candidate.profession, classToken: candidate.classToken }]);
    }
    if (hidden) limitations.push(`other_faction_hidden: ${hidden} trainers of the other faction are omitted`);
  }
  const points = [...groups.values()].sort((a, b) => Number(b.inCharacterZone) - Number(a.inCharacterZone) ||
    (a.distanceOnMap ?? Infinity) - (b.distanceOnMap ?? Infinity) || a.id - b.id || (a.uiMapId ?? 0) - (b.uiMapId ?? 0));
  const services: ServicePoint[] = [];
  let bytes = 2;
  let position = offset;
  for (; position < points.length && services.length < 20; position++) {
    const point = points[position]!;
    const limited = { ...point, alternateLocations: point.alternateLocations.slice(0, 3) };
    const size = Buffer.byteLength(JSON.stringify(limited));
    if (bytes + size > 20 * 1024) break;
    if (point.alternateLocations.length > 3) limitations.push(`alternate_locations_truncated: ${point.type}/${point.id}`);
    if (point.alternateLocations.some((other) => other.source !== point.source)) limitations.push(`coordinate_variants: ${point.type}/${point.id}; primary point from ${point.source}, alternatives retained`);
    services.push(limited);
    bytes += size;
  }
  return { services, total: points.length, nextOffset: position < points.length ? position : null, available, limitations };
}
