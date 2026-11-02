// Single source for v1 contracts. These definitions produce
// TypeScript types, runtime validation and JSON Schema in schemas/.
// Only JSON-representable constructs: no transform/default. Checks that
// JSON Schema cannot express (byte limits and field relationships) use refine.
import { z } from 'zod';

export const contractRegistry = z.registry<{ id: string }>();
export const contractSchemas = new Map<string, z.ZodType>();

function named<T extends z.ZodType>(id: string, schema: T): T {
  contractRegistry.add(schema, { id });
  contractSchemas.set(id, schema);
  return schema;
}

export const LIMITS = {
  stringBytes: 1024,
  array: 100,
  largeGroup: 4096,
  equipmentSlots: 19,
  queryTextBytes: 16384,
  replyTextBytes: 65536,
  queryItemRefs: 64,
  pendingRequests: 8,
  appliedDeliveryIds: 64,
  receipts: 64,
  historyEntries: 20,
  acceptedMessageKeys: 128,
  packetDeliveries: 100,
  messageBytes: 131072,
  inboxLuaBytes: 262144,
  ipcFrameBytes: 131072,
  itemLookupItems: 20,
  tooltipLines: 40,
  mapLocations: 20,
  planSteps: 30,
} as const;

const LONE_SURROGATE = /\p{Cs}/u;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// JSON Schema counts characters; code enforces the exact byte limit.
function utf8String(minBytes: number, maxBytes: number) {
  return z
    .string()
    .min(minBytes)
    .max(maxBytes)
    .refine((value) => {
      if (LONE_SURROGATE.test(value)) return false;
      const bytes = utf8ByteLength(value);
      return bytes >= minBytes && bytes <= maxBytes;
    }, `UTF-8 string of ${minBytes}..${maxBytes} bytes`);
}

function uniqueBy<T>(key: (item: T) => string, message: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const [index, item] of items.entries()) {
      const k = key(item);
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [index], message });
      seen.add(k);
    }
  };
}

// ---------------------------------------------------------------------------
// Shared scalar types

export const H = named('H', z.string().regex(/^[0-9a-f]{32}$/));
export const CharacterKey = named('CharacterKey', z.string().regex(/^[0-9a-f]{64}$/));
export const U32 = named('U32', z.int().min(1).max(4294967295));
export const N = named('N', z.int().min(0).max(Number.MAX_SAFE_INTEGER));
export const ID = named('ID', z.int().min(1).max(2147483647));
export const S = named('S', utf8String(1, LIMITS.stringBytes));
export const S0 = named('S0', utf8String(0, LIMITS.stringBytes));

const Unit = z.number().min(0).max(1);

export const ERROR_CODES = [
  'model_error',
  'invalid_result',
  'external_outcome_unknown',
  'process_stop_unconfirmed',
  'process_host_unavailable',
  'model_profile_unsupported',
  'busy',
  'history_changed',
  'history_cleared',
  'storage_error',
] as const;
export const ErrorCode = named('ErrorCode', z.enum(ERROR_CODES));
export type ErrorCode = z.output<typeof ErrorCode>;

// ---------------------------------------------------------------------------
// Identity, items and keys

export const Identity = named(
  'Identity',
  z.object({ serverNamespace: S, realm: S, playerGuid: S, displayName: S }),
);
export type Identity = z.output<typeof Identity>;

// Link color: 8 hex digits (classic) or quality `nIQ4:` (newer clients).
const ITEM_LINK = /^\|c(?:[0-9a-fA-F]{8}|n[A-Za-z0-9_]+:)\|Hitem:(\d+)(?::[^|]*)?\|h\[[^|]*\]\|h\|r$/;

export function itemLinkId(link: string): number | null {
  const match = ITEM_LINK.exec(link);
  return match ? Number(match[1]) : null;
}

export const ItemInput = named(
  'ItemInput',
  z.object({ itemId: ID, itemLink: S.nullable() }).superRefine((item, ctx) => {
    if (item.itemLink !== null && itemLinkId(item.itemLink) !== item.itemId) {
      ctx.addIssue({
        code: 'custom',
        path: ['itemLink'],
        message: 'itemLink must be a client item link with the same itemId',
      });
    }
  }),
);
export type ItemInput = z.output<typeof ItemInput>;

export const RequestKey = named(
  'RequestKey',
  z.object({ characterKey: CharacterKey, originSessionId: H, requestId: U32 }),
);
export type RequestKey = z.output<typeof RequestKey>;

export const MessageKey = named('MessageKey', z.object({ originSessionId: H, messageSequence: U32 }));
export type MessageKey = z.output<typeof MessageKey>;

// ---------------------------------------------------------------------------
// Prices shared by snapshots and PRICE_RESULT

export const PRICE_UNAVAILABLE_REASONS = [
  'api_unavailable',
  'call_error',
  'not_ready',
  'no_price',
  'price_lookup_timeout',
] as const;
export const PriceUnavailableReason = named('PriceUnavailableReason', z.enum(PRICE_UNAVAILABLE_REASONS));

