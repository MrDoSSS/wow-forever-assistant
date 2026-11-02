// Account characters (alts) from addon SavedVariables: each character writes its
// state to ForeverAssistantDB.alts (Collectors/Alts.lua); the client saves the file
// on logout and /reload. While another character is active, saved alt data remains
// unchanged, so the file holds the last saved state. Do not execute Lua: reuse
// the shared bounded literal parser. The current character comes from
// the question snapshot (tool-channel.ts); the file adds its bank, mail and recipes.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ID, Identity, N, S, S0, type Identity as IdentityType } from '../contracts.js';
import { characterKeyOf } from '../ids.js';
import { LuaDataError, parseSavedVariables, type LiteralValue } from './shared/lua.js';

export const SAVED_VARIABLES_FILE = 'ForeverAssistant.lua';
export const SAVED_VARIABLES_NAME = 'ForeverAssistantDB';
const MAX_FILE_BYTES = 32 * 1024 * 1024;

const Counts = z.array(z.object({ itemId: ID, count: z.int().min(1).max(2147483647) })).max(4096);
const At = { observedAt: N };

const SECTIONS = {
  summary: z.object({
    ...At,
    classToken: S,
    raceToken: S0,
    faction: z.enum(['alliance', 'horde', 'neutral', 'unknown']),
    level: ID,
    moneyCopper: N.optional(),
    zoneName: S0.optional(),
    /** uiMapID of the zone; zoneName is in the client's language. Older saves lack it. */
    mapId: ID.optional(),
    fullName: S0.optional(),
  }),
  equipment: z.object({ ...At, items: z.array(z.object({ slot: z.int().min(1).max(19), itemId: ID })).max(19) }),
  professions: z.object({
    ...At,
    list: z.array(z.object({ skillId: ID, name: S, rank: N, maxRank: N })).max(100),
  }),
  recipes: z.array(z.object({ skillId: ID, observedAt: N, spellIds: z.array(ID).max(4096) })).max(20),
  bags: z.object({ ...At, items: Counts }),
  bank: z.object({ ...At, items: Counts }),
  mail: z.object({ ...At, items: Counts }),
};

type Sections = { [K in keyof typeof SECTIONS]: z.output<(typeof SECTIONS)[K]> | null };
export type AltSectionName = keyof typeof SECTIONS;
export const ALT_SECTIONS = Object.keys(SECTIONS) as AltSectionName[];

export interface AltRecord extends Sections {
  characterKey: string;
  identity: IdentityType;
  /** File modification time in UTC ms: data cannot be newer than this save. */
  savedAt: number;
}

export interface AltsLoad {
  records: AltRecord[];
  limitations: string[];
}

interface Cached {
  mtimeMs: number;
  size: number;
  records: AltRecord[];
  limitations: string[];
}

function isObject(value: LiteralValue | undefined): value is { [key: string]: LiteralValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ForeverAssistantDB.alts records from one file; skip unverified identities and invalid sections. */
export function altRecordsOf(db: LiteralValue | undefined, savedAt: number): { records: AltRecord[]; limitations: string[] } {
  const records: AltRecord[] = [];
  const limitations: string[] = [];
  const alts = isObject(db) ? db.alts : undefined;
  if (!isObject(alts)) return { records, limitations };
  for (const [characterKey, raw] of Object.entries(alts)) {
    if (!isObject(raw) || raw.version !== 1) {
      limitations.push(`alt_skipped: ${characterKey.slice(0, 8)} has an unknown record format`);
      continue;
    }
    const identity = Identity.safeParse(raw.identity);
    if (!identity.success || characterKeyOf(identity.data) !== characterKey) {
      limitations.push(`alt_skipped: ${characterKey.slice(0, 8)} has no matching identity`);
      continue;
    }
    const record = { characterKey, identity: identity.data, savedAt } as AltRecord;
    for (const name of ALT_SECTIONS) {
      if (raw[name] === undefined) {
        (record as unknown as Record<string, unknown>)[name] = null;
        continue;
      }
      const parsed = SECTIONS[name].safeParse(raw[name]);
      (record as unknown as Record<string, unknown>)[name] = parsed.success ? parsed.data : null;
      if (!parsed.success) limitations.push(`alt_section_skipped: ${identity.data.displayName} ${name} is malformed`);
    }
    records.push(record);
  }
  return { records, limitations };
}

/** SavedVariables from every account next to AddOns: <WoW>\WTF\Account\*\SavedVariables. */
export function savedVariablesFiles(addonsPath: string): string[] {
  const accounts = resolve(addonsPath, '..', '..', 'WTF', 'Account');
  if (!existsSync(accounts)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(accounts, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(accounts, entry.name, 'SavedVariables', SAVED_VARIABLES_FILE);
    if (existsSync(file)) files.push(file);
  }
  return files.sort();
}

export class AltsSource {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly addonsPath: string | null) {}

  get configured(): boolean {
    return this.addonsPath !== null;
  }

  /** All characters from every file; reread only changed files. */
  load(): AltsLoad {
    if (!this.addonsPath) return { records: [], limitations: ['alts_unavailable: addonsPath is not configured'] };
    const byKey = new Map<string, AltRecord>();
    const limitations: string[] = [];
    for (const file of savedVariablesFiles(this.addonsPath)) {
      const loaded = this.loadFile(file);
      limitations.push(...loaded.limitations);
      for (const record of loaded.records) {
        // If a character appears in two accounts, use the later save.
        const existing = byKey.get(record.characterKey);
        if (!existing || existing.savedAt < record.savedAt) byKey.set(record.characterKey, record);
      }
    }
    return { records: [...byKey.values()], limitations };
  }

  private loadFile(file: string): Cached {
    const stat = statSync(file);
    const cached = this.cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
    let result: Cached;
    if (stat.size > MAX_FILE_BYTES) {
      result = { mtimeMs: stat.mtimeMs, size: stat.size, records: [], limitations: [`alts_file_too_large: ${stat.size} bytes`] };
    } else {
      try {
        const { values } = parseSavedVariables(new Uint8Array(readFileSync(file)), [SAVED_VARIABLES_NAME]);
        result = { mtimeMs: stat.mtimeMs, size: stat.size, ...altRecordsOf(values[SAVED_VARIABLES_NAME], Math.round(stat.mtimeMs)) };
      } catch (error) {
        const code = error instanceof LuaDataError ? error.code : 'read_error';
        result = { mtimeMs: stat.mtimeMs, size: stat.size, records: [], limitations: [`alts_file_unreadable: ${code}`] };
      }
    }
    this.cache.set(file, result);
    return result;
  }
}
