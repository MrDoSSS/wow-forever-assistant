// Attempt tool channel: Windows pipe \\.\pipe\ForeverAssistant-<attemptId>
// and a 32-byte random capability token. Invalid token, attempt, size or type
// closes the connection without effects. One tool at a time; a repeated callId
// returns its saved result. Register evidence and refIds and
// link them to the attempt before returning the result. Closing an attempt revokes
// its pipe, token and pending lookups. Adapters in the bridge process attach an attempt
// without a pipe and call tools directly with the same validation and budgets.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { z } from 'zod';
import {
  ClientItemInfo,
  IpcRequest,
  ItemInput,
  ToolArgs,
  type Calculation,
  type PriceObservation,
  type QueryBody,
  type RequestKey,
  type ToolName,
  type SearchType,
} from '../contracts.js';
import type { Clock } from '../clock.js';
import type { Diagnostics } from '../diagnostics.js';
import { accountInventory, accountView, coverageLimitations, describeAccount, itemHoldings, PROFESSION_SKILL_IDS, recipeCrafters, singleFaction, type AccountCharacter } from '../domain/alts.js';
import { CraftPlanError, planCraft, planItems, type Crafters } from '../domain/craft-plan.js';
import { calculateCraft, CraftLimitError, type Inventory } from '../domain/crafting.js';
import { registerEvidence, registerRef, type EvidenceInput } from '../domain/evidence.js';
import { confirmedMapOf, verifiedLocationOf } from '../domain/locations.js';
import { chooseCraftPrice, type PriceChoice, type PurchasePrice } from '../domain/pricing.js';
import { randomId, sha256Hex } from '../ids.js';
import type { AltsSource } from '../sources/alts.js';
import type { RecipeRecord } from '../sources/foreverdb/decode.js';
import { sourceKindOf, type ReferenceSource } from '../sources/records.js';
import { boundedFields, type QuestieSource } from '../sources/questiedb/tools.js';
import { uiMapIdOf } from '../domain/locations.js';
import { searchGameData } from '../sources/search.js';
import { getGameRecord, type ReferencePoint } from '../sources/records.js';
import { findServices, type ServiceFilter } from '../sources/services.js';
import { vendorPrices } from '../sources/pricing.js';
import { createCraftPurchaser, type PurchaseCharacter } from '../sources/craft-purchases.js';
import type { PriceObservationRow, Store, VerifiedRefRow } from '../storage/store.js';
import { encodeIpcFrame, IpcFrameReader, pipeNameFor } from './ipc.js';
import { Outbox } from './outbox.js';

export const TOOL_LIMITS = {
  callsPerAttempt: 100,
  resultRecords: 100,
  resultBytes: 32 * 1024,
  requestResultBytes: 2 * 1024 * 1024,
  priceTimeoutMs: 180_000,
};
export type ToolLimits = typeof TOOL_LIMITS;

export type IpcStatus = 'ok' | 'not_found' | 'source_unavailable' | 'unsupported_format' | 'limit' | 'cancelled' | 'error';

export interface IpcResultBody {
  version: 1;
  callId: string;
  status: IpcStatus;
  data: unknown;
  evidenceIds: string[];
  limitations: string[];
  cursor: string | null;
}

export interface AttemptContext {
  attemptId: string;
  request: RequestKey;
  conversationId: string;
  datasetId: string | null;
  query: QueryBody;
}

export interface DatasetLookup {
  sourceFor(datasetId: string): ReferenceSource | null;
}

interface Registrar {
  evidence(input: Omit<EvidenceInput, 'attemptId' | 'now'>): string;
  ref(kind: VerifiedRefRow['kind'], body: (refId: string) => unknown): string;
}

/** Tool result before saving: build data within the registration transaction. */
interface Prepared {
  status: IpcStatus;
  limitations: string[];
  cursor?: string | null;
  build?: (reg: Registrar) => { data: unknown; evidenceIds: string[] };
}

interface Channel {
  /** Immutable snapshot for this attempt, even when an update activates another version. */
  questie: QuestieSource | null;
  ctx: AttemptContext;
  /** Pipe server and its token; null for an attempt attached in process. */
  token: Buffer | null;
  server: Server | null;
  sockets: Set<Socket>;
  cursors: Map<string, { key: string; offset: number }>;
  abort: AbortController;
  chain: Promise<void>;
}

const unavailable = (limitation: string): Prepared => ({ status: 'source_unavailable', limitations: [limitation] });
const notFound = (limitations: string[]): Prepared => ({ status: 'not_found', limitations });

export function observationOf(row: PriceObservationRow): PriceObservation {
  return {
    item: { itemId: row.item_id, itemLink: row.original_item_link },
    marketKey: row.market_key,
    unit: 'per_item',
    priceCopper: row.price_copper,
    readOriginSessionId: row.read_origin_session_id,
    readAtSessionMs: row.read_at_session_ms,
    sourceObservedAtMs: null,
    ageDays: row.age_days,
    agePrecision: row.age_precision,
    rawExactness: row.raw_exactness === null ? null : row.raw_exactness === 1,
    exactness: row.exactness,
    source: 'auctionator_v1',
    sourceVersion: row.source_version,
    unavailableReason: row.unavailable_reason as PriceObservation['unavailableReason'],
  };
}

