-- Working database baseline v4. A new database is created in one transaction
-- with schema_migrations and user_version=4, followed by registered migrations.
-- Older unsupported versions are rejected without replacing the database.
-- Each released SQL file has a checksum; subsequent schema changes belong
-- in a new migration file, never in this baseline.
-- Independent ForeverMaster and QuestieDB datasets share evidence registration.
--
-- Types: IDs, enums and JSON text use TEXT; UTC milliseconds and counters use INTEGER;
-- bytes and JSONB use BLOB. All tables are STRICT.

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at INTEGER NOT NULL
) STRICT;

CREATE TABLE characters (
  character_key TEXT PRIMARY KEY CHECK (length(character_key) = 64 AND character_key NOT GLOB '*[^0-9a-f]*'),
  server_namespace TEXT,
  realm TEXT,
  player_guid TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  policy_revision INTEGER CHECK (policy_revision BETWEEN 1 AND 4294967295),
  policy_json TEXT CHECK (policy_json IS NULL OR json_valid(policy_json)),
  CHECK ((server_namespace IS NULL) = (realm IS NULL) AND (realm IS NULL) = (player_guid IS NULL)),
  CHECK ((policy_revision IS NULL) = (policy_json IS NULL))
) STRICT;

CREATE UNIQUE INDEX characters_identity ON characters (server_namespace, realm, player_guid)
  WHERE player_guid IS NOT NULL;

CREATE TABLE conversations (
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  conversation_id TEXT NOT NULL CHECK (length(conversation_id) = 32 AND conversation_id NOT GLOB '*[^0-9a-f]*'),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  history_revision INTEGER NOT NULL DEFAULT 0 CHECK (history_revision >= 0),
  PRIMARY KEY (character_key, conversation_id)
) STRICT;

CREATE INDEX conversations_by_update ON conversations (character_key, updated_at);

CREATE TABLE model_sessions (
  character_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  codex_session_id TEXT UNIQUE,
  reset_epoch INTEGER NOT NULL CHECK (reset_epoch >= 0),
  is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (character_key, conversation_id, generation),
  FOREIGN KEY (character_key, conversation_id) REFERENCES conversations (character_key, conversation_id),
  CHECK (is_current = 1 OR closed_at IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX model_sessions_current ON model_sessions (character_key, conversation_id)
  WHERE is_current = 1;

CREATE TABLE snapshots (
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  origin_session_id TEXT NOT NULL,
  snapshot_id INTEGER NOT NULL CHECK (snapshot_id BETWEEN 1 AND 4294967295),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  body_jsonb BLOB NOT NULL CHECK (typeof(body_jsonb) = 'blob' AND json_valid(body_jsonb, 8) = 1),
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (character_key, origin_session_id, snapshot_id)
) STRICT;

-- outcome records the receive result for exact retries;
-- last_seen_at allows repeated ACKs for old messages.
CREATE TABLE received_messages (
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  origin_session_id TEXT NOT NULL,
  message_sequence INTEGER NOT NULL CHECK (message_sequence BETWEEN 1 AND 4294967295),
  kind INTEGER NOT NULL CHECK (kind BETWEEN 1 AND 7),
  conversation_id TEXT,
  raw_body BLOB,
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_effect', 'busy', 'history_cleared', 'late_result')),
  accepted_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (character_key, origin_session_id, message_sequence),
  CHECK (kind NOT IN (1, 2, 7) OR conversation_id IS NOT NULL),
  CHECK (raw_body IS NOT NULL OR outcome = 'history_cleared')
) STRICT;

CREATE INDEX received_messages_by_time ON received_messages (character_key, accepted_at);
CREATE INDEX received_messages_by_seen ON received_messages (character_key, last_seen_at);
CREATE INDEX received_messages_by_chat ON received_messages (character_key, conversation_id);

CREATE TABLE datasets (
  dataset_id TEXT PRIMARY KEY CHECK (length(dataset_id) = 32),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('forevermaster', 'questiedb')),
  archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
  decoder_version INTEGER NOT NULL CHECK (decoder_version >= 1),
  source_url TEXT NOT NULL,
  source_etag TEXT,
  source_last_modified TEXT,
  archive_path TEXT NOT NULL,
  index_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'retired', 'rejected')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  error_code TEXT,
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  skipped_summary_json TEXT CHECK (skipped_summary_json IS NULL OR json_valid(skipped_summary_json)),
  pack_version TEXT,
  pack_build TEXT,
  pack_hash TEXT
) STRICT;