export const PriceObservation = named(
  'PriceObservation',
  z
    .object({
      item: ItemInput,
      marketKey: S,
      unit: z.literal('per_item'),
      priceCopper: N.nullable(),
      readOriginSessionId: H,
      readAtSessionMs: N,
      sourceObservedAtMs: N.nullable(),
      ageDays: N.nullable(),
      agePrecision: z.enum(['day_bucket', 'unknown']),
      rawExactness: z.boolean().nullable(),
      exactness: z.enum(['exact', 'fallback', 'unknown']),
      source: z.literal('auctionator_v1'),
      sourceVersion: S,
      unavailableReason: PriceUnavailableReason.nullable(),
    })
    .superRefine((o, ctx) => {
      if ((o.priceCopper === null) === (o.unavailableReason === null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unavailableReason'],
          message: 'priceCopper=null requires a reason; a number requires unavailableReason=null',
        });
      }
      if (o.sourceObservedAtMs !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['sourceObservedAtMs'],
          message: 'auctionator_v1 has no source observation time',
        });
      }
      if ((o.ageDays !== null) !== (o.agePrecision === 'day_bucket')) {
        ctx.addIssue({
          code: 'custom',
          path: ['agePrecision'],
          message: 'agePrecision=day_bucket exactly when ageDays is known',
        });
      }
    }),
);
export type PriceObservation = z.output<typeof PriceObservation>;

export const Calculation = named(
  'Calculation',
  z.object({
    calculationId: H,
    recipeRefId: H,
    crafts: N,
    lines: z
      .array(z.object({ itemId: ID, needed: N, knownOwned: N.nullable(), missing: N.nullable() }))
      .max(LIMITS.array),
    priceTotalCopper: N.nullable(),
    unpricedItemIds: z.array(ID).max(LIMITS.array),
    limitations: z.array(S).max(LIMITS.array),
  }),
);
export type Calculation = z.output<typeof Calculation>;

// ---------------------------------------------------------------------------
// Snapshots and context policy

export const GROUP_NAMES = [
  'character',
  'equipment',
  'quests',
  'talents',
  'position',
  'bags',
  'professions',
  'prices',
] as const;
export const GroupName = named('GroupName', z.enum(GROUP_NAMES));
export type GroupName = z.output<typeof GroupName>;

const GroupUnavailable = named(
  'GroupUnavailable',
  z.object({
    availability: z.literal('unavailable'),
    coverage: z.literal('unknown'),
    observedAtSessionMs: z.null(),
    reason: z.enum(['api_unavailable', 'not_ready']),
    value: z.null(),
  }),
);

const GroupDisabled = named(
  'GroupDisabled',
  z.object({
    availability: z.literal('disabled'),
    coverage: z.literal('unknown'),
    observedAtSessionMs: z.null(),
    reason: z.literal('user_disabled'),
    value: z.null(),
  }),
);

type ValueCheck<T> = (value: T, coverage: 'complete' | 'partial', ctx: z.RefinementCtx) => void;

function group<T extends z.ZodType>(id: string, value: T, check?: ValueCheck<z.output<T>>) {
  const available = named(
    `${id}Available`,
    z
      .object({
        availability: z.literal('available'),
        coverage: z.enum(['complete', 'partial']),
        observedAtSessionMs: N,
        reason: z.enum(['api_unavailable', 'not_ready', 'partial_limit']).nullable(),
        value,
      })
      .superRefine((g, ctx) => {
        if ((g.coverage === 'partial') !== (g.reason !== null)) {
          ctx.addIssue({
            code: 'custom',
            path: ['reason'],
            message: 'partial coverage requires a reason; complete coverage has none',
          });
        }
        check?.((g as { value: z.output<T> }).value, g.coverage, ctx);
      }),
  );
  return named(id, z.discriminatedUnion('availability', [available, GroupUnavailable, GroupDisabled]));
}

const CharacterValue = z.object({
  classToken: S,
  raceToken: S,
  faction: z.enum(['alliance', 'horde', 'neutral', 'unknown']),
  level: ID,
  moneyCopper: N.nullable(),
});

const EquipmentValue = z
  .array(z.object({ slot: z.int().min(1).max(LIMITS.equipmentSlots), item: ItemInput.nullable() }))
  .max(LIMITS.equipmentSlots)
  .superRefine(uniqueBy((e) => String(e.slot), 'duplicate equipment slot'));

const QuestsValue = z
  .array(
    z.object({
      questId: ID,
      title: S0,
      state: z.enum(['active', 'complete', 'failed', 'unknown']),
      objectives: z
        .array(
          z.object({
            index: ID,
            text: S0,
            have: N.nullable(),
            need: N.nullable(),
            complete: z.boolean().nullable(),
          }),
        )
        .max(LIMITS.array),
    }),
  )
  .max(LIMITS.largeGroup)
  .superRefine(uniqueBy((q) => String(q.questId), 'duplicate questId'));

const TalentsValue = z
  .array(
    z
      .object({ tab: ID, index: ID, spellId: ID.nullable(), rank: N, maxRank: N })
      .refine((t) => t.rank <= t.maxRank, { message: 'rank exceeds maxRank', path: ['rank'] }),
  )
  .max(LIMITS.largeGroup)
  .superRefine(uniqueBy((t) => `${t.tab}/${t.index}`, 'duplicate talent tab/index'));

const PositionValue = z
  .object({ mapKey: S.nullable(), x: Unit.nullable(), y: Unit.nullable(), zoneName: S0 })
  .superRefine((p, ctx) => {
    if ((p.x === null) !== (p.y === null)) {
      ctx.addIssue({ code: 'custom', path: ['y'], message: 'x and y are filled together' });
    }
    if (p.x !== null && p.mapKey === null) {
      ctx.addIssue({ code: 'custom', path: ['mapKey'], message: 'coordinates require mapKey' });
    }
  });

const BagsValue = z
  .array(z.object({ bag: z.int().min(0).max(4), slot: ID, item: ItemInput, count: ID }))
  .max(LIMITS.largeGroup)
  .superRefine(uniqueBy((b) => `${b.bag}/${b.slot}`, 'duplicate bag/slot'));