export class ToolChannelHub {
  private readonly channels = new Map<string, Channel>();
  private readonly priceWaiters = new Map<string, () => void>();
  private readonly byOutput = new WeakMap<ReferenceSource, Map<number, RecipeRecord[]>>();
  private readonly outbox: Outbox;
  private readonly limits: ToolLimits;

  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      diag: Diagnostics;
      datasets: DatasetLookup;
      questiedb?: { readonly source: QuestieSource | null };
      /** Account characters from SavedVariables; alt tools are unavailable without an AddOns directory. */
      alts?: AltsSource | null;
      /** After committing a price_lookup delivery, publish the packet. */
      onCommitted?: (characterKey: string) => void;
      limits?: Partial<ToolLimits>;
    },
  ) {
    this.outbox = new Outbox(deps.store);
    this.limits = { ...TOOL_LIMITS, ...deps.limits };
  }

  /** Open an attempt pipe; pass the token to MCP only in a file, never on the command line. */
  async open(ctx: AttemptContext): Promise<{ pipeName: string; token: string }> {
    const pipeName = pipeNameFor(ctx.attemptId);
    const token = randomBytes(32);
    const server = createServer();
    const channel = this.channel(ctx, token, server);
    server.on('connection', (socket) => this.serve(channel, socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipeName, () => resolve());
    });
    this.channels.set(ctx.attemptId, channel);
    return { pipeName, token: token.toString('hex') };
  }

  /** Attempt for an adapter in the bridge process: no pipe or token, tools go through call. */
  attach(ctx: AttemptContext): void {
    this.channels.set(ctx.attemptId, this.channel(ctx, null, null));
  }

  /** Direct tool call of an attached attempt; arguments are validated as in pipe requests. */
  async call(attemptId: string, tool: ToolName, args: unknown): Promise<IpcResultBody> {
    const callId = randomId();
    const channel = this.channels.get(attemptId);
    if (!channel) return this.result(callId, { status: 'cancelled', limitations: [] });
    const parsed = ToolArgs[tool].safeParse(args);
    if (!parsed.success) return this.result(callId, { status: 'error', limitations: [`invalid_arguments: ${z.prettifyError(parsed.error).slice(0, 1000)}`] });
    // One tool at a time per attempt, as for pipe requests.
    const run = channel.chain.then(() => this.handle(channel, callId, tool, parsed.data));
    channel.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(attemptId: string): Promise<void> {
    const channel = this.channels.get(attemptId);
    if (!channel) return;
    this.channels.delete(attemptId);
    channel.abort.abort();
    for (const socket of channel.sockets) socket.destroy();
    const server = channel.server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private channel(ctx: AttemptContext, token: Buffer | null, server: Server | null): Channel {
    return {
      questie: this.deps.questiedb?.source ?? null,
      ctx,
      token,
      server,
      sockets: new Set(),
      cursors: new Map(),
      abort: new AbortController(),
      chain: Promise.resolve(),
    };
  }

  /** PRICE_RESULT was accepted and saved: continue the pending lookup_prices / lookup_items call. */
  resolvePrice(lookupId: string): void {
    this.priceWaiters.get(lookupId)?.();
  }

  private serve(channel: Channel, socket: Socket): void {
    channel.sockets.add(socket);
    socket.on('close', () => channel.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const reader = new IpcFrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const event of reader.push(chunk)) {
        if (event.kind === 'error') {
          this.deps.diag.warn('tool.ipc_rejected', { attemptId: channel.ctx.attemptId, reason: event.reason });
          socket.destroy();
          return;
        }
        const parsed = IpcRequest.safeParse(event.value);
        const value = parsed.success ? (parsed.data as { token: string; attemptId: string; callId: string; tool: ToolName; args: unknown }) : null;
        const token = value ? Buffer.from(value.token, 'hex') : null;
        const expected = channel.token;
        if (!value || !token || !expected || token.length !== expected.length || !timingSafeEqual(token, expected) || value.attemptId !== channel.ctx.attemptId) {
          this.deps.diag.warn('tool.ipc_rejected', { attemptId: channel.ctx.attemptId, reason: parsed.success ? 'token_or_attempt' : 'schema' });
          socket.destroy();
          return;
        }
        // One tool at a time per attempt: execute calls sequentially.
        channel.chain = channel.chain.then(async () => {
          const result = await this.handle(channel, value.callId, value.tool, value.args);
          if (!socket.destroyed) socket.write(encodeIpcFrame(result));
        });
      }
    });
  }

  private result(callId: string, prepared: Pick<Prepared, 'status' | 'limitations' | 'cursor'>, data: unknown = null, evidenceIds: string[] = []): IpcResultBody {
    return { version: 1, callId, status: prepared.status, data, evidenceIds, limitations: prepared.limitations, cursor: prepared.cursor ?? null };
  }

  async handle(channel: Channel, callId: string, tool: ToolName, args: unknown): Promise<IpcResultBody> {
    const { store, clock, diag } = this.deps;
    const { ctx } = channel;
    const argsSha256 = sha256Hex(JSON.stringify(args));
    const reserved = store.transaction('tool.reserve', (): IpcResultBody | null => {
      const existing = store.getToolCall(callId);
      if (existing) {
        if (existing.attempt_id !== ctx.attemptId || existing.args_sha256 !== argsSha256) {
          return this.result(callId, { status: 'error', limitations: ['call_id_conflict'] });
        }
        if (existing.result_json) return JSON.parse(existing.result_json) as IpcResultBody;
        return this.result(callId, { status: 'error', limitations: ['call_in_progress'] });
      }
      if (store.getAttempt(ctx.attemptId)?.state !== 'running') return this.result(callId, { status: 'cancelled', limitations: [] });
      if (store.countToolCalls(ctx.attemptId) >= this.limits.callsPerAttempt) {
        return this.result(callId, { status: 'limit', limitations: [`tool_call_budget: ${this.limits.callsPerAttempt} calls per attempt`] });
      }
      store.reserveToolCall({ callId, attemptId: ctx.attemptId, tool, argsSha256, now: clock.now() });
      return null;
    });
    if (reserved) return reserved;

    let prepared: Prepared;
    try {
      prepared = await this.execute(channel, tool, args);
    } catch (error) {
      diag.error('tool.failed', { attemptId: ctx.attemptId, tool, error: String(error) });
      prepared = { status: 'error', limitations: ['tool_failed'] };
    }

    return store.transaction('tool.finish', () => {
      const now = clock.now();
      const finish = (body: IpcResultBody, state: 'done' | 'error' = 'done') => {
        store.finishToolCall(callId, state, JSON.stringify(body), now);
        return body;
      };
      if (store.getAttempt(ctx.attemptId)?.state !== 'running') {
        return finish(this.result(callId, { status: 'cancelled', limitations: [] }), 'error');
      }
      let data: unknown = null;
      let evidenceIds: string[] = [];
      if (prepared.build) {
        const reg: Registrar = {
          evidence: (input) => registerEvidence(store, { ...input, attemptId: ctx.attemptId, now }),
          ref: (kind, body) => registerRef(store, ctx.attemptId, kind, body),
        };
        ({ data, evidenceIds } = prepared.build(reg));
      }
      let body = this.result(callId, prepared, data, evidenceIds);
      const bytes = Buffer.byteLength(JSON.stringify(body));
      if (bytes > this.limits.resultBytes) {
        body = this.result(callId, { status: 'limit', limitations: [`result_too_large: ${bytes} bytes, limit ${this.limits.resultBytes}`] });
      } else if (store.requestResultBytes(ctx.request) + bytes > this.limits.requestResultBytes) {
        body = this.result(callId, { status: 'limit', limitations: ['question_result_budget: 2 MiB of tool results per question'] });
      }
      return finish(body, body.status === 'error' ? 'error' : 'done');
    });
  }

  private source(ctx: AttemptContext): ReferenceSource | null {
    return ctx.datasetId ? this.deps.datasets.sourceFor(ctx.datasetId) : null;
  }

  private attemptIds(ctx: AttemptContext): string[] {
    return this.deps.store.listRequestAttempts(ctx.request).map((a) => a.attempt_id);
  }

  private async execute(channel: Channel, tool: ToolName, rawArgs: unknown): Promise<Prepared> {
    const { ctx } = channel;
    const source = this.source(ctx);
    const datasetId = ctx.datasetId;
    const applicability = { dataset: datasetId, pack: source?.dataset.pack.version ?? null, build: source?.dataset.pack.build ?? null };
    const args = rawArgs as Record<string, unknown>;

    switch (tool) {
      case 'get_source_status': {
        return {
          status: source || channel.questie ? 'ok' : 'source_unavailable', limitations: [],
          build: () => ({ data: { [source ? sourceKindOf(source) : 'foreverdb']: source?.status().data ?? { available: false }, questiedb: channel.questie?.status() ?? { available: false } }, evidenceIds: [] }),
        };
      }

      case 'find_services':
        return this.services(channel, args);

      case 'search_game_data': {
        const query = args.query as string;
        const types = args.types as SearchType[];
        const key = JSON.stringify(['search_game_data', query, [...new Set(types)].sort()]);
        let offset = 0;
        if (args.cursor !== null) {
          const cursor = channel.cursors.get(args.cursor as string);
          if (!cursor || cursor.key !== key) return { status: 'error', limitations: ['cursor_invalid: the cursor belongs to another attempt or question'] };
          offset = cursor.offset;
        }
        const page = searchGameData(source, channel.questie, query, types, offset);
        if (!page.available) return { status: 'source_unavailable', limitations: page.limitations };
        let cursor: string | null = null;
        if (page.nextOffset !== null) {
          cursor = randomId();
          channel.cursors.set(cursor, { key, offset: page.nextOffset });
        }
        return { status: 'ok', limitations: page.limitations, cursor, build: () => ({ data: { hits: page.hits, total: page.total, sources: page.sources }, evidenceIds: [] }) };
      }

      case 'get_game_record':
        return this.record(channel, args);

      case 'calculate_craft':
        return this.calculate(channel, args);

      case 'lookup_prices':
        return this.lookupPrices(channel, ItemInput.array().parse(args.items));

      case 'lookup_items':
        return this.lookupItems(channel, ItemInput.array().parse(args.items));

      case 'plan_craft':
        return this.planCraft(channel, args);

      case 'get_alts':
      case 'find_items_on_alts':
      case 'find_recipe_crafters':
        return this.alts(ctx, tool, args);
    }
  }

  private located(reg: Registrar, point: ReferencePoint, confirmedMap: number | null, evidenceIds: string[]) {
    const body = verifiedLocationOf({
      entityKind: point.type === 'npc' ? 'npc' : 'other', entityId: String(point.id), title: point.title,
      uiMapId: point.uiMapId, x: point.x === null ? null : point.x / 100, y: point.y === null ? null : point.y / 100,
    }, confirmedMap, evidenceIds);
    return { ...point, locationRefId: body ? reg.ref('location', (refId) => ({ refId, ...body })) : null };
  }

  private record(channel: Channel, args: Record<string, unknown>): Prepared {
    const request = args as unknown as Parameters<typeof getGameRecord>[2];
    const result = getGameRecord(this.source(channel.ctx), channel.questie, request);
    if (!result.available) return { status: 'source_unavailable', limitations: [...result.limitations, 'record_source_unavailable'] };
    if (!result.found) return notFound([...result.limitations, 'record_not_found']);
    const confirmedMap = confirmedMapOf(channel.ctx.query.snapshot);
    return {
      status: 'ok', limitations: result.limitations,
      build: (reg) => {
        const sources = result.facts.map((fact) => {
          // Arithmetic references always attest the complete recipe, even for a field projection.
          const content = request.type === 'recipe' && result.recipe ? result.recipe : fact.fields;
          const evidenceId = reg.evidence({
            sourceKind: fact.source, datasetId: fact.datasetId, recordKey: fact.recordKey, sourceUrl: fact.sourceUrl,
            content, applicability: { dataset: fact.datasetId, flavor: 'Forever' }, purpose: request.type,
          });
          return { ...fact, evidenceId };
        });
        const evidenceIds = sources.map(({ evidenceId }) => evidenceId);
        const itemRefId = request.type === 'item' ? reg.ref('item', (refId) => ({ refId, itemId: request.id, itemLink: null, evidenceIds })) : null;
        const recipeRefId = result.recipe ? reg.ref('recipe', (refId) => {
          const { limitations: _limitations, ...recipe } = result.recipe!;
          return { refId, ...recipe, evidenceIds };
        }) : null;
        const locations = result.locations.map((point) => this.located(reg, point, confirmedMap, sources.filter(({ source }) => source === point.source).map(({ evidenceId }) => evidenceId)));
        return {
          data: { type: request.type, id: request.id, recordKey: request.recordKey, name: result.name, fields: result.fields, sources, conflicts: result.conflicts, names: result.names, itemRefId, recipeRefId, locations },
          evidenceIds,
        };
      },
    };
  }

  private services(channel: Channel, args: Record<string, unknown>): Prepared {
    const who = this.trainee(channel.ctx, args.forCharacter as string | null);
    if ('missing' in who) return notFound([`unknown_character: ${who.missing}`]);
    const master = this.source(channel.ctx);
    const questie = channel.questie;
    const key = JSON.stringify(['find_services', { ...args, cursor: null }]);
    let offset = 0;
    if (args.cursor !== null) {
      const cursor = channel.cursors.get(args.cursor as string);
      if (!cursor || cursor.key !== key) return { status: 'error', limitations: ['cursor_invalid'] };
      offset = cursor.offset;
    }
    const position = args.forCharacter === null && channel.ctx.query.snapshot.groups.position.availability === 'available'
      ? channel.ctx.query.snapshot.groups.position.value : null;
    const page = findServices(master, questie, args as unknown as ServiceFilter, {
      ...who, uiMapId: position?.mapKey ? uiMapIdOf(position.mapKey) : null, x: position?.x ?? null, y: position?.y ?? null,
    }, offset);
    if (!page.available) return { status: 'source_unavailable', limitations: page.limitations };
    const limitations = [...page.limitations,
      `services_for: ${who.name} (${who.faction ?? 'unknown faction'}, zone ${who.zoneName ?? 'unknown'}); distances only compare points within one map`,
    ];
    if (!who.faction) limitations.push('faction_unknown: services of both factions may be listed');
    if (args.service === 'mailbox') limitations.push('mailbox_faction: object restrictions are not evaluated as NPC friendliness');
    if (args.service === 'vendor') limitations.push('vendor_offer: returned purchase quotes are static; absent prices, current stock, character discounts and requirements are unknown');
    let cursor: string | null = null;
    if (page.nextOffset !== null) {
      cursor = randomId();
      channel.cursors.set(cursor, { key, offset: page.nextOffset });
    }
    const confirmedMap = confirmedMapOf(channel.ctx.query.snapshot);
    return {
      status: 'ok', limitations, cursor,
      build: (reg) => {
        const evidenceIds: string[] = [];
        const bySource = new Map<string, string>();
        for (const kind of ['foreverdb', 'questiedb'] as const) {
          const rows = page.services.filter((row) => row.sources.some(({ source }) => source === kind));
          if (!rows.length) continue;
          const datasetId = kind === 'questiedb' ? questie!.datasetId : master!.datasetId;
          const content = rows.map((row) => ({
            id: row.id, type: row.type,
            records: kind === 'questiedb' ? boundedFields({ fields: questie!.get(row.type, row.id)!.fields }).fields
              : { trainers: master!.dataset.trainers.filter(({ npcId }) => npcId === row.id),
                vendorPriceCopper: row.vendorPriceCopper ?? null, vendorStack: row.vendorStack ?? null,
                limitedStock: row.limitedStock ?? null, priceSource: row.priceSource ?? null },
            locations: [row, ...row.alternateLocations].filter((point) => point.source === kind).map(({ uiMapId, x, y }) => ({ uiMapId, x, y })),
          }));
          const evidenceId = reg.evidence({
            sourceKind: kind, datasetId, recordKey: `services/${sha256Hex(key)}/${offset}`, sourceUrl: kind === 'questiedb' ? questie!.dataset.sourceUrl : master!.dataset.pack.site,
            content, applicability: { dataset: datasetId, flavor: 'Forever' }, purpose: 'services',
          });
          evidenceIds.push(evidenceId);
          bySource.set(kind, evidenceId);
        }
        const services = page.services.map((point) => {
          const ids = [...new Set(point.sources.map(({ source }) => bySource.get(source)!))];
          return {
            ...this.located(reg, point, confirmedMap, ids),
            alternateLocations: point.alternateLocations.map((alternative) => this.located(reg, alternative, confirmedMap, [bySource.get(alternative.source)!])),
          };
        });
        return { data: { services, total: page.total, forCharacter: who.name }, evidenceIds };
      },
    };
  }

  /**
   * Expected market: the current character's Auctionator key from the latest priced observation,
   * if every account character has the same faction. Otherwise null; prices get market_unverified.
   */
  private expectedMarket(ctx: AttemptContext, observations: readonly PriceObservation[]): string | null {
    const account = this.account(ctx);
    if (!account || singleFaction(account.view) === null) return null;
    const key = observations.filter((o) => o.priceCopper !== null).at(-1)?.marketKey ?? null;
    return key === null || key === 'auctionator:unknown' ? null : key;
  }

  /** Character visiting a trainer: the snapshot character or a saved alt selected by name. */
  private trainee(ctx: AttemptContext, name: string | null): { name: string; faction: string | null; zoneName: string | null } | { missing: string } {
    if (name !== null) {
      const view = this.account(ctx)?.view ?? [];
      const wanted = name.toLowerCase();
      const found = view.find((c) => c.name.toLowerCase() === wanted || c.fullName?.toLowerCase() === wanted);
      if (!found) return { missing: name };
      return { name: found.name, faction: found.summary?.value.faction ?? null, zoneName: found.summary?.value.zoneName ?? null };
    }
    const g = ctx.query.snapshot.groups;
    return {
      name: ctx.query.identity.displayName,
      faction: g.character.availability === 'available' ? g.character.value.faction : null,
      zoneName: g.position.availability === 'available' && g.position.value.zoneName !== '' ? g.position.value.zoneName : null,
    };
  }

  /** Account characters: the current snapshot character and other characters from SavedVariables. */
  private account(ctx: AttemptContext): { view: AccountCharacter[]; limitations: string[] } | null {
    const alts = this.deps.alts;
    if (!alts?.configured) return null;
    const loaded = alts.load();
    return { view: accountView(loaded.records, ctx.query, ctx.request.characterKey), limitations: loaded.limitations };
  }

  private alts(ctx: AttemptContext, tool: 'get_alts' | 'find_items_on_alts' | 'find_recipe_crafters', args: Record<string, unknown>): Prepared {
    const account = this.account(ctx);
    if (!account) return unavailable('alts_unavailable: addonsPath is not configured, the saved character data cannot be read');
    const { view } = account;
    const limitations = [
      ...account.limitations,
      'saved_alts: other characters are read from the addon SavedVariables as of their last logout or /reload; the current character comes from the question snapshot',
    ];
    if (view.length === 1) limitations.push('no_alts_saved: only the current character is known; log in once with the addon on other characters');
    let data: unknown;
    if (tool === 'get_alts') {
      data = { characters: describeAccount(view) };
      limitations.push(...coverageLimitations(view));
    } else if (tool === 'find_items_on_alts') {
      const names = this.source(ctx)?.dataset.names ?? {};
      data = { items: itemHoldings(view, args.itemIds as number[]).map((i) => ({ ...i, name: names[String(i.itemId)] ?? null })) };
      limitations.push(...coverageLimitations(view));
    } else {
      const source = this.source(ctx);
      const reports = (args.recipeSpellIds as number[]).map((id) => {
        const outcome = source?.getRecipe(id);
        return recipeCrafters(view, id, outcome?.status === 'ok' ? outcome.data : null);
      });
      if (reports.some((r) => r.profession === null)) {
        limitations.push('recipe_not_in_dataset: for some recipes the profession and skill are unknown; only scanned recipe lists were checked');
      }
      if (reports.some((r) => r.notScanned.length > 0)) {
        limitations.push('recipes_not_scanned: open the profession window once on these characters so the addon saves their recipes');
      }
      data = { recipes: reports };
    }
    return {
      status: 'ok',
      limitations,
      build: (reg) => {
        const evidenceId = reg.evidence({
          sourceKind: 'client',
          datasetId: null,
          recordKey: `alts/${tool}/${sha256Hex(JSON.stringify(args)).slice(0, 16)}`,
          sourceUrl: null,
          content: data,
          applicability: { characters: view.map((c) => c.name), snapshotId: ctx.query.snapshot.snapshotId },
          purpose: 'alts',
        });
        return { data, evidenceIds: [evidenceId] };
      },
    };
  }

  private craftPrices(channel: Channel, items: readonly number[], observations: readonly PriceObservation[]): Map<number, PriceChoice> {
    const { ctx } = channel;
    const source = this.source(ctx);
    const market = this.expectedMarket(ctx, observations);
    const character = ctx.query.snapshot.groups.character;
    const position = ctx.query.snapshot.groups.position;
    const buyer = {
      faction: character.availability === 'available' ? character.value.faction : null,
      zoneName: position.availability === 'available' ? position.value.zoneName : null,
    };
    return new Map(items.map((itemId) => [itemId, chooseCraftPrice(itemId, observations, market, vendorPrices(source, channel.questie, itemId, buyer))]));
  }

  private priceEvidence(reg: Registrar, ctx: AttemptContext, prices: readonly PurchasePrice[]): string[] {
    const quotes = prices.flatMap(({ alternatives, ...price }) => [price,
      ...alternatives.map((alternative) => ({ itemId: price.itemId, quantity: price.quantity, ...alternative })),
    ]);
    const evidenceIds: string[] = [];
    for (const price of quotes) {
      const quote = price.vendor ?? price.referenceQuote;
      if (quote || price.observation) evidenceIds.push(reg.evidence({
        sourceKind: quote ? 'foreverdb' : 'auctionator', datasetId: quote?.datasetId ?? null,
        recordKey: quote?.recordKey ?? `price/${price.itemId}`, sourceUrl: quote ? this.source(ctx)?.dataset.pack.site ?? null : null,
        content: price, applicability: { snapshotId: ctx.query.snapshot.snapshotId }, purpose: 'price',
      }));
      const site = price.purchaseAt;
      if (site && (!quote || site.npcId !== quote.npcId || site.source !== 'foreverdb')) evidenceIds.push(reg.evidence({
        sourceKind: site.source, datasetId: site.datasetId, recordKey: `npc/${site.npcId}`, sourceUrl: null,
        content: { itemId: price.itemId, quantity: price.quantity, purchaseAt: site, priceBasis: price.priceBasis },
        applicability: { snapshotId: ctx.query.snapshot.snapshotId }, purpose: 'purchase_location',
      }));
    }
    return evidenceIds;
  }

  private calculate(channel: Channel, args: Record<string, unknown>): Prepared {
    const { ctx } = channel;
    const refRow = this.deps.store.getVerifiedRef(args.recipeRefId as string);
    if (!refRow || refRow.kind !== 'recipe' || !this.attemptIds(ctx).includes(refRow.attempt_id)) {
      return notFound(['unknown_recipe_ref: get recipeRefId from get_game_record with type="recipe" for this question']);
    }
    const recipe = { ...(JSON.parse(refRow.body_json) as RecipeRecord), limitations: [] };
    let inventory: Inventory = { scope: 'none' };
    if (args.inventoryScope === 'bags') inventory = { scope: 'bags', bags: ctx.query.snapshot.groups.bags };
    else if (args.inventoryScope === 'account') {
      const account = this.account(ctx);
      if (!account) return unavailable('alts_unavailable: addonsPath is not configured; use inventoryScope "bags"');
      inventory = { scope: 'account', owned: accountInventory(account.view), limitations: [...account.limitations, ...coverageLimitations(account.view)] };
    }
    const observations = this.deps.store.listRequestPriceObservations(ctx.request).map(observationOf);
    const snapshotPrices = ctx.query.snapshot.groups.prices;
    if (snapshotPrices.availability === 'available') observations.unshift(...snapshotPrices.value);
    const prices = this.craftPrices(channel, recipe.reagents.map((r) => r.itemId), observations);
    let result;
    try {
      result = calculateCraft({ recipe, desiredQuantity: args.desiredQuantity as number, inventory, prices });
    } catch (error) {
      if (error instanceof CraftLimitError) return { status: 'limit', limitations: [`calculation_limit: ${error.message}`] };
      throw error;
    }
    return {
      status: 'ok',
      limitations: result.limitations,
      build: (reg) => {
        const evidenceId = reg.evidence({
          sourceKind: 'calculation',
          datasetId: ctx.datasetId,
          recordKey: `calculation/${recipe.spellId}`,
          sourceUrl: null,
          content: { recipeRefId: args.recipeRefId, desiredQuantity: args.desiredQuantity, inventoryScope: args.inventoryScope, result },
          applicability: { snapshotId: ctx.query.snapshot.snapshotId },
          purpose: 'calculation',
        });
        let calculation: (Calculation & { prices: PurchasePrice[] }) | null = null;
        reg.ref('calculation', (refId) => {
          calculation = {
            calculationId: refId,
            recipeRefId: args.recipeRefId as string,
            crafts: result.crafts,
            lines: result.lines,
            priceTotalCopper: result.priceTotalCopper,
            unpricedItemIds: result.unpricedItemIds,
            limitations: result.limitations,
            prices: result.prices,
          };
          return calculation;
        });
        return { data: calculation, evidenceIds: [evidenceId, ...this.priceEvidence(reg, ctx, result.prices)] };
      },
    };
  }

  /** Dataset recipes indexed by output item for intermediate plan_craft products. */
  private recipesByOutput(source: ReferenceSource): Map<number, RecipeRecord[]> {
    let map = this.byOutput.get(source);
    if (!map) {
      map = new Map();
      for (const recipe of Object.values(source.dataset.recipes)) {
        if (recipe.outputItemId === null) continue;
        const list = map.get(recipe.outputItemId) ?? [];
        list.push(recipe);
        map.set(recipe.outputItemId, list);
      }
      this.byOutput.set(source, map);
    }
    return map;
  }

  // Crafting plan with intermediate products: character inventories, known recipes
  // and prices for the entire tree in a single addon request (lookupPrices).
  private async planCraft(channel: Channel, args: Record<string, unknown>): Promise<Prepared> {
    const { ctx } = channel;
    const refRow = this.deps.store.getVerifiedRef(args.recipeRefId as string);
    if (!refRow || refRow.kind !== 'recipe' || !this.attemptIds(ctx).includes(refRow.attempt_id)) {
      return notFound(['unknown_recipe_ref: get recipeRefId from get_game_record with type="recipe" for this question']);
    }
    const source = this.source(ctx);
    if (!source) return unavailable('foreverdb_unavailable');
    const recipe = { ...(JSON.parse(refRow.body_json) as RecipeRecord), limitations: [] };
    const recipesByOutput = this.recipesByOutput(source);
    const account = this.account(ctx);
    const limitations: string[] = [...(account?.limitations ?? [])];

    // Crafters either have the recipe in a saved profession window or enough
    // profession skill to learn it; the recipe still needs learning or confirmation. Without
    // profession data, allow intermediate crafting without assigning a character.
    const view = account?.view ?? [];
    const knows = (c: AccountCharacter, r: RecipeRecord) => {
      const skillId = PROFESSION_SKILL_IDS[r.profession];
      return skillId !== undefined ? (c.recipes.get(skillId)?.spellIds.has(r.spellId) ?? false) : [...c.recipes.values()].some((x) => x.spellIds.has(r.spellId));
    };
    const rankOf = (c: AccountCharacter, r: RecipeRecord) => c.professions?.value.find((p) => p.skillId === PROFESSION_SKILL_IDS[r.profession])?.rank ?? null;
    const crafters: Crafters = view.some((c) => c.recipes.size > 0 || (c.professions?.value.length ?? 0) > 0)
      ? {
          knowledge: true,
          knownBy: (r) => view.filter((c) => knows(c, r)).map((c) => c.name),
          // The current character comes first (view order), then sort by skill.
          learnableBy: (r) =>
            view
              .filter((c) => !knows(c, r) && (rankOf(c, r) ?? -1) >= (r.learn ?? 0))
              .sort((a, b) => Number(b.current) - Number(a.current) || (rankOf(b, r) ?? 0) - (rankOf(a, r) ?? 0))
              .map((c) => c.name),
        }
      : { knowledge: false, knownBy: () => [], learnableBy: () => [] };
    if (crafters.knowledge && view.some((c) => c.professions !== null && c.professions.value.length > 0 && c.recipes.size === 0)) {
      limitations.push('recipes_not_scanned: some characters with professions have not opened their profession window with the addon');
    }

    const buyer = ctx.query.identity.displayName;
    const stock = new Map<string, Map<number, number>>();
    if (args.inventoryScope === 'account') {
      if (!account) return unavailable('alts_unavailable: addonsPath is not configured; use inventoryScope "bags"');
      for (const c of view) {
        const items = new Map<number, number>();
        for (const part of [c.bags, c.bank, c.mail]) for (const [id, n] of part?.value ?? []) items.set(id, (items.get(id) ?? 0) + n);
        stock.set(c.name, items);
      }
      limitations.push('account_inventory: bags, bank and mail of all characters; alts as of their last save', ...coverageLimitations(view));
    } else if (args.inventoryScope === 'bags') {
      const bags = ctx.query.snapshot.groups.bags;
      if (bags.availability === 'available') {
        const items = new Map<number, number>();
        for (const slot of bags.value) items.set(slot.item.itemId, (items.get(slot.item.itemId) ?? 0) + slot.count);
        stock.set(buyer, items);
        if (bags.coverage === 'partial') limitations.push('inventory_partial: the bag snapshot is incomplete');
      } else limitations.push(`inventory_${bags.availability}`);
    }

    const maxDepth = args.maxDepth as number;
    const desiredQuantity = args.desiredQuantity as number;
    const ownedOutput = recipe.outputItemId === null ? 0 : [...stock.values()].reduce((total, items) => Math.min(desiredQuantity, total + (items.get(recipe.outputItemId!) ?? 0)), 0);
    const items = ownedOutput >= desiredQuantity ? [] : planItems({ recipe, maxDepth, recipesByOutput, crafters });
    const observations = this.deps.store.listRequestPriceObservations(ctx.request).map(observationOf);
    const snapshotPrices = ctx.query.snapshot.groups.prices;
    if (snapshotPrices.availability === 'available') observations.unshift(...snapshotPrices.value);
    if (args.lookupPrices === true && items.length > 0) {
      if (items.length > 100) limitations.push('price_lookup_partial: prices were asked for the first 100 items of the tree');
      const asked = await this.askAddon(channel, items.slice(0, 100).map((itemId) => ({ itemId, itemLink: null })), false);
      if (asked.outcome === 'cancelled') return { status: 'cancelled', limitations: [] };
      if (asked.outcome === 'timeout') limitations.push('price_lookup_timeout: the addon did not return prices within 180 s; known prices were used');
      observations.push(...asked.observations);
    }
    const character = ctx.query.snapshot.groups.character;
    const position = ctx.query.snapshot.groups.position;
    const current: PurchaseCharacter = {
      name: buyer, faction: character.availability === 'available' ? character.value.faction : null,
      zoneName: position.availability === 'available' ? position.value.zoneName || null : null,
      uiMapId: position.availability === 'available' && position.value.mapKey ? uiMapIdOf(position.value.mapKey) : null,
      x: position.availability === 'available' ? position.value.x : null, y: position.availability === 'available' ? position.value.y : null,
    };
    const characters: PurchaseCharacter[] = view.map((c) => ({ name: c.name, faction: c.summary?.value.faction ?? null,
      zoneName: c.summary?.value.zoneName ?? null, uiMapId: null, x: null, y: null }));
    const purchaseFor = createCraftPurchaser({ source, questie: channel.questie, current, characters,
      observations, expectedMarket: this.expectedMarket(ctx, observations) });

    let plan;
    try {
      plan = planCraft({ recipe, desiredQuantity: args.desiredQuantity as number, maxDepth, recipesByOutput, stock, buyer, crafters, prices: new Map(), purchaseFor });
    } catch (error) {
      if (error instanceof CraftPlanError) return { status: 'limit', limitations: [`plan_limit: ${error.message}`] };
      throw error;
    }
    limitations.push(...plan.limitations, 'plan_semantics: use owned items across the account first, including owned outputs; missing materials are bought by their crafter at local services when found. Reference estimates at unpriced local vendors are labeled; cheaper remote quotes are alternatives, not automatic detours or transfers');
    const funding = plan.purchaseTotals.map((row) => {
      const moneyCopper = view.find((c) => c.name === row.buyer)?.summary?.value.moneyCopper ??
        (row.buyer === current.name && character.availability === 'available' ? character.value.moneyCopper : null);
      return { ...row, knownMoneyCopper: moneyCopper,
        shortfallCopper: row.totalCostCopper !== null && row.unpricedItemIds.length === 0 && moneyCopper !== null
          ? Math.max(0, row.totalCostCopper - moneyCopper) : null };
    });
    const names: Record<string, string | null> = {};
    for (const itemId of [...items, ...(recipe.outputItemId === null ? [] : [recipe.outputItemId]),
      ...plan.fromInventory.map((row) => row.itemId), ...plan.transfers.map((row) => row.itemId),
      ...plan.steps.flatMap((s) => (s.outputItemId === null ? [] : [s.outputItemId]))]) {
      names[String(itemId)] = source.dataset.names[String(itemId)] ?? null;
    }
    const datasetId = ctx.datasetId;
    const applicability = { dataset: datasetId, pack: source.dataset.pack.version ?? null, build: source.dataset.pack.build ?? null };
    return {
      status: 'ok',
      limitations: [...new Set(limitations)],
      build: (reg) => {
        const evidenceIds = [
          ...this.priceEvidence(reg, ctx, plan.prices),
          reg.evidence({
            sourceKind: 'calculation',
            datasetId,
            recordKey: `plan/${recipe.spellId}`,
            sourceUrl: null,
            content: { args, plan, funding },
            applicability: { snapshotId: ctx.query.snapshot.snapshotId },
            purpose: 'calculation',
          }),
        ];
        for (const step of plan.steps) {
          const used = source.dataset.recipes[String(step.recipeSpellId)];
          if (!used || used.spellId === recipe.spellId) continue;
          const { limitations: _l, ...fields } = used;
          evidenceIds.push(reg.evidence({ sourceKind: sourceKindOf(source), datasetId, recordKey: `recipes/${used.spellId}`, sourceUrl: null, content: fields, applicability, purpose: 'recipe' }));
        }
        // calculationIds calculation: purchases are rows, total is their cost; keep the full plan alongside it.
        const calculationId = reg.ref('calculation', (refId) => {
          const calculation: Calculation = {
            calculationId: refId,
            recipeRefId: args.recipeRefId as string,
            crafts: plan.steps.find((s) => s.recipeSpellId === recipe.spellId)?.crafts ?? 0,
            lines: plan.buy.map((b) => ({ itemId: b.itemId, needed: b.quantity, knownOwned: null, missing: b.quantity })),
            priceTotalCopper: plan.totalCostCopper,
            unpricedItemIds: plan.unpricedItemIds,
            limitations: plan.limitations,
          };
          return { ...calculation, plan, funding };
        });
        return { data: { calculationId, ...plan, funding, names }, evidenceIds };
      },
    };
  }

  /** Extra price observation: deliver price_lookup and wait up to 180 seconds for PRICE_RESULT. */
  /** Request through a price_lookup delivery and wait for PRICE_RESULT up to priceTimeoutMs. */
  private async askAddon(channel: Channel, items: ItemInput[], itemInfo: boolean) {
    const { store, clock } = this.deps;
    const { ctx } = channel;
    const lookupId = randomId();
    const resolved = new Promise<'result' | 'timeout' | 'cancelled'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.limits.priceTimeoutMs);
      this.priceWaiters.set(lookupId, () => {
        clearTimeout(timer);
        resolve('result');
      });
      channel.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve('cancelled');
      });
    });
    store.transaction('tool.price_lookup', () => {
      const now = clock.now();
      store.insertPriceLookup({
        lookup_id: lookupId,
        attempt_id: ctx.attemptId,
        requested_items_json: JSON.stringify(items),
        state: 'pending',
        expires_at: now + this.limits.priceTimeoutMs,
        result_sha256: null,
      });
      this.outbox.create({
        characterKey: ctx.request.characterKey,
        conversationId: ctx.conversationId,
        fallbackTarget: ctx.request.originSessionId,
        now,
        draft: { type: 'price_lookup', request: ctx.request, body: { lookupId, items, itemInfo } },
      });
    });
    this.deps.onCommitted?.(ctx.request.characterKey);
    const outcome = await resolved;
    this.priceWaiters.delete(lookupId);
    if (outcome === 'timeout') {
      store.transaction('tool.price_timeout', () => {
        if (store.getPriceLookup(lookupId)?.state === 'pending') store.setPriceLookupState(lookupId, 'timed_out', null);
      });
    }
    const observations =
      outcome === 'result'
        ? store
            .listRequestPriceObservations(ctx.request)
            .filter((row) => row.lookup_id === lookupId)
            .map(observationOf)
        : [];
    const info = outcome === 'result' ? store.listClientItemInfo(lookupId).map((json) => ClientItemInfo.parse(JSON.parse(json))) : [];
    return { outcome, lookupId, observations, info };
  }

  private async lookupPrices(channel: Channel, items: ItemInput[]): Promise<Prepared> {
    const { outcome, lookupId, observations } = await this.askAddon(channel, items, false);
    if (outcome === 'cancelled') return { status: 'cancelled', limitations: [] };
    if (outcome === 'timeout') return unavailable('price_lookup_timeout: the addon did not return prices within 180 s');
    if (observations.length === 0) return unavailable('prices_unavailable: the addon reported a general reason without observations');
    return {
      status: 'ok',
      limitations: ['price_semantics: last Auctionator observation, copper per unit; not stock and not a purchase guarantee'],
      build: (reg) => {
        const evidenceIds = observations.map((o) =>
          reg.evidence({ sourceKind: 'auctionator', datasetId: null, recordKey: `lookup/${lookupId}/${o.item.itemId}`, sourceUrl: null, content: o, applicability: { marketKey: o.marketKey }, purpose: 'price' }),
        );
        return { data: { lookupId, observations }, evidenceIds };
      },
    };
  }

  // Client item information: stats, required level, type and tooltip
  // lines exactly as the player sees them. Create source=client evidence and an itemRefId
  // for each item the client knows, including items absent from the dataset.
  private async lookupItems(channel: Channel, items: ItemInput[]): Promise<Prepared> {
    const { outcome, lookupId, observations, info } = await this.askAddon(channel, items, true);
    if (outcome === 'cancelled') return { status: 'cancelled', limitations: [] };
    if (outcome === 'timeout') return unavailable('item_lookup_timeout: the addon did not answer within 180 s');
    if (info.length === 0) return unavailable('item_info_unavailable: the addon did not return item info (outdated addon?)');
    const limitations = ['client_item_info: read from the game client of the player'];
    if (info.some((i) => i.unavailableReason === 'not_cached')) limitations.push('not_cached: the client had no data for some items yet; ask again later');
    return {
      status: 'ok',
      limitations,
      build: (reg) => {
        const evidenceIds: string[] = [];
        const data = info.map((i) => {
          if (i.name === null) return { ...i, itemRefId: null };
          const evidenceId = reg.evidence({
            sourceKind: 'client',
            datasetId: null,
            recordKey: `lookup/${lookupId}/${i.item.itemId}`,
            sourceUrl: null,
            content: i,
            applicability: { readOriginSessionId: channel.ctx.request.originSessionId },
            purpose: 'client_item',
          });
          evidenceIds.push(evidenceId);
          const itemRefId = reg.ref('item', (refId) => ({ refId, itemId: i.item.itemId, itemLink: i.item.itemLink, evidenceIds: [evidenceId] }));
          return { ...i, itemRefId };
        });
        return { data: { items: data, prices: observations }, evidenceIds };
      },
    };
  }
}
