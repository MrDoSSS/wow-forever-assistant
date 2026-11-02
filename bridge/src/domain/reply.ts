// Validate model output and replace issued refIds with records.
// References belong to this attempt or the first attempt for the same question.
import { z } from 'zod';
import {
  Calculation,
  GameReply,
  ModelReply,
  VerifiedItem,
  VerifiedLocation,
  utf8ByteLength,
  LIMITS,
  type GamePlan,
  type GamePlanStep,
  type HistoryEntry,
  type MapLocation,
} from '../contracts.js';
import type { Store, VerifiedRefRow } from '../storage/store.js';
import { PROFESSION_SKILL_IDS } from './alts.js';
import { fitFont } from './glyphs.js';

export type ReplyCheck = { ok: true; reply: GameReply } | { ok: false; reason: string };

// Reply text markers: the addon replaces them inline with item or map links.
const MARKER = /\[\[([^\]]*)\]\]/g;
const ITEM_MARKER = /^item:([0-9a-f]{32})$/;
const MAP_MARKER = /^map:([1-9][0-9]*)$/;

/** Rejection reason for text markers, or null. */
export function checkTextMarkers(text: string, itemRefIds: readonly string[], locations: boolean | number): string | null {
  const count = typeof locations === 'boolean' ? Number(locations) : locations;
  for (const match of text.matchAll(MARKER)) {
    const body = match[1]!;
    const item = ITEM_MARKER.exec(body);
    if (item) {
      if (!itemRefIds.includes(item[1]!)) return `text marker [[item:${item[1]}]] is not in itemRefIds`;
    } else if (body === 'map') {
      if (count === 0) return 'text marker [[map]] needs locationRefId or approxLocation, or locations';
      if (count > 1) return 'multiple locations require indexed markers such as [[map:1]] and [[map:2]]';
    } else if (MAP_MARKER.test(body)) {
      const index = Number(MAP_MARKER.exec(body)![1]);
      if (index > count) return `text marker [[${body}]] is outside the ${count} locations`;
    } else {
      return `unknown text marker [[${body.slice(0, 40)}]]: use [[item:<itemRefId>]] or [[map:<index>]]`;
    }
  }
  return null;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

// Player-visible text must fit the addon's font (domain/glyphs.ts).
// Keep zone and character names unchanged: map lookup and mail addressing depend on them.
function fitReplyText(reply: ModelReply): ModelReply {
  const fit = (text: string) => fitFont(text) || '-';
  const approx = <T extends { title: string; basis: string } | null>(point: T): T =>
    point === null ? point : { ...point, title: fit(point.title), basis: fit(point.basis) };
  return {
    ...reply,
    text: fit(reply.text),
    clarification: reply.clarification === null ? null : fit(reply.clarification),
    limitations: reply.limitations.map(fit),
    approxLocation: approx(reply.approxLocation),
    ...(reply.locations ? { locations: reply.locations.map((point) => ({ ...point, approxLocation: approx(point.approxLocation) })) } : {}),
    ...(reply.plan
      ? { plan: { ...reply.plan, title: fit(reply.plan.title), steps: reply.plan.steps.map((step) => ({ ...step, text: fit(step.text) })) } }
      : {}),
  };
}

export function verifyModelReply(output: unknown, store: Store, attemptIds: readonly string[]): ReplyCheck {
  const parsed = ModelReply.safeParse(output);
  if (!parsed.success) return { ok: false, reason: `schema: ${describeIssues(parsed.error)}` };
  const reply = fitReplyText(parsed.data);

  const ownRef = (refId: string, kind: VerifiedRefRow['kind']): VerifiedRefRow | string => {
    const row = store.getVerifiedRef(refId);
    if (!row) return `unknown ${kind} ref ${refId}`;
    if (row.kind !== kind) return `ref ${refId} is ${row.kind}, not ${kind}`;
    if (!attemptIds.includes(row.attempt_id)) return `ref ${refId} belongs to another request`;
    return row;
  };

  const itemRefs: VerifiedItem[] = [];
  for (const refId of reply.itemRefIds) {
    const row = ownRef(refId, 'item');
    if (typeof row === 'string') return { ok: false, reason: row };
    itemRefs.push(VerifiedItem.parse(JSON.parse(row.body_json)));
  }

  const count = reply.locations?.length || Number(reply.locationRefId !== null || reply.approxLocation !== null);
  const markers = checkTextMarkers(reply.text, reply.itemRefIds, count);
  if (markers) return { ok: false, reason: markers };

  let locationRef: VerifiedLocation | null = null;
  if (reply.locationRefId !== null) {
    const row = ownRef(reply.locationRefId, 'location');
    if (typeof row === 'string') return { ok: false, reason: row };
    locationRef = VerifiedLocation.parse(JSON.parse(row.body_json));
  }

  const locations: MapLocation[] = [];
  for (const point of reply.locations ?? []) {
    let ref: VerifiedLocation | null = null;
    if (point.locationRefId !== null) {
      const row = ownRef(point.locationRefId, 'location');
      if (typeof row === 'string') return { ok: false, reason: row };
      ref = VerifiedLocation.parse(JSON.parse(row.body_json));
    }
    locations.push({ locationRef: ref, approxLocation: point.approxLocation });
  }

  for (const calculationId of reply.calculationIds) {
    const row = ownRef(calculationId, 'calculation');
    if (typeof row === 'string') return { ok: false, reason: row };
    Calculation.parse(JSON.parse(row.body_json));
  }

  for (const evidenceId of reply.evidenceIds) {
    if (!store.isEvidenceLinked(attemptIds, evidenceId)) {
      return { ok: false, reason: `evidence ${evidenceId} is not linked to this request` };
    }
  }

  // Plan items must reference this attempt's items; points index the reply's locations. The addon
  // fills mail automatically, so sender, recipient and an attachment are required.
  let plan: GamePlan | null = null;
  if (reply.plan) {
    const steps: GamePlanStep[] = [];
    for (const [index, step] of reply.plan.steps.entries()) {
      const at = `plan step ${index + 1}`;
      let item: VerifiedItem | null = null;
      if (step.itemRefId !== null) {
        const row = ownRef(step.itemRefId, 'item');
        if (typeof row === 'string') return { ok: false, reason: `${at}: ${row}` };
        item = VerifiedItem.parse(JSON.parse(row.body_json));
      }
      if (step.location !== null && step.location > count) {
        return { ok: false, reason: `${at}: location ${step.location} is outside the ${count} locations` };
      }
      const mail = step.kind === 'mail';
      const collect = step.kind === 'collect';
      if ((step.kind === 'login' || collect) && step.character === null) {
        return { ok: false, reason: `${at}: ${step.kind} needs character` };
      }
      if (collect && (step.mailFrom === null || step.mailFrom.toLowerCase() === step.character!.toLowerCase())) {
        return { ok: false, reason: `${at}: collect needs mailFrom, another character than the recipient` };
      }
      let skillId: number | null = null;
      if (step.skillRank !== null) {
        const name = Object.keys(PROFESSION_SKILL_IDS).find((p) => p.toLowerCase() === (step.profession ?? '').toLowerCase());
        if (!name) return { ok: false, reason: `${at}: skillRank needs profession, one of ${Object.keys(PROFESSION_SKILL_IDS).join(', ')}` };
        skillId = PROFESSION_SKILL_IDS[name]!;
      }
      if (mail) {
        if (step.character === null || step.mailTo === null) return { ok: false, reason: `${at}: mail needs character (the sender) and mailTo` };
        if (step.character.toLowerCase() === step.mailTo.toLowerCase()) return { ok: false, reason: `${at}: mail sender and mailTo are the same character` };
        if (item === null && !step.moneyCopper) return { ok: false, reason: `${at}: mail needs itemRefId with quantity, or moneyCopper` };
        if (item !== null && step.quantity === null) return { ok: false, reason: `${at}: mail with an item needs quantity` };
      }
      steps.push({
        kind: step.kind,
        text: step.text,
        character: step.character,
        item,
        quantity: step.quantity,
        location: step.location,
        mailTo: mail ? step.mailTo : null,
        moneyCopper: mail && step.moneyCopper ? step.moneyCopper : null,
        recipeSpellId: step.recipeSpellId,
        mailFrom: collect ? step.mailFrom : null,
        skillId,
        skillRank: skillId === null ? null : step.skillRank,
      });
    }
    plan = { title: reply.plan.title, steps, revises: reply.plan.revisesActivePlan };
  }

  const game = GameReply.safeParse({
    status: reply.status,
    text: reply.text,
    itemRefs,
    evidenceIds: reply.evidenceIds,
    locationRef,
    approxLocation: reply.approxLocation,
    locations,
    calculationIds: reply.calculationIds,
    limitations: reply.limitations,
    clarification: reply.clarification,
    ...(plan ? { plan } : {}),
  });
  if (!game.success) return { ok: false, reason: `game reply: ${describeIssues(game.error)}` };
  return { ok: true, reply: game.data };
}

/**
 * History entry text: append the needs_data clarification if it fits
 * and is not already present (the model sometimes repeats it in text).
 */
export function historyTextOf(reply: GameReply): string {
  if (reply.clarification === null || reply.text.includes(reply.clarification.trim())) return reply.text;
  const combined = `${reply.text}\n\n${reply.clarification}`;
  return utf8ByteLength(combined) <= LIMITS.replyTextBytes ? combined : reply.text;
}

export function assistantEntryFields(reply: GameReply): Pick<
  Extract<HistoryEntry, { role: 'assistant' }>,
  'text' | 'itemRefs' | 'locationRef' | 'locations' | 'plan'
> {
  return {
    text: historyTextOf(reply),
    itemRefs: reply.itemRefs,
    locationRef: reply.locationRef,
    locations: reply.locations ?? [],
    ...(reply.plan ? { plan: reply.plan } : {}),
  };
}