const ProfessionsValue = z
  .array(
    z
      .object({
        skillId: ID,
        name: S,
        rank: N,
        maxRank: N,
        knownRecipeSpellIds: z.array(ID).max(LIMITS.largeGroup).nullable(),
      })
      .refine((p) => p.rank <= p.maxRank, { message: 'rank exceeds maxRank', path: ['rank'] }),
  )
  .max(LIMITS.array)
  .superRefine(uniqueBy((p) => String(p.skillId), 'duplicate skillId'));

const PricesValue = z.array(PriceObservation).max(LIMITS.largeGroup);

export const SnapshotGroups = named(
  'SnapshotGroups',
  z.object({
    character: group('CharacterGroup', CharacterValue),
    equipment: group('EquipmentGroup', EquipmentValue, (value, coverage, ctx) => {
      if (coverage === 'complete' && value.length !== LIMITS.equipmentSlots) {
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'complete equipment lists all 19 slots' });
      }
    }),
    quests: group('QuestsGroup', QuestsValue),
    talents: group('TalentsGroup', TalentsValue),
    position: group('PositionGroup', PositionValue),
    bags: group('BagsGroup', BagsValue),
    professions: group('ProfessionsGroup', ProfessionsValue),
    prices: group('PricesGroup', PricesValue),
  }),
);
export type SnapshotGroups = z.output<typeof SnapshotGroups>;

export const Snapshot = named(
  'Snapshot',
  z.object({ snapshotId: U32, capturedAtSessionMs: N, groups: SnapshotGroups }),
);
export type Snapshot = z.output<typeof Snapshot>;

export const Policy = named(
  'Policy',
  z
    .object({
      revision: U32,
      resetEpoch: N,
      enabledGroups: z.array(GroupName).max(GROUP_NAMES.length),
    })
    .superRefine((p, ctx) => {
      const order = p.enabledGroups.map((g) => GROUP_NAMES.indexOf(g));
      if (order.some((value, i) => i > 0 && value <= order[i - 1]!)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enabledGroups'],
          message: 'enabledGroups are unique and follow the table order',
        });
      }
    }),
);
export type Policy = z.output<typeof Policy>;

/** Canonical policy JSON: revision/resetEpoch/enabledGroups field order. */
export function canonicalPolicyJson(policy: Policy): string {
  return JSON.stringify({
    revision: policy.revision,
    resetEpoch: policy.resetEpoch,
    enabledGroups: policy.enabledGroups,
  });
}

// ---------------------------------------------------------------------------
// Replies

export const REPLY_STATUSES = ['answer', 'partial', 'needs_data', 'error'] as const;
export const ReplyStatus = named('ReplyStatus', z.enum(REPLY_STATUSES));
export type ReplyStatus = z.output<typeof ReplyStatus>;

const ReplyText = utf8String(1, LIMITS.replyTextBytes);

// title names the NPC or place at the point. Older saved replies have no title.
// uiMapId is set by the bridge from the English zoneName so the addon opens the map
// on a client in any language; null when the zone is unknown or in older replies.
export const ApproxLocation = named(
  'ApproxLocation',
  z.strictObject({
    title: S.nullable().default(null),
    zoneName: S,
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100),
    basis: S,
    sourceUrl: S,
    uiMapId: ID.nullable().default(null),
  }),
);
export type ApproxLocation = z.output<typeof ApproxLocation>;

/** The model must name the point; the bridge adds uiMapId. */
const ModelApproxLocation = ApproxLocation.omit({ uiMapId: true }).extend({ title: S });

const ModelMapLocation = z.strictObject({
  locationRefId: H.nullable(),
  approxLocation: ModelApproxLocation.nullable(),
}).refine((point) => (point.locationRefId !== null) !== (point.approxLocation !== null), {
  message: 'each location requires exactly one of locationRefId or approxLocation',
});

// The player's active plan: steps per character, shown in a separate addon window.
export const PLAN_STEP_KINDS = ['get', 'craft', 'learn', 'mail', 'collect', 'login', 'goto', 'do'] as const;
export const PlanStepKind = named('PlanStepKind', z.enum(PLAN_STEP_KINDS));
const PlanTitle = utf8String(1, 128);
const PlanStepText = utf8String(1, 512);
const PlanQuantity = z.int().min(1).max(1_000_000);
const PlanLocation = z.int().min(1).max(LIMITS.mapLocations);
const PlanSkillRank = z.int().min(1).max(450);

const ModelPlanStep = z.strictObject({
  kind: PlanStepKind,
  text: PlanStepText,
  character: S.nullable(),
  itemRefId: H.nullable(),
  quantity: PlanQuantity.nullable(),
  location: PlanLocation.nullable(),
  mailTo: S.nullable(),
  mailFrom: S.nullable(),
  moneyCopper: N.nullable(),
  recipeSpellId: ID.nullable(),
  profession: S.nullable(),
  skillRank: PlanSkillRank.nullable(),
});

export const ModelPlan = z.strictObject({
  title: PlanTitle,
  steps: z.array(ModelPlanStep).min(1).max(LIMITS.planSteps),
  /** A correction to the active plan: the addon replaces the plan automatically. */
  revisesActivePlan: z.boolean(),
});
export type ModelPlan = z.output<typeof ModelPlan>;

type ReplyShape = {
  status: ReplyStatus;
  limitations: string[];
  clarification: string | null;
};

