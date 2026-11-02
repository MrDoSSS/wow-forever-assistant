import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from '../bridge/src/storage/sqlite.js';
import { describe, it } from 'node:test';
import { sha256Hex } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { prepareDatabase, readSchemaStep, SchemaError, type SchemaStep } from '../bridge/src/storage/migrations.js';
import { FakeClock, tempDir } from './fakes.js';

const baseline = readSchemaStep(3, resourcePath('bridge', 'src', 'storage', 'schema.sql'));
const step = (version: number, sql: string): SchemaStep => ({ version, sql, checksum: sha256Hex(sql) });
const v4 = step(4, `ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
  UPDATE conversations SET pinned = 1;
  CREATE INDEX conversations_pinned ON conversations (pinned);`);
const v5 = step(5, `CREATE TABLE notes (id INTEGER PRIMARY KEY, character_key TEXT NOT NULL REFERENCES characters(character_key), text TEXT NOT NULL) STRICT;
  INSERT INTO notes (character_key, text) SELECT character_key, 'Hello' FROM characters;`);

function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
  return db;
}

function migrate(db: DatabaseSync, dir: string, steps: readonly SchemaStep[]): string | null {
  return prepareDatabase(db, steps, {
    backupDir: join(dir, 'backups'), now: new FakeClock().now(),
    initialize: () => db.prepare('INSERT INTO transport_state (installation_id) VALUES (?)').run('a'.repeat(32)),
  });
}

function seed(dir: string): DatabaseSync {
  const path = join(dir, 'assistant.sqlite');
  const db = connect(path);
  migrate(db, dir, [baseline]);
  db.exec(`INSERT INTO characters (character_key, created_at, last_seen_at) VALUES ('${'c'.repeat(64)}', 1, 1);
    INSERT INTO conversations (character_key, conversation_id, title, created_at, updated_at)
    VALUES ('${'c'.repeat(64)}', '${'d'.repeat(32)}', 'Old conversation', 1, 1);`);
  return db;
}

const history = (db: DatabaseSync) => db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all().map((r) => ({ ...r }));
const schema = (db: DatabaseSync) => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all().map((r) => ({ ...r }));