CREATE UNIQUE INDEX datasets_one_active ON datasets (source_kind) WHERE status = 'active';

-- The five input fields are nullable only for cancellations received before QUERY.
CREATE TABLE requests (
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  origin_session_id TEXT NOT NULL,
  request_id INTEGER NOT NULL CHECK (request_id BETWEEN 1 AND 4294967295),
  conversation_id TEXT,
  snapshot_id INTEGER,
  query_message_sequence INTEGER,
  raw_body BLOB,
  body_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'running', 'completed', 'needs_data', 'failed', 'cancelled')),
  current_attempt_id TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  PRIMARY KEY (character_key, origin_session_id, request_id),
  UNIQUE (character_key, conversation_id, origin_session_id, request_id),
  FOREIGN KEY (character_key, conversation_id) REFERENCES conversations (character_key, conversation_id),
  FOREIGN KEY (character_key, origin_session_id, snapshot_id)
    REFERENCES snapshots (character_key, origin_session_id, snapshot_id),
  FOREIGN KEY (character_key, origin_session_id, query_message_sequence)
    REFERENCES received_messages (character_key, origin_session_id, message_sequence),
  FOREIGN KEY (character_key, origin_session_id, request_id, current_attempt_id)
    REFERENCES attempts (character_key, origin_session_id, request_id, attempt_id),
  CHECK (snapshot_id IS NULL OR snapshot_id = request_id),
  CHECK (query_message_sequence IS NULL OR query_message_sequence = request_id),
  CHECK (
    (conversation_id IS NULL) = (snapshot_id IS NULL)
    AND (snapshot_id IS NULL) = (query_message_sequence IS NULL)
    AND (query_message_sequence IS NULL) = (raw_body IS NULL)
    AND (raw_body IS NULL) = (body_sha256 IS NULL)
  ),
  CHECK (conversation_id IS NOT NULL OR state = 'cancelled'),
  CHECK ((state IN ('accepted', 'running')) = (finished_at IS NULL)),
  CHECK (state <> 'failed' OR error_code IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX requests_one_active ON requests (character_key) WHERE state IN ('accepted', 'running');
CREATE INDEX requests_by_chat ON requests (character_key, conversation_id, created_at);

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) = 32),
  character_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal IN (1, 2)),
  model_generation INTEGER NOT NULL,
  dataset_id TEXT REFERENCES datasets (dataset_id),
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'invalid_result', 'failed', 'cancelled', 'interrupted')),
  phase TEXT NOT NULL CHECK (phase IN ('starting', 'resolving', 'generating', 'validating')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_code TEXT,
  process_job_name TEXT,
  host_pid INTEGER,
  host_created_at INTEGER,
  child_pid INTEGER,
  child_created_at INTEGER,
  stop_confirmed_at INTEGER,
  UNIQUE (character_key, origin_session_id, request_id, attempt_id),
  UNIQUE (character_key, origin_session_id, request_id, ordinal),
  FOREIGN KEY (character_key, conversation_id, origin_session_id, request_id)
    REFERENCES requests (character_key, conversation_id, origin_session_id, request_id),
  FOREIGN KEY (character_key, conversation_id, model_generation)
    REFERENCES model_sessions (character_key, conversation_id, generation),
  CHECK ((state = 'running') = (finished_at IS NULL))
) STRICT;