function checkReplyStatus(reply: ReplyShape, ctx: z.RefinementCtx) {
  if ((reply.status === 'needs_data') !== (reply.clarification !== null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['clarification'],
      message: 'needs_data requires clarification; other statuses have clarification=null',
    });
  }
  if ((reply.status === 'partial' || reply.status === 'error') && reply.limitations.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['limitations'],
      message: `${reply.status} requires non-empty limitations`,
    });
  }
}

export const ModelReply = named(
  'ModelReply',
  z
    .strictObject({
      status: ReplyStatus,
      text: ReplyText,
      itemRefIds: z.array(H).max(LIMITS.array),
      evidenceIds: z.array(H).max(LIMITS.array),
      locationRefId: H.nullable(),
      approxLocation: ModelApproxLocation.nullable(),
      locations: z.array(ModelMapLocation).max(LIMITS.mapLocations).optional(),
      calculationIds: z.array(H).max(LIMITS.array),
      limitations: z.array(S).max(LIMITS.array),
      clarification: S.nullable(),
      plan: ModelPlan.nullable().optional(),
    })
    .superRefine((reply, ctx) => {
      checkReplyStatus(reply, ctx);
      if (reply.locationRefId !== null && reply.approxLocation !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['approxLocation'],
          message: 'locationRefId and approxLocation are mutually exclusive',
        });
      }
      if (reply.locations?.length && (reply.locationRefId !== null || reply.approxLocation !== null)) {
        ctx.addIssue({ code: 'custom', path: ['locations'], message: 'locations cannot be combined with legacy single-location fields' });
      }
    }),
);
export type ModelReply = z.output<typeof ModelReply>;

/**
 * Field descriptions in the model output schema, by dotted path (arrays and nullable objects
 * are passed through): the model sees them while writing the reply.
 */
export const MODEL_REPLY_DESCRIPTIONS: Record<string, string> = {
  text:
    'Answer shown in the in-game chat, in the language of the question. Write every item from itemRefIds as [[item:<itemRefId>]] in place of its name and every place as [[map:<index>]] into locations: the addon shows them as named links, so never repeat the name next to a marker.',
  itemRefIds:
    'itemRefIds from get_game_record (type "item") or lookup_items for this question. Get one for every item the answer names, and write each in text as its [[item:<itemRefId>]] marker.',
  'plan.steps.text':
    'Short instruction in the language of the question. Write this step\'s own item as [[item:<its itemRefId>]] and its own place as [[map:<its location>]] instead of their names; no other markers. The plan window shows them as links and adds progress such as 0/1, so add no labels or owned counts.',
};

const EvidenceIds = z.array(H).min(1).max(LIMITS.array);

export const VerifiedItem = named(
  'VerifiedItem',
  z.object({ refId: H, itemId: ID, itemLink: S.nullable(), evidenceIds: EvidenceIds }),
);
export type VerifiedItem = z.output<typeof VerifiedItem>;

// Validated plan step: item is a verified record; location is an index into the reply's points.
export const GamePlanStep = named(
  'GamePlanStep',
  z.object({
    kind: PlanStepKind,
    text: PlanStepText,
    character: S.nullable(),
    item: VerifiedItem.nullable(),
    quantity: PlanQuantity.nullable(),
    location: PlanLocation.nullable(),
    mailTo: S.nullable(),
    moneyCopper: N.nullable(),
    recipeSpellId: ID.nullable(),
    // Fields added after the first plans; older saved replies do not have them.
    mailFrom: S.nullable().default(null),
    skillId: ID.nullable().default(null),
    skillRank: PlanSkillRank.nullable().default(null),
  }),
);
export type GamePlanStep = z.output<typeof GamePlanStep>;

export const GamePlan = named(
  'GamePlan',
  z.object({
    title: PlanTitle,
    steps: z.array(GamePlanStep).min(1).max(LIMITS.planSteps),
    revises: z.boolean().default(false),
  }),
);
export type GamePlan = z.output<typeof GamePlan>;

export const VerifiedLocation = named(
  'VerifiedLocation',
  z.object({
    refId: H,
    entityKind: z.enum(['npc', 'quest', 'dungeon', 'other']),
    entityId: S,
    title: S.nullable().default(null),
    mapKey: S,
    x: Unit,
    y: Unit,
    evidenceIds: EvidenceIds,
    // Why the point is trusted: on the map the client confirmed, or a place ForeverDB
    // players recorded in Forever. Older saved points were all client_map.
    basis: z.enum(['client_map', 'seen_in_forever']).default('client_map'),
  }),
);
export type VerifiedLocation = z.output<typeof VerifiedLocation>;

export const MapLocation = named('MapLocation', z.object({
  locationRef: VerifiedLocation.nullable(),
  approxLocation: ApproxLocation.nullable(),
}).refine((point) => (point.locationRef !== null) !== (point.approxLocation !== null), {
  message: 'each location requires exactly one of locationRef or approxLocation',
}));
export type MapLocation = z.output<typeof MapLocation>;

export const GameReply = named(
  'GameReply',
  z
    .object({
      status: ReplyStatus,
      text: ReplyText,
      itemRefs: z.array(VerifiedItem).max(LIMITS.array),
      evidenceIds: z.array(H).max(LIMITS.array),
      locationRef: VerifiedLocation.nullable(),
      approxLocation: ApproxLocation.nullable(),
      locations: z.array(MapLocation).max(LIMITS.mapLocations).optional(),
      calculationIds: z.array(H).max(LIMITS.array),
      limitations: z.array(S).max(LIMITS.array),
      clarification: S.nullable(),
      plan: GamePlan.nullable().optional(),
    })
    .superRefine((reply, ctx) => {
      checkReplyStatus(reply, ctx);
      if (reply.locationRef !== null && reply.approxLocation !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['approxLocation'],
          message: 'locationRef and approxLocation are mutually exclusive',
        });
      }
      if (reply.locations?.length && (reply.locationRef !== null || reply.approxLocation !== null)) {
        ctx.addIssue({ code: 'custom', path: ['locations'], message: 'locations cannot be combined with legacy single-location fields' });
      }
    }),
);
export type GameReply = z.output<typeof GameReply>;

