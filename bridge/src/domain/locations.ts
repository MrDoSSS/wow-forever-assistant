// Map points. A verified location needs a mapKey from a client-verified
// map mapping. The question snapshot supplies this mapping: the client reports
// that its current uiMapID has a zone name (GetBestMapForUnit +
// GetZoneText). If that name matches our table for the same uiMapID,
// the client confirms ForeverMaster's coordinate system for that map. Other
// maps remain unverified (ApproxLocation).
import type { Snapshot, VerifiedLocation } from '../contracts.js';
import { zoneNameOf } from '../sources/zones.js';

const MAP_KEY = /^uiMap:(\d+)$/;

export function mapKeyOf(uiMapId: number): string {
  return `uiMap:${uiMapId}`;
}

export function uiMapIdOf(mapKey: string): number | null {
  const match = MAP_KEY.exec(mapKey);
  return match ? Number(match[1]) : null;
}

const normalize = (name: string) => name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** uiMapID confirmed by the client in this snapshot, or null. */
export function confirmedMapOf(snapshot: Snapshot): number | null {
  const position = snapshot.groups.position;
  if (position.availability !== 'available' || position.value.mapKey === null) return null;
  const uiMapId = uiMapIdOf(position.value.mapKey);
  if (uiMapId === null) return null;
  const expected = zoneNameOf(uiMapId);
  return expected !== null && normalize(expected) === normalize(position.value.zoneName) ? uiMapId : null;
}

export interface LocatedEntity {
  entityKind: VerifiedLocation['entityKind'];
  entityId: string;
  /** Point label such as an NPC or dungeon name. */
  title: string | null;
  uiMapId: number | null;
  /** Coordinates as 0..1 fractions of uiMapId. */
  x: number | null;
  y: number | null;
}

/** VerifiedLocation body without refId if the entity's map is confirmed; otherwise null. */
export function verifiedLocationOf(entity: LocatedEntity, confirmedMap: number | null, evidenceIds: string[]): Omit<VerifiedLocation, 'refId'> | null {
  if (confirmedMap === null || entity.uiMapId !== confirmedMap || entity.x === null || entity.y === null) return null;
  return { entityKind: entity.entityKind, entityId: entity.entityId, title: entity.title, mapKey: mapKeyOf(confirmedMap), x: entity.x, y: entity.y, evidenceIds };
}
