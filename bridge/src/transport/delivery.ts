// Sole LoD pool writer. The bridge does not know which slot the addon
// will load next, so it writes the current packet to every pool slot. Each
// file is replaced through a temporary file; replacing the whole pool is not atomic.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import { LIMITS } from '../contracts.js';
import { shortKey, type Diagnostics } from '../diagnostics.js';
import type { Store } from '../storage/store.js';
import { luaByteLength } from './lua.js';
import { buildInboxLua, type InboxHeader } from './packet.js';

export const SLOT_COUNT = 200;
export const POOL_MARKER = '## X-ForeverAssistant-Pool: 1';
export const KIT_MARKER = '## X-ForeverAssistant-Kit: 1';
export const INTERFACE_VERSION = 16001;

export function slotName(index: number): string {
  return `ForeverAssistant_Slot${String(index).padStart(3, '0')}`;
}

export function slotToc(index: number): string {
  return [
    `## Interface: ${INTERFACE_VERSION}`,
    `## Title: ForeverAssistant slot ${String(index).padStart(3, '0')}`,
    '## Notes: Generated delivery slot of ForeverAssistant. Do not edit.',
    '## LoadOnDemand: 1',
    '## Dependencies: ForeverAssistant',
    POOL_MARKER,
    'Inbox.lua',
    '',
  ].join('\n');
}

export const EMPTY_INBOX = '-- ForeverAssistant: no packet published yet\n';

export interface PoolWriteReport {
  written: number;
  unchanged: number;
  failed: { slot: string; error: string }[];
}

export interface PoolCheck {
  ok: boolean;
  missing: string[];
  foreign: string[];
}

export class SlotPool {
  private readonly lastHash = new Map<number, string>();

  constructor(
    readonly addonsDir: string,
    readonly count = SLOT_COUNT,
  ) {}

  slotDir(index: number): string {
    return join(this.addonsDir, slotName(index));
  }

  /** Write only to our installation's slots, identified by the pool marker in their TOCs. */
  check(): PoolCheck {
    const missing: string[] = [];
    const foreign: string[] = [];
    for (let i = 1; i <= this.count; i++) {
      const toc = join(this.slotDir(i), `${slotName(i)}.toc`);
      if (!existsSync(toc)) missing.push(slotName(i));
      else if (!readFileSync(toc, 'utf8').includes(POOL_MARKER)) foreign.push(slotName(i));
    }
    return { ok: missing.length === 0 && foreign.length === 0, missing, foreign };
  }

  write(content: string): PoolWriteReport {
    const hash = createHash('sha256').update(content).digest('hex');
    const report: PoolWriteReport = { written: 0, unchanged: 0, failed: [] };
    for (let i = 1; i <= this.count; i++) {
      if (this.lastHash.get(i) === hash) {
        report.unchanged++;
        continue;
      }
      const target = join(this.slotDir(i), 'Inbox.lua');
      const temp = `${target}.tmp`;
      try {
        writeFileSync(temp, content, 'utf8');
        renameSync(temp, target);
        this.lastHash.set(i, hash);
        report.written++;
      } catch (error) {
        this.lastHash.delete(i);
        report.failed.push({ slot: slotName(i), error: (error as NodeJS.ErrnoException).code ?? String(error) });
      }
    }
    return report;
  }
}

export interface PublishReport {
  revision: number;
  characterKey: string;
  deliveries: number;
  ackKeys: number;
  bytes: number;
  pool: PoolWriteReport;
}

export type PublishResult =
  | { status: 'published'; report: PublishReport }
  | { status: 'skipped'; reason: 'no_target' | 'unchanged' }
  | { status: 'failed'; reason: string };

export interface PoolWriter {
  write(content: string): PoolWriteReport;
}

export class DeliveryPublisher {
  private lastSignature: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly deps: {
      store: Store;
      pool: PoolWriter;
      clock: Clock;
      diag: Diagnostics;
      debounceMs?: number;
      retryMs?: number;
    },
  ) {}

  /** Debounced publication: several consecutive changes produce one pool write. */
  schedule(delayMs = this.deps.debounceMs ?? 50): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const result = this.publishNow();
      if (result.status === 'failed') this.schedule(this.deps.retryMs ?? 2000);
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  publishNow(): PublishResult {
    const { store, diag } = this.deps;
    type Prepared =
      | { kind: 'no_target' | 'unchanged' }
      | { kind: 'packet'; header: InboxHeader; literals: string[]; signature: string };
    let prepared: Prepared;
    try {
      prepared = store.transaction('publish', (): Prepared => {
        const state = store.getTransportState();
        const characterKey = state.active_character_key;
        const target = state.active_delivery_session_id;
        if (!characterKey || !target) return { kind: 'no_target' };
        // The ACK set contains the latest 128 messages by time; packet entries are sorted by key so
        // a duplicate of an acknowledged message does not republish the entire pool.
        const acceptedMessageKeys = store
          .listAckKeys(characterKey, LIMITS.acceptedMessageKeys)
          .sort((a, b) =>
            a.originSessionId < b.originSessionId ? -1 : a.originSessionId > b.originSessionId ? 1 : a.messageSequence - b.messageSequence,
          );
        const header: InboxHeader = {
          publicationRevision: Number.MAX_SAFE_INTEGER,
          targetCharacterKey: characterKey,
          targetDeliverySessionId: target,
          acceptedMessageKeys,
        };
        // Pending deliveries that do not fit in the packet remain queued.
        let bytes = luaByteLength(buildInboxLua(header, []));
        const literals: string[] = [];
        const ids: string[] = [];
        for (const delivery of store.listPendingDeliveries(characterKey, target)) {
          if (literals.length >= LIMITS.packetDeliveries) break;
          const size = luaByteLength(delivery.body_lua) + 1;
          if (bytes + size > LIMITS.inboxLuaBytes) break;
          bytes += size;
          literals.push(delivery.body_lua);
          ids.push(delivery.delivery_id);
        }
        const signature = JSON.stringify([characterKey, target, acceptedMessageKeys, ids]);
        if (signature === this.lastSignature) return { kind: 'unchanged' };
        header.publicationRevision = store.allocatePublicationRevision();
        for (const id of ids) store.setDeliveryPublished(id, header.publicationRevision);
        return { kind: 'packet', header, literals, signature };
      });
    } catch (error) {
      diag.error('publish.storage_error', { error: String(error) });
      return { status: 'failed', reason: 'storage_error' };
    }
    if (prepared.kind !== 'packet') return { status: 'skipped', reason: prepared.kind };

    const content = buildInboxLua(prepared.header, prepared.literals);
    const pool = this.deps.pool.write(content);
    const report: PublishReport = {
      revision: prepared.header.publicationRevision,
      characterKey: prepared.header.targetCharacterKey,
      deliveries: prepared.literals.length,
      ackKeys: prepared.header.acceptedMessageKeys.length,
      bytes: luaByteLength(content),
      pool,
    };
    diag.event('publish.written', {
      revision: report.revision,
      character: shortKey(report.characterKey),
      deliveries: report.deliveries,
      ackKeys: report.ackKeys,
      bytes: report.bytes,
      written: pool.written,
      failed: pool.failed.length,
    });
    if (pool.failed.length > 0) {
      // A write failure leaves deliveries pending; the next attempt rewrites the pool.
      diag.warn('publish.pool_failed', { slots: pool.failed.slice(0, 10).map((f) => `${f.slot}:${f.error}`) });
      this.lastSignature = null;
      return { status: 'failed', reason: 'pool_write' };
    }
    this.lastSignature = prepared.signature;
    return { status: 'published', report };
  }
}
