import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from '../bridge/src/storage/sqlite.js';
import { describe, it } from 'node:test';
import { randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { BASELINE_VERSION } from '../bridge/src/storage/migrations.js';
import { SCHEMA_VERSION, Store, StoreError } from '../bridge/src/storage/store.js';
import { FakeClock, tempDir } from './fakes.js';

function open(path: string, extra: Partial<Parameters<typeof Store.open>[0]> = {}): Store {
  return Store.open({ path, clock: new FakeClock(), ...extra });
}

function storeError(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof StoreError, `expected StoreError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected StoreError');
}

describe('schema', () => {
  it('creates a missing database with migrations, user_version and transport state', () => {
    const path = join(tempDir(), 'assistant.sqlite');
    const store = open(path);
    assert.deepEqual(store.rawQuery('PRAGMA user_version'), [{ user_version: SCHEMA_VERSION }]);
    const migrations = store.rawQuery<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    assert.equal(migrations.length, SCHEMA_VERSION - BASELINE_VERSION + 1);
    assert.equal(migrations.at(-1)!.version, SCHEMA_VERSION);
    assert.match(store.getTransportState().installation_id, /^[0-9a-f]{32}$/);
    assert.equal(store.getTransportState().next_publication_revision, 1);
    assert.deepEqual(store.rawQuery('PRAGMA journal_mode'), [{ journal_mode: 'wal' }]);
    assert.deepEqual(store.integrityCheck(), { quickCheck: 'ok', foreignKeyViolations: 0 });
    const installationId = store.getTransportState().installation_id;
    store.close();
    const reopened = open(path);
    assert.equal(reopened.getTransportState().installation_id, installationId);
    reopened.close();
  });

  it('rejects a second bridge instance while the database is open', () => {
    const path = join(tempDir(), 'assistant.sqlite');
    const first = open(path);
    assert.equal(storeError(() => open(path)).code, 'locked');
    first.close();
    open(path).close();
  });

  it('does not open a non-empty database without schema version', () => {
    const path = join(tempDir(), 'foreign.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE something (id INTEGER)');
    db.close();
    assert.equal(storeError(() => open(path)).code, 'schema_rejected');
  });

  it('does not open a newer schema or a different checksum', () => {
    const newer = join(tempDir(), 'assistant.sqlite');
    open(newer).close();
    const db = new DatabaseSync(newer);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    assert.equal(storeError(() => open(newer)).code, 'schema_rejected');

    const dir = tempDir();
    const path = join(dir, 'assistant.sqlite');
    open(path).close();
    const changed = join(dir, 'schema.sql');
    writeFileSync(changed, `${readFileSync(resourcePath('bridge', 'src', 'storage', 'schema.sql'), 'utf8')}\n-- changed\n`);
    assert.equal(storeError(() => open(path, { schemaPath: changed })).code, 'schema_rejected');
  });

  for (const version of [1, 2, 3]) {
    it(`rejects unsupported v${version} without replacing the database`, () => {
      const path = join(tempDir(), 'assistant.sqlite');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE preserved (value TEXT); INSERT INTO preserved VALUES ('keep'); PRAGMA user_version = ${version}`);
      old.close();
      assert.equal(storeError(() => open(path)).code, 'schema_rejected');
      const saved = new DatabaseSync(path);
      assert.equal(saved.prepare('PRAGMA user_version').get()!.user_version, version);
      assert.equal(saved.prepare('SELECT value FROM preserved').get()!.value, 'keep');
      saved.close();
    });
  }

});

