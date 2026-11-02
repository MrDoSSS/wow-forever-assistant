// Sole owner of SQLite: one connection, prepared statements,
// short BEGIN IMMEDIATE transactions. Callers perform network operations,
// model calls, capture and pool writes outside transactions.
import { DatabaseSync, type SQLInputValue, type StatementSync } from './sqlite.js';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Clock } from '../clock.js';
import type { DeliveryType, Identity, MessageKey, RequestKey } from '../contracts.js';
import { randomId } from '../ids.js';
import { resourcePath } from '../paths.js';

import { loadSchemaSteps, prepareDatabase, SchemaError } from './migrations.js';
export { SCHEMA_VERSION } from './migrations.js';

export type StoreErrorCode = 'locked' | 'schema_rejected' | 'storage_error';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/** Fault injection points for recovery tests. */
export interface StoreFaults {
  beforeCommit?: (label: string) => void;
}

export interface StoreOptions {
  path: string;
  clock: Clock;
  faults?: StoreFaults;
  schemaPath?: string;
  /** Backup directory before migration; defaults to backups next to the database. */
  backupDir?: string;
}

export type RequestState = 'accepted' | 'running' | 'completed' | 'needs_data' | 'failed' | 'cancelled';
export type AttemptState = 'running' | 'succeeded' | 'invalid_result' | 'failed' | 'cancelled' | 'interrupted';
export type AttemptPhase = 'starting' | 'resolving' | 'generating' | 'validating';
export type DeliveryState = 'pending' | 'applied' | 'suppressed';
export type ReceivedOutcome = 'applied' | 'no_effect' | 'busy' | 'history_cleared' | 'late_result';
export type PriceLookupState = 'pending' | 'completed' | 'timed_out' | 'cancelled';

export const ACTIVE_REQUEST_STATES: readonly RequestState[] = ['accepted', 'running'];

export interface CharacterRow {
  character_key: string;
  server_namespace: string | null;
  realm: string | null;
  player_guid: string | null;
  display_name: string | null;
  created_at: number;
  last_seen_at: number;
  policy_revision: number | null;
  policy_json: string | null;
}

export interface ConversationRow {
  character_key: string;
  conversation_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  history_revision: number;
}

export interface ClearedRow {
  character_key: string;
  conversation_id: string;
  replacement_conversation_id: string;
  operation_id: string;
  cleared_at: number;
}

export interface ReceivedRow {
  character_key: string;
  origin_session_id: string;
  message_sequence: number;
  kind: number;
  conversation_id: string | null;
  raw_body: Uint8Array | null;
  body_sha256: string;
  outcome: ReceivedOutcome;
  accepted_at: number;
  last_seen_at: number;
}

export interface RequestRow {
  character_key: string;
  origin_session_id: string;
  request_id: number;
  conversation_id: string | null;
  snapshot_id: number | null;
  query_message_sequence: number | null;
  raw_body: Uint8Array | null;
  body_sha256: string | null;
  state: RequestState;
  current_attempt_id: string | null;
  created_at: number;
  accepted_at: number | null;
  finished_at: number | null;
  error_code: string | null;
}

export interface AttemptRow {
  attempt_id: string;
  character_key: string;
  conversation_id: string;
  origin_session_id: string;
  request_id: number;
  ordinal: number;
  model_generation: number;
  dataset_id: string | null;
  state: AttemptState;
  phase: AttemptPhase;
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
  process_job_name: string | null;
  host_pid: number | null;
  host_created_at: number | null;
  child_pid: number | null;
  child_created_at: number | null;
  stop_confirmed_at: number | null;
}

export interface ModelSessionRow {
  character_key: string;
  conversation_id: string;
  generation: number;
  codex_session_id: string | null;
  reset_epoch: number;
  is_current: number;
  created_at: number;
  closed_at: number | null;
}

export interface ReplyRow {
  reply_id: string;
  character_key: string;
  origin_session_id: string;
  request_id: number;
  attempt_id: string | null;
  body_json: string;
  created_at: number;
}

export interface DeliveryRow {
  delivery_id: string;
  kind: DeliveryType;
  character_key: string;
  conversation_id: string | null;
  origin_session_id: string | null;
  request_id: number | null;
  reply_id: string | null;
  target_session_id: string;
  body_lua: string;
  state: DeliveryState;
  created_at: number;
  last_publication_revision: number | null;
  applied_at: number | null;
}

export interface PriceLookupRow {
  lookup_id: string;
  attempt_id: string;
  requested_items_json: string;
  state: PriceLookupState;
  expires_at: number;
  result_sha256: string | null;
}

export interface PriceObservationInsert {
  observationId: string;
  request: RequestKey;
  lookupId: string;
  itemId: number;
  marketKey: string;
  priceCopper: number | null;
  readOriginSessionId: string;
  readAtSessionMs: number;
  receivedAt: number;
  ageDays: number | null;
  agePrecision: string;
  rawExactness: boolean | null;
  sourceVersion: string;
  originalItemLink: string | null;
  exactness: string;
  unavailableReason: string | null;
}

export interface DatasetRow {
  source_kind: 'forevermaster' | 'questiedb';
  dataset_id: string;
  archive_sha256: string;
  decoder_version: number;
  source_url: string;
  source_etag: string | null;
  source_last_modified: string | null;
  archive_path: string;
  index_path: string;
  status: 'candidate' | 'active' | 'retired' | 'rejected';
  created_at: number;
  activated_at: number | null;
  error_code: string | null;
  skipped_count: number;
  pack_version: string | null;
  pack_build: string | null;
}

export interface ToolCallRow {
  call_id: string;
  attempt_id: string;
  tool: string;
  args_sha256: string;
  state: 'reserved' | 'done' | 'error';
  result_json: string | null;
  result_bytes: number;
  created_at: number;
  finished_at: number | null;
}