// Player entries carry their own item links (ItemInput), which have no evidence.
export const HistoryEntry = named(
  'HistoryEntry',
  z.discriminatedUnion('role', [
    z.object({
      entryId: H,
      request: RequestKey,
      role: z.literal('user'),
      text: utf8String(1, LIMITS.queryTextBytes),
      itemRefs: z.array(ItemInput).max(LIMITS.queryItemRefs),
      locationRef: z.null(),
    }),
    z.object({
      entryId: H,
      request: RequestKey,
      role: z.literal('assistant'),
      text: ReplyText,
      itemRefs: z.array(VerifiedItem).max(LIMITS.array),
      locationRef: VerifiedLocation.nullable(),
      locations: z.array(MapLocation).max(LIMITS.mapLocations).optional(),
      plan: GamePlan.nullable().optional(),
    }),
  ]),
);
export type HistoryEntry = z.output<typeof HistoryEntry>;

// ---------------------------------------------------------------------------
// Outgoing addon messages. Extra fields are tolerated.

export const MESSAGE_KINDS = {
  HELLO: 1,
  QUERY: 2,
  CANCEL: 3,
  PRICE_RESULT: 4,
  RECEIPTS: 5,
  POLICY: 6,
  CLEAR_HISTORY: 7,
} as const;
export type MessageType = keyof typeof MESSAGE_KINDS;
export const MESSAGE_TYPES = Object.keys(MESSAGE_KINDS) as MessageType[];

export const HelloBody = named(
  'HelloBody',
  z.object({
    identity: Identity,
    deliverySessionId: H,
    conversationId: H,
    policy: Policy,
    pendingRequests: z.array(RequestKey).max(LIMITS.pendingRequests),
    appliedDeliveryIds: z.array(H).max(LIMITS.appliedDeliveryIds),
    historyCursor: H.nullable(),
  }),
);

// Active plan attached to a question: its source reply and the player's step marks.
export const ActivePlanRef = named(
  'ActivePlanRef',
  z.object({ request: RequestKey, done: z.array(z.boolean()).max(LIMITS.planSteps) }),
);
export type ActivePlanRef = z.output<typeof ActivePlanRef>;

export const QueryBody = named(
  'QueryBody',
  z.object({
    identity: Identity,
    conversationId: H,
    policy: Policy,
    text: utf8String(1, LIMITS.queryTextBytes),
    itemRefs: z.array(ItemInput).max(LIMITS.queryItemRefs),
    snapshot: Snapshot,
    activePlan: ActivePlanRef.nullable().optional(),
  }),
);
export type QueryBody = z.output<typeof QueryBody>;

export const CancelBody = named('CancelBody', z.object({ request: RequestKey }));

// Client item information (lookup_items): the Forever client is authoritative
// for item stats. Tooltip lines are kept as displayed, without parsing.
export const ClientItemInfo = named(
  'ClientItemInfo',
  z.object({
    item: ItemInput,
    name: S.nullable(),
    quality: z.int().min(0).max(10).nullable(),
    itemLevel: N.nullable(),
    requiredLevel: N.nullable(),
    itemType: S.nullable(),
    itemSubType: S.nullable(),
    equipSlot: S.nullable(),
    sellPriceCopper: N.nullable(),
    tooltip: z.array(S).max(LIMITS.tooltipLines),
    unavailableReason: z.enum(['not_cached', 'api_unavailable']).nullable(),
  }),
);
export type ClientItemInfo = z.output<typeof ClientItemInfo>;

// itemInfo belongs to itemInfo=true requests (lookup_items), not price requests.
export const PriceResultBody = named(
  'PriceResultBody',
  z
    .object({
      request: RequestKey,
      lookupId: H,
      observations: z.array(PriceObservation).max(LIMITS.array),
      unavailableReason: PriceUnavailableReason.nullable(),
      itemInfo: z.array(ClientItemInfo).max(LIMITS.itemLookupItems).default([]),
    })
    .superRefine((body, ctx) => {
      if ((body.observations.length === 0) !== (body.unavailableReason !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['unavailableReason'],
          message: 'either observations for the requested items or a general reason with no observations',
        });
      }
    }),
);
export type PriceResultBody = z.output<typeof PriceResultBody>;

export const ReceiptsBody = named(
  'ReceiptsBody',
  z.object({ deliveryIds: z.array(H).min(1).max(LIMITS.receipts) }),
);

export const PolicyBody = named('PolicyBody', z.object({ identity: Identity, policy: Policy }));

export const ClearHistoryBody = named(
  'ClearHistoryBody',
  z
    .object({ identity: Identity, operationId: H, conversationId: H, replacementConversationId: H, deleteChat: z.boolean().optional() })
    .refine((b) => b.conversationId !== b.replacementConversationId, {
      message: 'replacementConversationId must differ from conversationId',
      path: ['replacementConversationId'],
    }),
);

function envelope<T extends MessageType, B extends z.ZodType>(type: T, body: B) {
  return named(
    `${type
      .toLowerCase()
      .split('_')
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join('')}Message`,
    z.object({
      version: z.literal(1),
      type: z.literal(type),
      originSessionId: H,
      messageSequence: U32,
      characterKey: CharacterKey,
      body,
    }),
  );
}