describe('JSONB documents', () => {
  function seed(store: Store) {
    const key = { characterKey: 'c'.repeat(64), originSessionId: randomId(), requestId: 5 };
    store.transaction('seed', () => store.ensureCharacter(key.characterKey, 1));
    return key;
  }

  it('round-trips Cyrillic, arrays and null through jsonb()', () => {
    const store = open(join(tempDir(), 'a.sqlite'));
    const key = seed(store);
    const json = JSON.stringify({ \u0438\u043c\u044f: '\u0422\u0435\u0441\u0442\u0435\u0440', \u0441\u043f\u0438\u0441\u043e\u043a: [1, null, '\u0451'], \u043f\u0443\u0441\u0442\u043e: null });
    store.transaction('snapshot', () => store.insertSnapshot(key, json, 'f'.repeat(64), 2));
    assert.equal(store.getSnapshotJson(key), json);
    const blob = store.rawQuery<{ t: string }>('SELECT typeof(body_jsonb) AS t FROM snapshots');
    assert.deepEqual(blob, [{ t: 'blob' }]);
  });

  it('rejects text JSON, a corrupted blob and SQL NULL in body_jsonb', () => {
    const store = open(join(tempDir(), 'a.sqlite'));
    const key = seed(store);
    const insert = (value: string) =>
      store.rawExec(
        `INSERT INTO snapshots (character_key, origin_session_id, snapshot_id, body_jsonb, body_sha256, created_at)
         VALUES ('${key.characterKey}', '${key.originSessionId}', 9, ${value}, '${'f'.repeat(64)}', 1)`,
      );
    assert.throws(() => insert(`'{"a":1}'`));
    assert.throws(() => insert(`x'010203'`));
    assert.throws(() => insert('NULL'));
  });
});

describe('transactions and constraints', () => {
  it('rolls back on error and on an injected crash before COMMIT', () => {
    let crash = false;
    const store = open(join(tempDir(), 'a.sqlite'), {
      faults: {
        beforeCommit: () => {
          if (crash) throw new Error('crash');
        },
      },
    });
    assert.throws(() =>
      store.transaction('t', () => {
        store.ensureCharacter('a'.repeat(64), 1);
        throw new Error('boom');
      }),
    );
    crash = true;
    assert.throws(() => store.transaction('t', () => store.ensureCharacter('b'.repeat(64), 1)));
    crash = false;
    assert.equal(store.getCharacter('a'.repeat(64)), undefined);
    assert.equal(store.getCharacter('b'.repeat(64)), undefined);
  });

  it('allows one active request per character', () => {
    const store = open(join(tempDir(), 'a.sqlite'));
    const ck = 'd'.repeat(64);
    const conversationId = randomId();
    const origin = randomId();
    const accept = (requestId: number) =>
      store.transaction('accept', () => {
        const raw = new TextEncoder().encode(`{"n":${requestId}}`);
        store.insertReceived({
          character_key: ck,
          origin_session_id: origin,
          message_sequence: requestId,
          kind: 2,
          conversation_id: conversationId,
          raw_body: raw,
          body_sha256: 'e'.repeat(64),
          outcome: 'applied',
          accepted_at: 1,
        });
        const key = { characterKey: ck, originSessionId: origin, requestId };
        store.insertSnapshot(key, '{}', 'f'.repeat(64), 1);
        store.insertAcceptedRequest(key, { conversationId, rawBody: raw, sha256: 'e'.repeat(64) }, 1);
      });
    store.transaction('seed', () => {
      store.ensureCharacter(ck, 1);
      store.insertConversation({ character_key: ck, conversation_id: conversationId, title: 't', created_at: 1, updated_at: 1, history_revision: 0 });
    });
    accept(1);
    assert.throws(() => accept(2), /UNIQUE/);
    store.transaction('finish', () => store.finishRequest({ characterKey: ck, originSessionId: origin, requestId: 1 }, 'completed', 2, null));
    accept(2);
    assert.equal(store.getActiveRequest(ck)?.request_id, 2);
  });

  it('allocates publication revisions that survive reopening', () => {
    const path = join(tempDir(), 'a.sqlite');
    const store = open(path);
    assert.equal(store.transaction('rev', () => store.allocatePublicationRevision()), 1);
    assert.equal(store.transaction('rev', () => store.allocatePublicationRevision()), 2);
    store.close();
    const reopened = open(path);
    assert.equal(reopened.transaction('rev', () => reopened.allocatePublicationRevision()), 3);
    reopened.close();
  });
});