CREATE UNIQUE INDEX attempts_one_running ON attempts (character_key) WHERE state = 'running';

-- body_jsonb stores the final GameReply.
CREATE TABLE replies (
  reply_id TEXT PRIMARY KEY CHECK (length(reply_id) = 32),
  character_key TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  attempt_id TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  body_jsonb BLOB NOT NULL CHECK (typeof(body_jsonb) = 'blob' AND json_valid(body_jsonb, 8) = 1),
  created_at INTEGER NOT NULL,
  UNIQUE (character_key, origin_session_id, request_id),
  FOREIGN KEY (character_key, origin_session_id, request_id)
    REFERENCES requests (character_key, origin_session_id, request_id),
  FOREIGN KEY (character_key, origin_session_id, request_id, attempt_id)
    REFERENCES attempts (character_key, origin_session_id, request_id, attempt_id)
) STRICT;

-- conversation_id also associates hello/history/error deliveries without
-- a requests row with the conversation, so clearing it removes them too.
CREATE TABLE deliveries (
  delivery_id TEXT PRIMARY KEY CHECK (length(delivery_id) = 32),
  kind TEXT NOT NULL CHECK (kind IN ('hello', 'history', 'status', 'price_lookup', 'reply', 'error', 'cleared')),
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  conversation_id TEXT,
  origin_session_id TEXT,
  request_id INTEGER,
  reply_id TEXT REFERENCES replies (reply_id),
  target_session_id TEXT NOT NULL CHECK (length(target_session_id) = 32),
  body_lua TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'suppressed')),
  created_at INTEGER NOT NULL,
  last_publication_revision INTEGER,
  applied_at INTEGER,
  CHECK ((origin_session_id IS NULL) = (request_id IS NULL)),
  CHECK ((state = 'applied') = (applied_at IS NOT NULL))
) STRICT;

CREATE INDEX deliveries_by_target ON deliveries (character_key, target_session_id, state, created_at);
CREATE INDEX deliveries_by_request ON deliveries (character_key, origin_session_id, request_id);
CREATE INDEX deliveries_by_chat ON deliveries (character_key, conversation_id);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY CHECK (length(evidence_id) = 32),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('forevermaster', 'questiedb', 'calculation', 'auctionator', 'client')),
  source_url TEXT,
  dataset_id TEXT REFERENCES datasets (dataset_id),
  record_key TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  retrieved_at INTEGER NOT NULL,
  applicability_json TEXT NOT NULL CHECK (json_valid(applicability_json)),
  used_content_json TEXT NOT NULL CHECK (json_valid(used_content_json))
) STRICT;

CREATE INDEX evidence_by_record ON evidence (dataset_id, record_key);

CREATE TABLE request_evidence (
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  evidence_id TEXT NOT NULL REFERENCES evidence (evidence_id),
  purpose TEXT NOT NULL,
  PRIMARY KEY (attempt_id, evidence_id)
) STRICT;

CREATE INDEX request_evidence_by_evidence ON request_evidence (evidence_id);

CREATE TABLE tool_calls (
  call_id TEXT PRIMARY KEY CHECK (length(call_id) = 32),
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  tool TEXT NOT NULL,
  args_sha256 TEXT NOT NULL CHECK (length(args_sha256) = 64),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'done', 'error')),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_bytes INTEGER NOT NULL DEFAULT 0 CHECK (result_bytes >= 0),
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;

CREATE INDEX tool_calls_by_attempt ON tool_calls (attempt_id);

CREATE TABLE price_lookups (
  lookup_id TEXT PRIMARY KEY CHECK (length(lookup_id) = 32),
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  requested_items_json TEXT NOT NULL CHECK (json_valid(requested_items_json)),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'timed_out', 'cancelled')),
  expires_at INTEGER NOT NULL,
  result_sha256 TEXT CHECK (result_sha256 IS NULL OR length(result_sha256) = 64)
) STRICT;

CREATE INDEX price_lookups_by_attempt ON price_lookups (attempt_id);

