// Bun uses system SQLite on macOS; JSONB requires version >= 3.45.
import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';

if (process.platform === 'darwin') {
  const explicit = process.env.FOREVER_ASSISTANT_SQLITE;
  const library = explicit ?? [
    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
  ].find(existsSync);
  if (library) Database.setCustomSQLite(library);
}

// Bun's compatibility API preserves queries, transactions and the database format.
export { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
