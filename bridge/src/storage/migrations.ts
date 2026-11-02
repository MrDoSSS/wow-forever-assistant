import { DatabaseSync } from './sqlite.js';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomId, sha256Hex } from '../ids.js';

// schema.sql is the baseline. Register subsequent released changes here.
export const BASELINE_VERSION = 4;
export const MIGRATIONS: readonly { version: number; file: string }[] = [];
export const SCHEMA_VERSION = BASELINE_VERSION + MIGRATIONS.length;

export interface SchemaStep {
  version: number;
  sql: string;
  checksum: string;
}

export class SchemaError extends Error {}

export function readSchemaStep(version: number, path: string): SchemaStep {
  const sql = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const checksum = sha256Hex(sql);
  return { version, sql, checksum };
}

export function loadSchemaSteps(schemaPath: string, migrationsDir: string): SchemaStep[] {
  return [
    readSchemaStep(BASELINE_VERSION, schemaPath),
    ...MIGRATIONS.map(({ version, file }) => readSchemaStep(version, join(migrationsDir, file))),
  ];
}

function checkForeignKeys(db: DatabaseSync): void {
  if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new SchemaError('foreign key check failed');
  }
}

function checkHistory(db: DatabaseSync, steps: readonly SchemaStep[], version: number): void {
  const expected = steps.filter((step) => step.version <= version);
  let history;
  try {
    history = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all();
  } catch (cause) {
    throw new SchemaError('cannot read schema migration history', { cause });
  }
  if (history.length !== expected.length || history.some((row, i) =>
    row.version !== expected[i]!.version ||
    row.checksum !== expected[i]!.checksum,
  )) {
    throw new SchemaError('schema migration history or checksum does not match the released SQL');
  }
}

function backupDatabase(db: DatabaseSync, version: number, dir: string, now: number): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const target = join(dir, `assistant-v${version}-${stamp}-${randomId()}.sqlite`);
  const partial = `${target}.partial`;
  try {
    db.prepare('VACUUM INTO ?').run(partial);
    const copy = new DatabaseSync(partial, { readOnly: true });
    try {
      const rows = copy.prepare('PRAGMA quick_check').all();
      if (rows.length !== 1 || rows[0]!.quick_check !== 'ok') throw new SchemaError('backup integrity check failed');
      checkForeignKeys(copy);
    } finally {
      copy.close();
    }
    renameSync(partial, target);
    return target;
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

/** Called before preparing Store statements, with the database exclusively locked. */
export function prepareDatabase(
  db: DatabaseSync,
  steps: readonly SchemaStep[],
  options: { backupDir: string; now: number; initialize: () => void },
): string | null {
  const baseline = steps[0];
  if (!baseline || steps.some((step, i) =>
    !Number.isSafeInteger(step.version) || step.version < 1 || step.version !== baseline.version + i ||
    step.checksum !== sha256Hex(step.sql),
  )) {
    throw new SchemaError('schema steps must have consecutive versions and matching checksums');
  }
  const target = steps.at(-1)!.version;
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  const empty = version === 0 && Number(db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n) === 0;
  if (!empty && (version < baseline.version || version > target)) {
    throw new SchemaError(`database schema version ${version} is not supported (supported ${baseline.version}..${target}); database kept unchanged`);
  }
  if (!empty) checkHistory(db, steps, version);
  const pending = empty ? steps : steps.filter((step) => step.version > version);
  if (pending.length === 0) return null;

  const backup = empty ? null : backupDatabase(db, version, options.backupDir, options.now);
  // SQLite requires disabling foreign keys before BEGIN when rebuilding tables.
  // Migration SQL creates a new table, copies data, drops the old table, then renames the new one.
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const step of pending) {
        db.exec(step.sql);
        if (empty && step === baseline) options.initialize();
        checkForeignKeys(db);
        db.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)')
          .run(step.version, step.checksum, options.now);
        db.exec(`PRAGMA user_version = ${step.version}`);
      }
      checkHistory(db, steps, target);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
  }
  return backup;
}
