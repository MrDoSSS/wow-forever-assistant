// Resolve shipped resources (schema.sql, fixtures, schemas, addon) from the package root,
// not the process's current directory.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'bridge'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package root not found');
    dir = parent;
  }
}

export function resourcePath(...segments: string[]): string {
  return join(packageRoot(), ...segments);
}