export const Message = named(
  'Message',
  z
    .discriminatedUnion('type', [
      envelope('HELLO', HelloBody),
      envelope('QUERY', QueryBody),
      envelope('CANCEL', CancelBody),
      envelope('PRICE_RESULT', PriceResultBody),
      envelope('RECEIPTS', ReceiptsBody),
      envelope('POLICY', PolicyBody),
      envelope('CLEAR_HISTORY', ClearHistoryBody),
    ])
    .superRefine((message, ctx) => {
      const foreignKey = (key: RequestKey, path: (string | number)[]) => {
        if (key.characterKey !== message.characterKey) {
          ctx.addIssue({ code: 'custom', path, message: 'RequestKey belongs to another character' });
        }
      };
      switch (message.type) {
        case 'HELLO':
          if (message.body.deliverySessionId !== message.originSessionId) {
            ctx.addIssue({
              code: 'custom',
              path: ['body', 'deliverySessionId'],
              message: 'deliverySessionId must equal originSessionId',
            });
          }
          message.body.pendingRequests.forEach((key, i) => foreignKey(key, ['body', 'pendingRequests', i]));
          break;
        case 'QUERY':
          if (message.body.snapshot.snapshotId !== message.messageSequence) {
            ctx.addIssue({
              code: 'custom',
              path: ['body', 'snapshot', 'snapshotId'],
              message: 'snapshotId must equal messageSequence',
            });
          }
          break;
        case 'CANCEL':
        case 'PRICE_RESULT':
          foreignKey(message.body.request, ['body', 'request']);
          break;
      }
    }),
);
export type Message = z.output<typeof Message>;
export type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;

// ---------------------------------------------------------------------------
// Incoming packets: Inbox.lua