describe('database migrations', () => {
  it('upgrades an existing v3 through every step, preserves data, verifies a backup and does not repeat steps', () => {
    const dir = tempDir();
    const db = seed(dir);
    try {
      const steps = [baseline, v4, v5];
      const backup = migrate(db, dir, steps);
      assert.ok(backup);
      assert.deepEqual(readdirSync(join(dir, 'backups')), [basename(backup)]);
      const saved = new DatabaseSync(backup, { readOnly: true });
      try {
        assert.equal(saved.prepare('PRAGMA user_version').get()!.user_version, 3);
        assert.equal(saved.prepare('SELECT title FROM conversations').get()!.title, 'Old conversation');
        assert.deepEqual(history(saved), [{ version: 3, checksum: baseline.checksum }]);
      } finally { saved.close(); }
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5);
      assert.deepEqual(history(db), steps.map(({ version, checksum }) => ({ version, checksum })));
      assert.equal(db.prepare('SELECT title, pinned FROM conversations').get()!.pinned, 1);
      assert.equal(db.prepare('SELECT text FROM notes').get()!.text, 'Hello');
      assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
      const id = db.prepare('SELECT installation_id FROM transport_state').get()!.installation_id;
      assert.equal(migrate(db, dir, steps), null);
      assert.equal(db.prepare('SELECT installation_id FROM transport_state').get()!.installation_id, id);

      const freshDir = tempDir();
      const fresh = connect(join(freshDir, 'fresh.sqlite'));
      try {
        assert.equal(migrate(fresh, freshDir, steps), null);
        assert.deepEqual(schema(fresh), schema(db));
        assert.deepEqual(history(fresh), history(db));
        assert.equal(existsSync(join(freshDir, 'backups')), false);
      } finally { fresh.close(); }
    } finally { db.close(); }
    const reopened = connect(join(dir, 'assistant.sqlite'));
    try {
      assert.equal(migrate(reopened, dir, [baseline, v4, v5]), null);
      assert.equal(reopened.prepare('SELECT title FROM conversations').get()!.title, 'Old conversation');
    } finally { reopened.close(); }
  });

  it('continues from an intermediate version and creates distinct backups even with the same clock', () => {
    const dir = tempDir();
    const db = seed(dir);
    try {
      const first = migrate(db, dir, [baseline, v4]);
      const second = migrate(db, dir, [baseline, v4, v5]);
      assert.notEqual(first, second);
      assert.equal(readdirSync(join(dir, 'backups')).length, 2);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5);
    } finally { db.close(); }
  });

  for (const [broken, expected] of [
    [step(5, 'CREATE TABLE transient (id INTEGER); INSERT INTO missing VALUES (1);'), /no such table/],
    [step(5, `INSERT INTO conversations (character_key, conversation_id, title, created_at, updated_at) VALUES ('missing', '${'e'.repeat(32)}', 'bad', 1, 1);`), /foreign key check failed/],
  ] as const) {
    it('rolls back the entire chain on SQL or foreign key failure, and can retry', () => {
      const dir = tempDir();
      const db = seed(dir);
      try {
        const before = schema(db);
        assert.throws(() => migrate(db, dir, [baseline, v4, broken]), expected);
        assert.deepEqual(schema(db), before);
        assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
        assert.deepEqual(history(db), [{ version: 3, checksum: baseline.checksum }]);
        assert.equal(db.prepare('SELECT title FROM conversations').get()!.title, 'Old conversation');
        assert.equal(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
        assert.equal(db.isTransaction, false);
        assert.ok(migrate(db, dir, [baseline, v4, v5]));
      } finally { db.close(); }
    });
  }

  it('rolls back initialization too if a migration fails on a new database', () => {
    const dir = tempDir();
    const db = connect(join(dir, 'new.sqlite'));
    try {
      assert.throws(() => migrate(db, dir, [baseline, step(4, 'INSERT INTO missing VALUES (1)')]));
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n, 0);
      assert.equal(existsSync(join(dir, 'backups')), false);
      migrate(db, dir, [baseline, v4]);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
    } finally { db.close(); }
  });

  it('supports rebuilding a referenced table without losing children or changing their foreign key target', () => {
    const dir = tempDir();
    const db = seed(dir);
    const create = step(4, `CREATE TABLE parents (id INTEGER PRIMARY KEY, name TEXT) STRICT;
      CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id)) STRICT;
      INSERT INTO parents VALUES (1, 'keep'); INSERT INTO children VALUES (1, 1);`);
    const rebuild = step(5, `CREATE TABLE parents_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
      INSERT INTO parents_new SELECT * FROM parents;
      DROP TABLE parents;
      ALTER TABLE parents_new RENAME TO parents;`);
    try {
      migrate(db, dir, [baseline, create, rebuild]);
      assert.equal(db.prepare('SELECT name FROM parents JOIN children ON parents.id = children.parent_id').get()!.name, 'keep');
      assert.equal(db.prepare("PRAGMA foreign_key_list('children')").get()!.table, 'parents');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
  });

  it('refuses migration if the backup cannot be created', () => {
    const dir = tempDir();
    const db = seed(dir);
    writeFileSync(join(dir, 'backups'), 'not a directory');
    try {
      const before = schema(db);
      assert.throws(() => migrate(db, dir, [baseline, v4]));
      assert.deepEqual(schema(db), before);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
    } finally { db.close(); }
  });

  it('checks all applied checksums, missing history rows and unexpected rows before backup or SQL', () => {
    for (const tamper of [
      "UPDATE schema_migrations SET checksum = '" + '0'.repeat(64) + "' WHERE version = 3",
      'DELETE FROM schema_migrations WHERE version = 4',
      "INSERT INTO schema_migrations VALUES (2, '" + '0'.repeat(64) + "', 1)",
    ]) {
      const dir = tempDir();
      const db = seed(dir);
      try {
        migrate(db, dir, [baseline, v4]);
        db.exec(tamper);
        assert.throws(() => migrate(db, dir, [baseline, v4, v5]), SchemaError);
        assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
        assert.equal(readdirSync(join(dir, 'backups')).length, 1);
        assert.throws(() => db.prepare('SELECT * FROM notes'));
      } finally { db.close(); }
    }
  });

  it('rejects edited applied SQL, missing steps and downgrade attempts', () => {
    const dir = tempDir();
    const db = seed(dir);
    try {
      assert.throws(() => migrate(db, dir, [baseline, v5]), SchemaError);
      migrate(db, dir, [baseline, v4]);
      assert.throws(() => migrate(db, dir, [baseline, step(4, `${v4.sql}\n-- edited`)]), SchemaError);
      assert.throws(() => migrate(db, dir, [baseline]), SchemaError);
      assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 4);
    } finally { db.close(); }
  });

  it('normalizes line endings when loading SQL checksums', () => {
    const dir = tempDir();
    const file = join(dir, 'v4.sql');
    writeFileSync(file, 'SELECT 1;\r\n');
    assert.deepEqual(readSchemaStep(4, file), step(4, 'SELECT 1;\n'));
  });
});