-- Client item information from PRICE_RESULT.itemInfo (lookup_items).
CREATE TABLE client_item_info (
  info_id TEXT PRIMARY KEY CHECK (length(info_id) = 32),
  character_key TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  lookup_id TEXT NOT NULL REFERENCES price_lookups (lookup_id),
  item_id INTEGER NOT NULL CHECK (item_id BETWEEN 1 AND 2147483647),
  original_item_link TEXT,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  received_at INTEGER NOT NULL,
  FOREIGN KEY (character_key, origin_session_id, request_id)
    REFERENCES requests (character_key, origin_session_id, request_id)
) STRICT;

CREATE INDEX client_item_info_by_lookup ON client_item_info (lookup_id);

CREATE TABLE price_observations (
  observation_id TEXT PRIMARY KEY CHECK (length(observation_id) = 32),
  character_key TEXT NOT NULL,
  origin_session_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  lookup_id TEXT NOT NULL REFERENCES price_lookups (lookup_id),
  item_id INTEGER NOT NULL CHECK (item_id BETWEEN 1 AND 2147483647),
  variant_key TEXT,
  market_key TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit = 'per_item'),
  price_copper INTEGER CHECK (price_copper IS NULL OR price_copper >= 0),
  read_origin_session_id TEXT NOT NULL,
  read_at_session_ms INTEGER NOT NULL CHECK (read_at_session_ms >= 0),
  received_at INTEGER NOT NULL,
  source_observed_at INTEGER,
  age_days INTEGER CHECK (age_days IS NULL OR age_days >= 0),
  age_precision TEXT NOT NULL CHECK (age_precision IN ('day_bucket', 'unknown')),
  raw_exactness INTEGER CHECK (raw_exactness IS NULL OR raw_exactness IN (0, 1)),
  source_version TEXT NOT NULL,
  original_item_link TEXT,
  exactness TEXT NOT NULL CHECK (exactness IN ('exact', 'fallback', 'unknown')),
  unavailable_reason TEXT,
  FOREIGN KEY (character_key, origin_session_id, request_id)
    REFERENCES requests (character_key, origin_session_id, request_id),
  CHECK ((price_copper IS NULL) = (unavailable_reason IS NOT NULL))
) STRICT;

CREATE INDEX price_observations_by_request ON price_observations (character_key, origin_session_id, request_id, lookup_id);

CREATE TABLE verified_refs (
  ref_id TEXT PRIMARY KEY CHECK (length(ref_id) = 32),
  attempt_id TEXT NOT NULL REFERENCES attempts (attempt_id),
  kind TEXT NOT NULL CHECK (kind IN ('item', 'recipe', 'location', 'calculation')),
  body_json TEXT NOT NULL CHECK (json_valid(body_json))
) STRICT;

CREATE INDEX verified_refs_by_attempt ON verified_refs (attempt_id);

CREATE TABLE history_cursors (
  cursor_id TEXT PRIMARY KEY CHECK (length(cursor_id) = 32),
  character_key TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  history_revision INTEGER NOT NULL,
  last_created_at INTEGER NOT NULL,
  last_entry_id TEXT NOT NULL,
  FOREIGN KEY (character_key, conversation_id) REFERENCES conversations (character_key, conversation_id)
) STRICT;

CREATE TABLE cleared_conversations (
  character_key TEXT NOT NULL REFERENCES characters (character_key),
  conversation_id TEXT NOT NULL,
  replacement_conversation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  cleared_at INTEGER NOT NULL,
  PRIMARY KEY (character_key, conversation_id)
) STRICT;

CREATE TABLE transport_state (
  installation_id TEXT PRIMARY KEY CHECK (length(installation_id) = 32),
  next_publication_revision INTEGER NOT NULL DEFAULT 1 CHECK (next_publication_revision >= 1),
  active_character_key TEXT,
  active_delivery_session_id TEXT
) STRICT;