export interface PriceObservationRow {
  observation_id: string;
  lookup_id: string;
  item_id: number;
  market_key: string;
  price_copper: number | null;
  read_origin_session_id: string;
  read_at_session_ms: number;
  received_at: number;
  age_days: number | null;
  age_precision: 'day_bucket' | 'unknown';
  raw_exactness: number | null;
  source_version: string;
  original_item_link: string | null;
  exactness: 'exact' | 'fallback' | 'unknown';
  unavailable_reason: string | null;
}

export interface VerifiedRefRow {
  ref_id: string;
  attempt_id: string;
  kind: 'item' | 'recipe' | 'location' | 'calculation';
  body_json: string;
}

export interface HistoryCursorRow {
  cursor_id: string;
  character_key: string;
  conversation_id: string;
  history_revision: number;
  last_created_at: number;
  last_entry_id: string;
}

export interface TransportStateRow {
  installation_id: string;
  next_publication_revision: number;
  active_character_key: string | null;
  active_delivery_session_id: string | null;
}

type Row = Record<string, unknown>;

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

export class Store {
  private readonly statements = new Map<string, StatementSync>();
  private inTransaction = false;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
    private readonly faults: StoreFaults | undefined,
  ) {}

  /** Verified backup before a schema update; null when no update was needed. */
  migrationBackup: string | null = null;

  static open(options: StoreOptions): Store {
    return Store.openOnce(options);
  }

  private static openOnce(options: StoreOptions): Store {
    mkdirSync(dirname(options.path), { recursive: true });
    const schemaPath = options.schemaPath ?? resourcePath('bridge', 'src', 'storage', 'schema.sql');
    const steps = loadSchemaSteps(schemaPath, join(dirname(schemaPath), 'migrations'));
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(options.path, { enableForeignKeyConstraints: true, timeout: 2500 });
    } catch (error) {
      throw new StoreError('storage_error', `cannot open database: ${(error as Error).message}`, { cause: error });
    }
    try {
      const version = String(db.prepare('SELECT sqlite_version() AS version').get()!.version).split('.').map(Number);
      if (version[0]! < 3 || (version[0] === 3 && version[1]! < 45)) {
        throw new StoreError('schema_rejected', 'SQLite >= 3.45 is required for JSONB. On macOS run brew install sqlite or set FOREVER_ASSISTANT_SQLITE to a compatible libsqlite3.dylib.');
      }
      // An exclusive WAL lock lasts until the connection closes:
      // a second bridge using the same database is rejected before interacting with the game.
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 2500');
      const store = new Store(db, options.clock, options.faults);
      store.migrationBackup = prepareDatabase(db, steps, {
        backupDir: options.backupDir ?? join(dirname(options.path), 'backups'),
        now: options.clock.now(),
        initialize: () => db.prepare('INSERT INTO transport_state (installation_id) VALUES (?)').run(randomId()),
      });
      // Acquire the exclusive lock even when there are no pending migrations.
      db.exec('BEGIN IMMEDIATE');
      db.prepare('UPDATE transport_state SET next_publication_revision = next_publication_revision').run();
      db.exec('COMMIT');
      return store;
    } catch (error) {
      db.close();
      if (error instanceof StoreError) throw error;
      if (error instanceof SchemaError) throw new StoreError('schema_rejected', error.message, { cause: error });
      if (isBusy(error)) {
        throw new StoreError('locked', 'database is used by another bridge instance', { cause: error });
      }
      throw new StoreError('storage_error', (error as Error).message, { cause: error });
    }
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  // -------------------------------------------------------------------------
  // Transactions and statements

  transaction<T>(label: string, fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('store transactions must be synchronous');
      this.faults?.beforeCommit?.(label);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The connection is already outside a transaction.
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Only for tests and diagnostics: inspect constraints and contents. */
  rawQuery<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
  }

  rawExec(sql: string): void {
    this.db.exec(sql);
  }

  integrityCheck(): { quickCheck: string; foreignKeyViolations: number } {
    const quick = this.db.prepare('PRAGMA quick_check').all() as Row[];
    const fk = this.db.prepare('PRAGMA foreign_key_check').all();
    return { quickCheck: String(quick[0]?.quick_check ?? ''), foreignKeyViolations: fk.length };
  }

  // -------------------------------------------------------------------------
  // Characters and policy

  ensureCharacter(characterKey: string, now: number): void {
    this.run(
      `INSERT INTO characters (character_key, created_at, last_seen_at) VALUES (?, ?, ?)
       ON CONFLICT (character_key) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      characterKey,
      now,
      now,
    );
  }

  getCharacter(characterKey: string): CharacterRow | undefined {
    return this.get<CharacterRow>('SELECT * FROM characters WHERE character_key = ?', characterKey);
  }

  setIdentity(characterKey: string, identity: Identity): void {
    this.run(
      `UPDATE characters SET server_namespace = ?, realm = ?, player_guid = ?, display_name = ?
       WHERE character_key = ?`,
      identity.serverNamespace,
      identity.realm,
      identity.playerGuid,
      identity.displayName,
      characterKey,
    );
  }

  setPolicy(characterKey: string, revision: number, policyJson: string): void {
    this.run(
      'UPDATE characters SET policy_revision = ?, policy_json = ? WHERE character_key = ?',
      revision,
      policyJson,
      characterKey,
    );
  }

  // -------------------------------------------------------------------------
  // Received messages

  getReceived(characterKey: string, originSessionId: string, messageSequence: number): ReceivedRow | undefined {
    return this.get<ReceivedRow>(
      `SELECT * FROM received_messages
       WHERE character_key = ? AND origin_session_id = ? AND message_sequence = ?`,
      characterKey,
      originSessionId,
      messageSequence,
    );
  }

  insertReceived(row: Omit<ReceivedRow, 'last_seen_at'>): void {
    this.run(
      `INSERT INTO received_messages (character_key, origin_session_id, message_sequence, kind, conversation_id,
         raw_body, body_sha256, outcome, accepted_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.character_key,
      row.origin_session_id,
      row.message_sequence,
      row.kind,
      row.conversation_id,
      row.raw_body,
      row.body_sha256,
      row.outcome,
      row.accepted_at,
      row.accepted_at,
    );
  }

  updateReceived(
    key: { characterKey: string } & MessageKey,
    update: { outcome?: ReceivedOutcome; conversationId?: string; dropRawBody?: boolean },
  ): void {
    this.run(
      `UPDATE received_messages SET
         outcome = coalesce(?, outcome),
         conversation_id = coalesce(?, conversation_id),
         raw_body = CASE WHEN ? THEN NULL ELSE raw_body END
       WHERE character_key = ? AND origin_session_id = ? AND message_sequence = ?`,
      update.outcome ?? null,
      update.conversationId ?? null,
      update.dropRawBody ? 1 : 0,
      key.characterKey,
      key.originSessionId,
      key.messageSequence,
    );
  }

  touchReceived(key: { characterKey: string } & MessageKey, now: number): void {
    this.run(
      `UPDATE received_messages SET last_seen_at = ?
       WHERE character_key = ? AND origin_session_id = ? AND message_sequence = ?`,
      now,
      key.characterKey,
      key.originSessionId,
      key.messageSequence,
    );
  }

  /** Time of the game session's first received message; null when none exist. */
  firstSeenAt(characterKey: string, originSessionId: string): number | null {
    const row = this.get<{ first: number | null }>(
      'SELECT min(accepted_at) AS first FROM received_messages WHERE character_key = ? AND origin_session_id = ?',
      characterKey,
      originSessionId,
    );
    return row?.first ?? null;
  }

  /** HELLO also selects a conversation; fragment ordering must not undo a newer selection. */
  latestHelloSequence(characterKey: string, originSessionId: string): number {
    const row = this.get<{ sequence: number | null }>(
      'SELECT max(message_sequence) AS sequence FROM received_messages WHERE character_key = ? AND origin_session_id = ? AND kind = 1',
      characterKey,
      originSessionId,
    );
    return row?.sequence ?? 0;
  }

  /** Latest acknowledgeable MessageKeys for a character, up to 128. */
  listAckKeys(characterKey: string, limit: number): MessageKey[] {
    return this.all<{ origin_session_id: string; message_sequence: number }>(
      `SELECT origin_session_id, message_sequence FROM received_messages
       WHERE character_key = ? ORDER BY last_seen_at DESC, accepted_at DESC LIMIT ?`,
      characterKey,
      limit,
    ).map((r) => ({ originSessionId: r.origin_session_id, messageSequence: r.message_sequence }));
  }

  // -------------------------------------------------------------------------
  // Conversations

  getConversation(characterKey: string, conversationId: string): ConversationRow | undefined {
    return this.get<ConversationRow>(
      'SELECT * FROM conversations WHERE character_key = ? AND conversation_id = ?',
      characterKey,
      conversationId,
    );
  }

  insertConversation(row: ConversationRow): void {
    this.run(
      `INSERT INTO conversations (character_key, conversation_id, title, created_at, updated_at, history_revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.character_key,
      row.conversation_id,
      row.title,
      row.created_at,
      row.updated_at,
      row.history_revision,
    );
  }

  touchConversation(characterKey: string, conversationId: string, now: number, title?: string): void {
    this.run(
      `UPDATE conversations SET updated_at = ?, title = coalesce(?, title)
       WHERE character_key = ? AND conversation_id = ?`,
      now,
      title ?? null,
      characterKey,
      conversationId,
    );
  }

  countConversationRequests(characterKey: string, conversationId: string): number {
    const row = this.get<{ n: number }>(
      'SELECT count(*) AS n FROM requests WHERE character_key = ? AND conversation_id = ?',
      characterKey,
      conversationId,
    );
    return row?.n ?? 0;
  }

  getCleared(characterKey: string, conversationId: string): ClearedRow | undefined {
    return this.get<ClearedRow>(
      'SELECT * FROM cleared_conversations WHERE character_key = ? AND conversation_id = ?',
      characterKey,
      conversationId,
    );
  }

  getClearedByOperation(operationId: string): ClearedRow | undefined {
    return this.get<ClearedRow>('SELECT * FROM cleared_conversations WHERE operation_id = ?', operationId);
  }

  insertCleared(row: ClearedRow): void {
    this.run(
      `INSERT INTO cleared_conversations (character_key, conversation_id, replacement_conversation_id, operation_id, cleared_at)
       VALUES (?, ?, ?, ?, ?)`,
      row.character_key,
      row.conversation_id,
      row.replacement_conversation_id,
      row.operation_id,
      row.cleared_at,
    );
  }

  // -------------------------------------------------------------------------
  // Model sessions

  getCurrentModelSession(characterKey: string, conversationId: string): ModelSessionRow | undefined {
    return this.get<ModelSessionRow>(
      `SELECT * FROM model_sessions WHERE character_key = ? AND conversation_id = ? AND is_current = 1`,
      characterKey,
      conversationId,
    );
  }

  getModelSession(characterKey: string, conversationId: string, generation: number): ModelSessionRow | undefined {
    return this.get<ModelSessionRow>(
      'SELECT * FROM model_sessions WHERE character_key = ? AND conversation_id = ? AND generation = ?',
      characterKey,
      conversationId,
      generation,
    );
  }

  insertModelSession(row: Omit<ModelSessionRow, 'codex_session_id' | 'closed_at' | 'is_current'>): void {
    this.run(
      `INSERT INTO model_sessions (character_key, conversation_id, generation, reset_epoch, is_current, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      row.character_key,
      row.conversation_id,
      row.generation,
      row.reset_epoch,
      row.created_at,
    );
  }

  closeModelSession(characterKey: string, conversationId: string, generation: number, now: number): void {
    this.run(
      `UPDATE model_sessions SET is_current = 0, closed_at = ?
       WHERE character_key = ? AND conversation_id = ? AND generation = ?`,
      now,
      characterKey,
      conversationId,
      generation,
    );
  }

  setCodexSessionId(characterKey: string, conversationId: string, generation: number, codexSessionId: string): number {
    return this.run(
      `UPDATE model_sessions SET codex_session_id = ?
       WHERE character_key = ? AND conversation_id = ? AND generation = ?
         AND (codex_session_id IS NULL OR codex_session_id = ?)`,
      codexSessionId,
      characterKey,
      conversationId,
      generation,
      codexSessionId,
    );
  }

  // -------------------------------------------------------------------------
  // Snapshots

  insertSnapshot(key: RequestKey, strictJson: string, sha256: string, now: number): void {
    this.run(
      `INSERT INTO snapshots (character_key, origin_session_id, snapshot_id, schema_version, body_jsonb, body_sha256, created_at)
       VALUES (?, ?, ?, 1, jsonb(?), ?, ?)`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
      strictJson,
      sha256,
      now,
    );
  }

  getSnapshotJson(key: RequestKey): string | undefined {
    return this.get<{ body: string }>(
      `SELECT json(body_jsonb) AS body FROM snapshots
       WHERE character_key = ? AND origin_session_id = ? AND snapshot_id = ?`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    )?.body;
  }

  // -------------------------------------------------------------------------
  // Questions

  getRequest(key: RequestKey): RequestRow | undefined {
    return this.get<RequestRow>(
      'SELECT * FROM requests WHERE character_key = ? AND origin_session_id = ? AND request_id = ?',
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  getActiveRequest(characterKey: string): RequestRow | undefined {
    return this.get<RequestRow>(
      `SELECT * FROM requests WHERE character_key = ? AND state IN ('accepted', 'running')`,
      characterKey,
    );
  }

  listRequestsInState(state: RequestState): RequestRow[] {
    return this.all<RequestRow>('SELECT * FROM requests WHERE state = ? ORDER BY created_at, request_id', state);
  }

  listConversationRequests(characterKey: string, conversationId: string): RequestRow[] {
    return this.all<RequestRow>(
      `SELECT * FROM requests WHERE character_key = ? AND conversation_id = ?
       ORDER BY created_at, origin_session_id, request_id`,
      characterKey,
      conversationId,
    );
  }

  insertAcceptedRequest(
    key: RequestKey,
    input: { conversationId: string; rawBody: Uint8Array; sha256: string },
    now: number,
    createdAt = now,
  ): void {
    this.run(
      `INSERT INTO requests (character_key, origin_session_id, request_id, conversation_id, snapshot_id,
         query_message_sequence, raw_body, body_sha256, state, created_at, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
      input.conversationId,
      key.requestId,
      key.requestId,
      input.rawBody,
      input.sha256,
      createdAt,
      now,
    );
  }

  insertCancelledPlaceholder(key: RequestKey, now: number): void {
    this.run(
      `INSERT INTO requests (character_key, origin_session_id, request_id, state, created_at, finished_at)
       VALUES (?, ?, ?, 'cancelled', ?, ?)`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
      now,
      now,
    );
  }

  /** A late QUERY fills a cancelled question's row while preserving cancelled state. */
  fillCancelledRequest(
    key: RequestKey,
    input: { conversationId: string; rawBody: Uint8Array; sha256: string },
    now: number,
  ): void {
    this.run(
      `UPDATE requests SET conversation_id = ?, snapshot_id = request_id, query_message_sequence = request_id,
         raw_body = ?, body_sha256 = ?, accepted_at = ?
       WHERE character_key = ? AND origin_session_id = ? AND request_id = ? AND state = 'cancelled' AND raw_body IS NULL`,
      input.conversationId,
      input.rawBody,
      input.sha256,
      now,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  setRequestRunning(key: RequestKey, attemptId: string): void {
    this.run(
      `UPDATE requests SET state = 'running', current_attempt_id = ?
       WHERE character_key = ? AND origin_session_id = ? AND request_id = ?`,
      attemptId,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  setRequestCurrentAttempt(key: RequestKey, attemptId: string): void {
    this.run(
      `UPDATE requests SET current_attempt_id = ?
       WHERE character_key = ? AND origin_session_id = ? AND request_id = ?`,
      attemptId,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  finishRequest(
    key: RequestKey,
    state: Exclude<RequestState, 'accepted' | 'running'>,
    now: number,
    errorCode: string | null,
  ): void {
    this.run(
      `UPDATE requests SET state = ?, finished_at = ?, error_code = ?
       WHERE character_key = ? AND origin_session_id = ? AND request_id = ?`,
      state,
      now,
      errorCode,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  // -------------------------------------------------------------------------
  // Attempts

  insertAttempt(row: {
    attemptId: string;
    request: RequestKey;
    conversationId: string;
    ordinal: number;
    modelGeneration: number;
    datasetId: string | null;
    now: number;
  }): void {
    this.run(
      `INSERT INTO attempts (attempt_id, character_key, conversation_id, origin_session_id, request_id, ordinal,
         model_generation, dataset_id, state, phase, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'starting', ?)`,
      row.attemptId,
      row.request.characterKey,
      row.conversationId,
      row.request.originSessionId,
      row.request.requestId,
      row.ordinal,
      row.modelGeneration,
      row.datasetId,
      row.now,
    );
  }

  getAttempt(attemptId: string): AttemptRow | undefined {
    return this.get<AttemptRow>('SELECT * FROM attempts WHERE attempt_id = ?', attemptId);
  }

  getRunningAttempt(characterKey: string): AttemptRow | undefined {
    return this.get<AttemptRow>(
      `SELECT * FROM attempts WHERE character_key = ? AND state = 'running'`,
      characterKey,
    );
  }

  listRunningAttempts(): AttemptRow[] {
    return this.all<AttemptRow>(`SELECT * FROM attempts WHERE state = 'running' ORDER BY started_at`);
  }

  listRequestAttempts(key: RequestKey): AttemptRow[] {
    return this.all<AttemptRow>(
      `SELECT * FROM attempts WHERE character_key = ? AND origin_session_id = ? AND request_id = ? ORDER BY ordinal`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  setAttemptPhase(attemptId: string, phase: AttemptPhase): void {
    this.run(`UPDATE attempts SET phase = ? WHERE attempt_id = ? AND state = 'running'`, phase, attemptId);
  }

  finishAttempt(attemptId: string, state: Exclude<AttemptState, 'running'>, now: number, errorCode: string | null): number {
    return this.run(
      `UPDATE attempts SET state = ?, finished_at = ?, error_code = ? WHERE attempt_id = ? AND state = 'running'`,
      state,
      now,
      errorCode,
      attemptId,
    );
  }

  confirmAttemptStopped(attemptId: string, now: number): void {
    this.run('UPDATE attempts SET stop_confirmed_at = coalesce(stop_confirmed_at, ?) WHERE attempt_id = ?', now, attemptId);
  }

  // -------------------------------------------------------------------------
  // Replies

  insertReply(row: {
    replyId: string;
    request: RequestKey;
    attemptId: string | null;
    gameReplyJson: string;
    now: number;
  }): void {
    this.run(
      `INSERT INTO replies (reply_id, character_key, origin_session_id, request_id, attempt_id, schema_version,
         body_jsonb, created_at)
       VALUES (?, ?, ?, ?, ?, 1, jsonb(?), ?)`,
      row.replyId,
      row.request.characterKey,
      row.request.originSessionId,
      row.request.requestId,
      row.attemptId,
      row.gameReplyJson,
      row.now,
    );
  }

  getReplyForRequest(key: RequestKey): ReplyRow | undefined {
    return this.get<ReplyRow>(
      `SELECT reply_id, character_key, origin_session_id, request_id, attempt_id, json(body_jsonb) AS body_json, created_at
       FROM replies WHERE character_key = ? AND origin_session_id = ? AND request_id = ?`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  listConversationReplies(characterKey: string, conversationId: string): ReplyRow[] {
    return this.all<ReplyRow>(
      `SELECT p.reply_id, p.character_key, p.origin_session_id, p.request_id, p.attempt_id,
         json(p.body_jsonb) AS body_json, p.created_at
       FROM replies p JOIN requests r
         ON r.character_key = p.character_key AND r.origin_session_id = p.origin_session_id
        AND r.request_id = p.request_id
       WHERE r.character_key = ? AND r.conversation_id = ?`,
      characterKey,
      conversationId,
    );
  }

  // -------------------------------------------------------------------------
  // Deliveries

  insertDelivery(row: Omit<DeliveryRow, 'state' | 'last_publication_revision' | 'applied_at'>): void {
    this.run(
      `INSERT INTO deliveries (delivery_id, kind, character_key, conversation_id, origin_session_id, request_id,
         reply_id, target_session_id, body_lua, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      row.delivery_id,
      row.kind,
      row.character_key,
      row.conversation_id,
      row.origin_session_id,
      row.request_id,
      row.reply_id,
      row.target_session_id,
      row.body_lua,
      row.created_at,
    );
  }

  getDelivery(deliveryId: string): DeliveryRow | undefined {
    return this.get<DeliveryRow>('SELECT * FROM deliveries WHERE delivery_id = ?', deliveryId);
  }

  listPendingDeliveries(characterKey: string, targetSessionId: string): DeliveryRow[] {
    return this.all<DeliveryRow>(
      `SELECT * FROM deliveries WHERE character_key = ? AND target_session_id = ? AND state = 'pending'
       ORDER BY created_at, rowid`,
      characterKey,
      targetSessionId,
    );
  }

  listCharacterDeliveries(characterKey: string): DeliveryRow[] {
    return this.all<DeliveryRow>(
      'SELECT * FROM deliveries WHERE character_key = ? ORDER BY created_at, rowid',
      characterKey,
    );
  }

  listRequestDeliveries(key: RequestKey): DeliveryRow[] {
    return this.all<DeliveryRow>(
      `SELECT * FROM deliveries WHERE character_key = ? AND origin_session_id = ? AND request_id = ?
       ORDER BY created_at, rowid`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  markDeliveryApplied(characterKey: string, deliveryId: string, now: number): number {
    return this.run(
      `UPDATE deliveries SET state = 'applied', applied_at = ?
       WHERE character_key = ? AND delivery_id = ? AND state = 'pending'`,
      now,
      characterKey,
      deliveryId,
    );
  }

  reopenDelivery(deliveryId: string): void {
    this.run(`UPDATE deliveries SET state = 'pending', applied_at = NULL WHERE delivery_id = ? AND state = 'applied'`, deliveryId);
  }

  suppressRequestDeliveries(key: RequestKey, kinds?: readonly DeliveryType[]): number {
    const kindFilter = kinds ? `AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return this.run(
      `UPDATE deliveries SET state = 'suppressed'
       WHERE character_key = ? AND origin_session_id = ? AND request_id = ? AND state = 'pending' ${kindFilter}`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
      ...(kinds ?? []),
    );
  }

  suppressPendingOfKinds(characterKey: string, kinds: readonly DeliveryType[]): number {
    return this.run(
      `UPDATE deliveries SET state = 'suppressed'
       WHERE character_key = ? AND state = 'pending' AND kind IN (${kinds.map(() => '?').join(', ')})`,
      characterKey,
      ...kinds,
    );
  }

  retargetPendingDeliveries(characterKey: string, targetSessionId: string): number {
    return this.run(
      `UPDATE deliveries SET target_session_id = ? WHERE character_key = ? AND state = 'pending'`,
      targetSessionId,
      characterKey,
    );
  }

  setDeliveryPublished(deliveryId: string, revision: number): void {
    this.run('UPDATE deliveries SET last_publication_revision = ? WHERE delivery_id = ?', revision, deliveryId);
  }

  // -------------------------------------------------------------------------
  // Transport

  getTransportState(): TransportStateRow {
    const row = this.get<TransportStateRow>('SELECT * FROM transport_state LIMIT 1');
    if (!row) throw new StoreError('storage_error', 'transport_state row is missing');
    return row;
  }

  setActiveTarget(characterKey: string, deliverySessionId: string): void {
    this.run(
      'UPDATE transport_state SET active_character_key = ?, active_delivery_session_id = ?',
      characterKey,
      deliverySessionId,
    );
  }

  /** Allocate a publication revision; stop writing when the safe integer range is exhausted. */
  allocatePublicationRevision(): number {
    const state = this.getTransportState();
    const revision = state.next_publication_revision;
    if (!Number.isSafeInteger(revision + 1)) {
      throw new StoreError('storage_error', 'publication revision exhausted');
    }
    this.run('UPDATE transport_state SET next_publication_revision = ?', revision + 1);
    return revision;
  }

  // -------------------------------------------------------------------------
  // Prices

  insertPriceLookup(row: PriceLookupRow): void {
    this.run(
      `INSERT INTO price_lookups (lookup_id, attempt_id, requested_items_json, state, expires_at, result_sha256)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.lookup_id,
      row.attempt_id,
      row.requested_items_json,
      row.state,
      row.expires_at,
      row.result_sha256,
    );
  }

  getPriceLookup(lookupId: string): PriceLookupRow | undefined {
    return this.get<PriceLookupRow>('SELECT * FROM price_lookups WHERE lookup_id = ?', lookupId);
  }

  setPriceLookupState(lookupId: string, state: PriceLookupState, resultSha256: string | null): void {
    this.run(
      'UPDATE price_lookups SET state = ?, result_sha256 = coalesce(?, result_sha256) WHERE lookup_id = ?',
      state,
      resultSha256,
      lookupId,
    );
  }

  insertClientItemInfo(row: { infoId: string; request: RequestKey; lookupId: string; itemId: number; originalItemLink: string | null; bodyJson: string; receivedAt: number }): void {
    this.run(
      `INSERT INTO client_item_info (info_id, character_key, origin_session_id, request_id, lookup_id, item_id, original_item_link, body_json, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.infoId,
      row.request.characterKey,
      row.request.originSessionId,
      row.request.requestId,
      row.lookupId,
      row.itemId,
      row.originalItemLink,
      row.bodyJson,
      row.receivedAt,
    );
  }

  /** Client item information for one lookup, in addon reply order. */
  listClientItemInfo(lookupId: string): string[] {
    return this.all<{ body_json: string }>('SELECT body_json FROM client_item_info WHERE lookup_id = ? ORDER BY rowid', lookupId).map((r) => r.body_json);
  }

  cancelPendingLookups(attemptId: string): number {
    return this.run(
      `UPDATE price_lookups SET state = 'cancelled' WHERE attempt_id = ? AND state = 'pending'`,
      attemptId,
    );
  }

  insertPriceObservation(o: PriceObservationInsert): void {
    this.run(
      `INSERT INTO price_observations (observation_id, character_key, origin_session_id, request_id, lookup_id,
         item_id, variant_key, market_key, unit, price_copper, read_origin_session_id, read_at_session_ms,
         received_at, source_observed_at, age_days, age_precision, raw_exactness, source_version,
         original_item_link, exactness, unavailable_reason)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'per_item', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      o.observationId,
      o.request.characterKey,
      o.request.originSessionId,
      o.request.requestId,
      o.lookupId,
      o.itemId,
      o.marketKey,
      o.priceCopper,
      o.readOriginSessionId,
      o.readAtSessionMs,
      o.receivedAt,
      o.ageDays,
      o.agePrecision,
      o.rawExactness === null ? null : o.rawExactness ? 1 : 0,
      o.sourceVersion,
      o.originalItemLink,
      o.exactness,
      o.unavailableReason,
    );
  }

  countPriceObservations(lookupId: string): number {
    return this.get<{ n: number }>('SELECT count(*) AS n FROM price_observations WHERE lookup_id = ?', lookupId)?.n ?? 0;
  }

  // -------------------------------------------------------------------------
  // ForeverMaster datasets: candidate -> active | rejected; previous active -> retired.

  /** Candidate: importing the same datasetId again after a crash starts over. */
  upsertCandidateDataset(row: {
    sourceKind?: DatasetRow['source_kind'];
    datasetId: string;
    archiveSha256: string;
    decoderVersion: number;
    sourceUrl: string;
    etag: string | null;
    lastModified: string | null;
    archivePath: string;
    indexPath: string;
    now: number;
  }): void {
    this.run(
      `INSERT INTO datasets (dataset_id, archive_sha256, decoder_version, source_url, source_etag, source_last_modified,
         archive_path, index_path, status, created_at, source_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)
       ON CONFLICT (dataset_id) DO UPDATE SET status = 'candidate', error_code = NULL,
         source_etag = excluded.source_etag, source_last_modified = excluded.source_last_modified,
         archive_path = excluded.archive_path, index_path = excluded.index_path`,
      row.datasetId,
      row.archiveSha256,
      row.decoderVersion,
      row.sourceUrl,
      row.etag,
      row.lastModified,
      row.archivePath,
      row.indexPath,
      row.now,
      row.sourceKind ?? 'forevermaster',
    );
  }

  getDataset(datasetId: string): DatasetRow | undefined {
    return this.get<DatasetRow>('SELECT * FROM datasets WHERE dataset_id = ?', datasetId);
  }

  getActiveDataset(sourceKind: DatasetRow['source_kind'] = 'forevermaster'): DatasetRow | undefined {
    return this.get<DatasetRow>(`SELECT * FROM datasets WHERE status = 'active' AND source_kind = ?`, sourceKind);
  }

  activateDataset(
    datasetId: string,
    now: number,
    summary: { skippedCount: number; skippedJson: string; packVersion: string | null; packBuild: string | null; packHash: string | null },
  ): void {
    this.run(`UPDATE datasets SET status = 'retired' WHERE status = 'active' AND dataset_id <> ?
      AND source_kind = (SELECT source_kind FROM datasets WHERE dataset_id = ?)`, datasetId, datasetId);
    this.run(
      `UPDATE datasets SET status = 'active', activated_at = ?, error_code = NULL, skipped_count = ?, skipped_summary_json = ?,
         pack_version = ?, pack_build = ?, pack_hash = ?
       WHERE dataset_id = ?`,
      now,
      summary.skippedCount,
      summary.skippedJson,
      summary.packVersion,
      summary.packBuild,
      summary.packHash,
      datasetId,
    );
  }

  rejectDataset(datasetId: string, errorCode: string): void {
    this.run(`UPDATE datasets SET status = 'rejected', error_code = ? WHERE dataset_id = ? AND status = 'candidate'`, errorCode, datasetId);
  }

  setDatasetSource(datasetId: string, etag: string | null, lastModified: string | null): void {
    this.run(
      'UPDATE datasets SET source_etag = coalesce(?, source_etag), source_last_modified = coalesce(?, source_last_modified) WHERE dataset_id = ?',
      etag,
      lastModified,
      datasetId,
    );
  }

  // -------------------------------------------------------------------------
  // Tool calls: reserve before calling; save the result before returning to the model.

  getToolCall(callId: string): ToolCallRow | undefined {
    return this.get<ToolCallRow>('SELECT * FROM tool_calls WHERE call_id = ?', callId);
  }

  reserveToolCall(row: { callId: string; attemptId: string; tool: string; argsSha256: string; now: number }): void {
    this.run(
      `INSERT INTO tool_calls (call_id, attempt_id, tool, args_sha256, state, created_at)
       VALUES (?, ?, ?, ?, 'reserved', ?)`,
      row.callId,
      row.attemptId,
      row.tool,
      row.argsSha256,
      row.now,
    );
  }

  finishToolCall(callId: string, state: 'done' | 'error', resultJson: string, now: number): void {
    this.run(
      `UPDATE tool_calls SET state = ?, result_json = ?, result_bytes = ?, finished_at = ? WHERE call_id = ?`,
      state,
      resultJson,
      Buffer.byteLength(resultJson),
      now,
      callId,
    );
  }

  countToolCalls(attemptId: string): number {
    return this.get<{ n: number }>('SELECT count(*) AS n FROM tool_calls WHERE attempt_id = ?', attemptId)?.n ?? 0;
  }

  /** Total tool result size for a question, including its correction attempt. */
  requestResultBytes(key: RequestKey): number {
    return (
      this.get<{ n: number | null }>(
        `SELECT sum(c.result_bytes) AS n FROM tool_calls c JOIN attempts a ON a.attempt_id = c.attempt_id
         WHERE a.character_key = ? AND a.origin_session_id = ? AND a.request_id = ?`,
        key.characterKey,
        key.originSessionId,
        key.requestId,
      )?.n ?? 0
    );
  }

  // -------------------------------------------------------------------------
  // Attempt process: job, PID and creation times for recovery.

  setAttemptProcess(
    attemptId: string,
    info: { jobName: string; hostPid: number | null; hostCreatedAt: number | null; childPid: number; childCreatedAt: number },
  ): void {
    this.run(
      `UPDATE attempts SET process_job_name = ?, host_pid = ?, host_created_at = ?, child_pid = ?, child_created_at = ?
       WHERE attempt_id = ?`,
      info.jobName,
      info.hostPid,
      info.hostCreatedAt,
      info.childPid,
      info.childCreatedAt,
      attemptId,
    );
  }

  /** Finished attempts whose external process stop is not yet confirmed. */
  listUnconfirmedStops(): AttemptRow[] {
    return this.all<AttemptRow>(
      `SELECT * FROM attempts WHERE state <> 'running' AND process_job_name IS NOT NULL AND stop_confirmed_at IS NULL`,
    );
  }

  /** Do not resume a model session before confirming that its previous process tree stopped. */
  hasUnconfirmedStop(characterKey: string, conversationId: string, generation: number): boolean {
    const row = this.get<{ n: number }>(
      `SELECT count(*) AS n FROM attempts WHERE character_key = ? AND conversation_id = ? AND model_generation = ?
         AND process_job_name IS NOT NULL AND stop_confirmed_at IS NULL AND state <> 'running'`,
      characterKey,
      conversationId,
      generation,
    );
    return (row?.n ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Immutable evidence: the same contents of the same record yield the same ID.

  findEvidence(sourceKind: string, datasetId: string | null, recordKey: string | null, contentSha256: string): string | undefined {
    return this.get<{ evidence_id: string }>(
      `SELECT evidence_id FROM evidence WHERE source_kind = ? AND dataset_id IS ? AND record_key IS ? AND content_sha256 = ?`,
      sourceKind,
      datasetId,
      recordKey,
      contentSha256,
    )?.evidence_id;
  }

  insertEvidence(row: {
    evidenceId: string;
    sourceKind: string;
    sourceUrl: string | null;
    datasetId: string | null;
    recordKey: string | null;
    contentSha256: string;
    retrievedAt: number;
    applicabilityJson: string;
    usedContentJson: string;
  }): void {
    this.run(
      `INSERT INTO evidence (evidence_id, source_kind, source_url, dataset_id, record_key, content_sha256, retrieved_at,
         applicability_json, used_content_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.evidenceId,
      row.sourceKind,
      row.sourceUrl,
      row.datasetId,
      row.recordKey,
      row.contentSha256,
      row.retrievedAt,
      row.applicabilityJson,
      row.usedContentJson,
    );
  }

  linkEvidence(attemptId: string, evidenceId: string, purpose: string): void {
    this.run(
      'INSERT OR IGNORE INTO request_evidence (attempt_id, evidence_id, purpose) VALUES (?, ?, ?)',
      attemptId,
      evidenceId,
      purpose,
    );
  }

  insertVerifiedRef(row: { refId: string; attemptId: string; kind: VerifiedRefRow['kind']; bodyJson: string }): void {
    this.run(
      'INSERT INTO verified_refs (ref_id, attempt_id, kind, body_json) VALUES (?, ?, ?, ?)',
      row.refId,
      row.attemptId,
      row.kind,
      row.bodyJson,
    );
  }

  listRequestPriceObservations(key: RequestKey): PriceObservationRow[] {
    return this.all<PriceObservationRow>(
      `SELECT * FROM price_observations WHERE character_key = ? AND origin_session_id = ? AND request_id = ?
       ORDER BY received_at, rowid`,
      key.characterKey,
      key.originSessionId,
      key.requestId,
    );
  }

  // -------------------------------------------------------------------------
  // Verified references and evidence

  getVerifiedRef(refId: string): VerifiedRefRow | undefined {
    return this.get<VerifiedRefRow>('SELECT * FROM verified_refs WHERE ref_id = ?', refId);
  }

  isEvidenceLinked(attemptIds: readonly string[], evidenceId: string): boolean {
    if (attemptIds.length === 0) return false;
    const row = this.get<{ n: number }>(
      `SELECT count(*) AS n FROM request_evidence
       WHERE evidence_id = ? AND attempt_id IN (${attemptIds.map(() => '?').join(', ')})`,
      evidenceId,
      ...attemptIds,
    );
    return (row?.n ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // History cursors

  insertHistoryCursor(row: HistoryCursorRow): void {
    this.run(
      `INSERT INTO history_cursors (cursor_id, character_key, conversation_id, history_revision, last_created_at, last_entry_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.cursor_id,
      row.character_key,
      row.conversation_id,
      row.history_revision,
      row.last_created_at,
      row.last_entry_id,
    );
  }

  getHistoryCursor(cursorId: string): HistoryCursorRow | undefined {
    return this.get<HistoryCursorRow>('SELECT * FROM history_cursors WHERE cursor_id = ?', cursorId);
  }

  // -------------------------------------------------------------------------
  // Clear a conversation and its dependencies except keepMessage.

  deleteConversationData(characterKey: string, conversationId: string, keepMessage: MessageKey): void {
    const chat = [characterKey, conversationId] as const;
    const requestsOfChat = `SELECT origin_session_id, request_id FROM requests WHERE character_key = ? AND conversation_id = ?`;
    const attemptsOfChat = `SELECT attempt_id FROM attempts WHERE character_key = ? AND conversation_id = ?`;
    const evidence = this.all<{ evidence_id: string }>(
      `SELECT DISTINCT evidence_id FROM request_evidence WHERE attempt_id IN (${attemptsOfChat})`,
      ...chat,
    ).map((r) => r.evidence_id);

    this.run(`UPDATE requests SET current_attempt_id = NULL WHERE character_key = ? AND conversation_id = ?`, ...chat);
    this.run(
      `DELETE FROM deliveries WHERE character_key = ? AND (conversation_id = ?
         OR (origin_session_id, request_id) IN (${requestsOfChat}))`,
      characterKey,
      conversationId,
      ...chat,
    );
    this.run(`DELETE FROM request_evidence WHERE attempt_id IN (${attemptsOfChat})`, ...chat);
    this.run(
      `DELETE FROM price_observations WHERE character_key = ? AND (origin_session_id, request_id) IN (${requestsOfChat})`,
      characterKey,
      ...chat,
    );
    this.run(
      `DELETE FROM client_item_info WHERE character_key = ? AND (origin_session_id, request_id) IN (${requestsOfChat})`,
      characterKey,
      ...chat,
    );
    this.run(`DELETE FROM price_lookups WHERE attempt_id IN (${attemptsOfChat})`, ...chat);
    this.run(`DELETE FROM tool_calls WHERE attempt_id IN (${attemptsOfChat})`, ...chat);
    this.run(`DELETE FROM verified_refs WHERE attempt_id IN (${attemptsOfChat})`, ...chat);
    this.run(
      `DELETE FROM replies WHERE character_key = ? AND (origin_session_id, request_id) IN (${requestsOfChat})`,
      characterKey,
      ...chat,
    );
    this.run(`DELETE FROM attempts WHERE character_key = ? AND conversation_id = ?`, ...chat);
    const snapshotKeys = this.all<{ origin_session_id: string; request_id: number }>(requestsOfChat, ...chat);
    this.run(`DELETE FROM requests WHERE character_key = ? AND conversation_id = ?`, ...chat);
    for (const key of snapshotKeys) {
      this.run(
        'DELETE FROM snapshots WHERE character_key = ? AND origin_session_id = ? AND snapshot_id = ?',
        characterKey,
        key.origin_session_id,
        key.request_id,
      );
    }
    this.run(
      `DELETE FROM received_messages WHERE character_key = ? AND conversation_id = ?
         AND NOT (origin_session_id = ? AND message_sequence = ?)`,
      characterKey,
      conversationId,
      keepMessage.originSessionId,
      keepMessage.messageSequence,
    );
    this.run(`DELETE FROM model_sessions WHERE character_key = ? AND conversation_id = ?`, ...chat);
    this.run(`DELETE FROM history_cursors WHERE character_key = ? AND conversation_id = ?`, ...chat);
    this.run(`DELETE FROM conversations WHERE character_key = ? AND conversation_id = ?`, ...chat);
    for (const evidenceId of evidence) {
      this.run(
        `DELETE FROM evidence WHERE evidence_id = ?
           AND NOT EXISTS (SELECT 1 FROM request_evidence WHERE evidence_id = ?)`,
        evidenceId,
        evidenceId,
      );
    }
  }

  now(): number {
    return this.clock.now();
  }
}

export function databaseExists(path: string): boolean {
  return existsSync(path);
}
