// Compose the bridge core without transport: storage, reception, conversations and attempts.
import type { ModelAdapter } from '../ai/adapter.js';
import type { Clock } from '../clock.js';
import type { Diagnostics } from '../diagnostics.js';
import type { Store } from '../storage/store.js';
import { Conversations, type BridgeCapabilities } from './conversations.js';
import { Outbox } from './outbox.js';
import { Requests } from './requests.js';
import { Router, type InboundMessage, type RouteResult } from './router.js';
import { Scheduler, type RecoveryReport } from './scheduler.js';

export interface BridgeOptions {
  store: Store;
  clock: Clock;
  diag: Diagnostics;
  adapter: ModelAdapter;
  capabilities?: () => BridgeCapabilities;
  onCommitted?: (characterKey: string) => void;
  onPriceResult?: (lookupId: string) => void;
  /** Current working reference dataset to pin to a question. */
  datasetId?: () => string | null;
  /** Verify that an interrupted attempt's process tree stopped (Codex). */
  confirmStop?: (attempt: { jobName: string; childPid: number | null; childCreatedAt: number | null }) => Promise<boolean>;
}

export class Bridge {
  readonly store: Store;
  readonly outbox: Outbox;
  readonly conversations: Conversations;
  readonly requests: Requests;
  readonly scheduler: Scheduler;
  readonly router: Router;

  constructor(options: BridgeOptions) {
    const { store, clock, diag, adapter } = options;
    this.store = store;
    this.outbox = new Outbox(store);
    const capabilities =
      options.capabilities ?? (() => ({ map: false, auctionator: false, limitations: [...adapter.limitations] }));
    this.conversations = new Conversations(store, this.outbox, capabilities);
    this.requests = new Requests(store, this.outbox, this.conversations);
    this.scheduler = new Scheduler({
      store,
      outbox: this.outbox,
      conversations: this.conversations,
      adapter,
      clock,
      diag,
      ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
      ...(options.datasetId ? { datasetId: options.datasetId } : {}),
      ...(options.confirmStop ? { confirmStop: options.confirmStop } : {}),
    });
    this.router = new Router({
      store,
      clock,
      diag,
      requests: this.requests,
      conversations: this.conversations,
      scheduler: this.scheduler,
      ...(options.onCommitted ? { onCommitted: options.onCommitted } : {}),
      ...(options.onPriceResult ? { onPriceResult: options.onPriceResult } : {}),
    });
  }

  /** Recover after restart and start accepted questions. */
  start(): RecoveryReport {
    const report = this.scheduler.recover();
    this.scheduler.kick();
    return report;
  }

  /**
   * Restart with external processes: first confirm interrupted trees stopped,
   * then start accepted questions, or session resumption remains blocked.
   */
  async startWithStopChecks(): Promise<RecoveryReport> {
    const report = this.scheduler.recover();
    await this.scheduler.verifyStops();
    this.scheduler.kick();
    return report;
  }

  receive(message: InboundMessage): RouteResult {
    return this.router.handle(message);
  }

  async shutdown(): Promise<void> {
    await this.scheduler.shutdown();
  }
}