export const DELIVERY_TYPES = ['hello', 'history', 'status', 'price_lookup', 'reply', 'error', 'cleared'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const HelloDeliveryBody = named(
  'HelloDeliveryBody',
  z.object({
    conversationId: H,
    policyRevision: U32,
    historyRevision: N,
    capabilities: z.object({ map: z.boolean(), auctionator: z.boolean() }),
    limitations: z.array(S).max(LIMITS.array),
  }),
);

export const HistoryDeliveryBody = named(
  'HistoryDeliveryBody',
  z.object({
    conversationId: H,
    historyRevision: N,
    entries: z.array(HistoryEntry).max(LIMITS.historyEntries),
    nextCursor: H.nullable(),
  }),
);

export const StatusDeliveryBody = named(
  'StatusDeliveryBody',
  z.object({
    state: z.enum(['accepted', 'running', 'cancelled', 'failed']),
    errorCode: ErrorCode.nullable(),
  }),
);

export const PriceLookupDeliveryBody = named(
  'PriceLookupDeliveryBody',
  z.object({ lookupId: H, items: z.array(ItemInput).min(1).max(LIMITS.array), itemInfo: z.boolean().default(false) }),
);

export const ErrorDeliveryBody = named('ErrorDeliveryBody', z.object({ code: ErrorCode, text: S }));

export const ClearedDeliveryBody = named(
  'ClearedDeliveryBody',
  z.object({
    operationId: H,
    oldConversationId: H,
    replacementConversationId: H,
    historyRevision: N,
  }),
);

function delivery<T extends DeliveryType, B extends z.ZodType, R extends z.ZodType>(
  type: T,
  request: R,
  body: B,
) {
  return z.object({ deliveryId: H, type: z.literal(type), request, body });
}

// History errors do not belong to a question, so error.request may be null.
export const Delivery = named(
  'Delivery',
  z.discriminatedUnion('type', [
    delivery('hello', z.null(), HelloDeliveryBody),
    delivery('history', z.null(), HistoryDeliveryBody),
    delivery('status', RequestKey, StatusDeliveryBody),
    delivery('price_lookup', RequestKey, PriceLookupDeliveryBody),
    delivery('reply', RequestKey, GameReply),
    delivery('error', RequestKey.nullable(), ErrorDeliveryBody),
    delivery('cleared', z.null(), ClearedDeliveryBody),
  ]),
);
export type Delivery = z.output<typeof Delivery>;
export type DeliveryOf<T extends DeliveryType> = Extract<Delivery, { type: T }>;

export const InboxPacket = named(
  'InboxPacket',
  z.object({
    version: z.literal(1),
    publicationRevision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
    targetCharacterKey: CharacterKey,
    targetDeliverySessionId: H,
    acceptedMessageKeys: z.array(MessageKey).max(LIMITS.acceptedMessageKeys),
    deliveries: z.array(Delivery).max(LIMITS.packetDeliveries),
  }),
);
export type InboxPacket = z.output<typeof InboxPacket>;

// ---------------------------------------------------------------------------
// Tools and IPC. Tool arguments are strict.

export const DATASET_TYPES = [
  'pack',
  'recipes',
  'trainers',
  'items',
  'search',
  'dungeons',
  'journal',
  'leveling',
  'professions',
  'training',
  'talents',
  'bis',
  'rewards',
  'prices',
] as const;
export const DatasetType = named('DatasetType', z.enum(DATASET_TYPES));

export const SEARCH_TYPES = [
  'item', 'recipe', 'npc', 'quest', 'object',
  'pack', 'dungeons', 'journal', 'leveling', 'professions', 'training', 'talents', 'bis', 'rewards', 'prices',
] as const;
export const SearchType = named('SearchType', z.enum(SEARCH_TYPES));
export type SearchType = (typeof SEARCH_TYPES)[number];

export const TOOL_NAMES = [
  'find_services',
  'search_game_data',
  'get_game_record',
  'get_source_status',
  'calculate_craft',
  'lookup_prices',
  'lookup_items',
  'get_alts',
  'find_items_on_alts',
  'find_recipe_crafters',
  'plan_craft',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const ToolArgs = {
  find_services: z.strictObject({
    service: z.enum(['auctioneer', 'mailbox', 'banker', 'innkeeper', 'flight_master', 'vendor', 'trainer', 'repair', 'stable_master']),
    itemId: ID.nullable(),
    zoneName: S.nullable(),
    forCharacter: S.nullable(),
    profession: S.nullable(),
    classToken: S.nullable(),
    cursor: H.nullable(),
  }).superRefine((value, ctx) => {
    if (value.itemId !== null && value.service !== 'vendor') ctx.addIssue({ code: 'custom', message: 'itemId is only supported for vendor searches' });
    if ((value.profession !== null || value.classToken !== null) && value.service !== 'trainer') ctx.addIssue({ code: 'custom', message: 'profession and classToken are only supported for trainer searches' });
  }),
  search_game_data: z.strictObject({
    query: S,
    types: z.array(SearchType).max(SEARCH_TYPES.length),
    cursor: H.nullable(),
  }),
  get_game_record: z.strictObject({
    type: SearchType,
    id: ID.nullable(),
    recordKey: S.nullable(),
    fields: z.array(S).max(40),
  }).superRefine((value, ctx) => {
    const entity = ['item', 'recipe', 'npc', 'quest', 'object'].includes(value.type);
    if (entity ? value.id === null || value.recordKey !== null : value.id !== null || value.recordKey === null) {
      ctx.addIssue({ code: 'custom', message: 'entities require id and null recordKey; reference sections require recordKey and null id' });
    }
  }),
  get_source_status: z.strictObject({}),
  calculate_craft: z.strictObject({
    recipeRefId: H,
    desiredQuantity: ID,
    inventoryScope: z.enum(['bags', 'account', 'none']),
  }),
  lookup_prices: z.strictObject({
    items: z
      .array(ItemInput)
      .min(1)
      .max(LIMITS.array)
      .superRefine(uniqueBy((i) => `${i.itemId}/${i.itemLink ?? ''}`, 'duplicate item')),
  }),
  lookup_items: z.strictObject({
    items: z
      .array(ItemInput)
      .min(1)
      .max(LIMITS.itemLookupItems)
      .superRefine(uniqueBy((i) => `${i.itemId}/${i.itemLink ?? ''}`, 'duplicate item')),
  }),
  get_alts: z.strictObject({}),
  find_items_on_alts: z.strictObject({
    itemIds: z.array(ID).min(1).max(LIMITS.array).superRefine(uniqueBy((id) => String(id), 'duplicate itemId')),
  }),
  find_recipe_crafters: z.strictObject({
    recipeSpellIds: z.array(ID).min(1).max(50).superRefine(uniqueBy((id) => String(id), 'duplicate recipeSpellId')),
  }),
  plan_craft: z.strictObject({
    recipeRefId: H,
    desiredQuantity: ID,
    inventoryScope: z.enum(['bags', 'account', 'none']),
    maxDepth: z.int().min(0).max(4),
    lookupPrices: z.boolean(),
  }),
} as const satisfies Record<ToolName, z.ZodType>;

/** Model-facing tool descriptions for the MCP proxy and direct tool calling. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  find_services:
    'Locate auctioneers, mailboxes, bankers, innkeepers, flight masters, vendors, trainers, repair NPCs or stable masters from the available local references. service="trainer" supports profession and classToken filters (null means any); set both null for other services. Trainer specializations require explicit reference data; a generic trainer flag cannot establish profession or class. Set itemId only for vendor, otherwise null. zoneName null searches all zones; forCharacter null uses the current character, otherwise a saved alt name. NPC faction is filtered and the character\'s map comes first. Results are services with id, trainerGroups, source records and coordinates; coordinates are percentages and alternative source positions are retained. Vendor results may include a purchase price, stack size, unit price and provenance; these are static quotes, not current stock or a personal discounted price. Prefer locationRefId when non-null, otherwise approxLocation. Pass cursor to continue. Distances are straight-line only within the same map; individual recipe teaching and dynamic requirements are unknown.',
  search_game_data:
    'Search the available local game references by name or numeric ID before web search. types [] searches all types; item, recipe, npc, quest and object filter entities; other types select reference sections such as dungeons, professions, training, talents, bis or rewards. Each hit has type, id, name, match and records with source, datasetId, original type and recordKey. Matching records of the same entity type and ID are grouped, with conflicting text retained separately. Fetch every hit with get_game_record using its top-level type, id and recordKey, and fields []. A recipe id is a spell ID. Search results do not issue evidence; fetch details to cite them. Pass the returned cursor to continue. If a source is unavailable, returns results from the other source and reports the gap.',
  get_game_record:
    'Get any local game reference record; the bridge selects the available sources. Use the same type/id/recordKey as search_game_data: item, recipe, npc, quest and object require numeric id and null recordKey; other reference sections require recordKey and null id. fields [] returns all fields, otherwise projects named fields. Returns a common envelope: fields, separate sources with evidence, conflicts, names, locations, itemRefId (items) and recipeRefId (recipes). Recipe fields include skill thresholds, output and reagents; recipeRefId always refers to the complete recipe even if fields are projected. Item fields may include change notes, recipeSpellIds and vendor/drop/quest relationships. NPC fields include trainerGroups when known. Map coordinates are percentages; prefer returned locationRefId or approxLocation. Truncated lists and dynamic requirements cannot establish quest eligibility. Fetch this tool after search to cite evidence.',
  get_source_status: 'Availability, pinned versions, counts, builds and limitations of each local reference source.',
  calculate_craft:
    'Materials for a recipe (recipeRefId from get_game_record with type="recipe"): crafts = ceil(desired/outputCount), needed, owned, missing, and known prices. inventoryScope "bags" counts the bag snapshot of the current character, "account" counts bags, bank and mail of all characters of the player (alts as of their last save), "none" ignores inventory. Compares eligible ForeverDB vendor purchase quotes with saved Auctionator prices and selects the lower cost for the missing quantity, including whole vendor packs. prices identifies each selected source, vendor, purchaseQuantity and totalCopper; each entry also retains the best quote from the other source in alternatives (excluded from the selected total). A price missing at one NPC does not invalidate quotes from other NPCs; vendor quotes are static and limited stock may require unconfirmed restocking. These are purchase prices; client sellPriceCopper is never used. Unknown prices are not zero. Returns calculationId for calculationIds.',
  lookup_prices:
    'Ask the game addon for its latest saved price observations of up to 100 items (waits up to 180 s). Prices are the last known observation per item, not stock or a purchase guarantee.',
  lookup_items:
    'Ask the game client, through the addon, what it knows about up to 20 items (waits up to 180 s): name, quality, item level, required level, type, subtype, equip slot, sellPriceCopper (what a vendor pays the player, not the vendor purchase price) and the tooltip lines the player sees (stats, damage per second, requirements). The client of the player is the authoritative source for Forever item stats: use it instead of web search for stats and requirements. Each item known to the client gets an itemRefId for itemRefIds and [[item:...]] markers, also for items missing from the dataset. Also returns saved price observations when available, subject to their age and market limitations.',
  get_alts:
    'All characters of the player on this server (the current one and alts): name, class, race, faction, level, money, zone, professions with skill and the number of known recipes, equipped item IDs, and when each part was read in the game. The current character comes from the question snapshot; alts come from the addon saved data as of their last logout or /reload. Bank and mail are known only for characters that opened them.',
  find_items_on_alts:
    'Where the player has up to 100 items across all characters: per character the count in bags, bank and mail, and the total. Use it for "do I have", "where is", "who holds" questions and before suggesting to buy materials.',
  plan_craft:
    'Crafting workflow (recipeRefId from get_game_record with type="recipe"): use owned finished items and reagents across all characters first, including necessary transfers; craft or buy only the shortfall. inventoryScope "account" uses recorded bags, bank and mail; maxDepth controls intermediate crafts (usually 3). Crafters use known recipes or sufficiently skilled trainer recipes (learn="trainer"); a top-level recipe item can be learn="recipe_item". New materials are normally bought locally by their consuming crafter. buy rows identify buyer; prices rows identify buyer, purchaseAt, source, priceBasis, purchaseQuantity and totalCopper. An unpriced local seller can have priceBasis="reference_estimate" and referenceQuote from another seller: label that cost approximate, preserve the local route, and never attribute the reference quote to the selected seller. alternatives preserve cheaper quotes without adding detours to the default plan. purchaseTotals and funding group costs and known gold shortfalls by buyer. fromInventory and transfers include owned items and delivery of the finished output; they take priority over purchases even for cheap materials. With lookupPrices=true, asks the addon for saved Auctionator observations for the tree (waits up to 180 s). Vendor quotes, stock and restocking are static; client sell prices are never used. Unknown costs are not zero. Returns steps, shopping, prices, transfers, leftovers, names and calculationId for calculationIds.',
  find_recipe_crafters:
    'Which characters of the player know up to 50 recipes (spell IDs, as from get_game_record with type="recipe" or search_game_data): knownBy, canLearnNow (has the profession at the learn skill), needsSkill (skill too low), notScanned (has the profession but the addon has not seen its recipe list yet).',
};

const IpcToken = z.string().regex(/^[0-9a-f]{64}$/);

export const IpcRequest = named(
  'IpcRequest',
  z.discriminatedUnion(
    'tool',
    TOOL_NAMES.map((tool) =>
      z.strictObject({
        version: z.literal(1),
        token: IpcToken,
        callId: H,
        attemptId: H,
        tool: z.literal(tool),
        args: ToolArgs[tool],
      }),
    ) as unknown as [z.ZodObject, ...z.ZodObject[]],
  ),
);

export const IpcResult = named(
  'IpcResult',
  z.object({
    version: z.literal(1),
    callId: H,
    status: z.enum(['ok', 'not_found', 'source_unavailable', 'unsupported_format', 'limit', 'cancelled', 'error']),
    data: z.unknown(),
    evidenceIds: z.array(H).max(LIMITS.array),
    limitations: z.array(S).max(LIMITS.array),
    cursor: H.nullable(),
  }),
);

// ---------------------------------------------------------------------------
// Generated schemas/*.schema.json files

export const SCHEMA_FILES = {
  protocol: ['Message', 'InboxPacket', 'Delivery', 'MessageKey', 'RequestKey', 'IpcRequest', 'IpcResult'],
  context: ['Snapshot', 'Policy', 'Identity'],
  reply: ['ModelReply', 'GameReply', 'HistoryEntry'],
  pricing: ['PriceObservation', 'Calculation'],
} as const;
