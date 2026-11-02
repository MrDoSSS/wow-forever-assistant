// Installation settings and paths. On Windows the data directory is
// %LOCALAPPDATA%\ForeverAssistant; source files do not contain the user's name.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const BridgeConfig = z.strictObject({
  /** Server namespace for characterKey, passed to the addon by the installer. */
  serverNamespace: z.string().min(1).nullable(),
  /** The game client's Interface\AddOns directory. */
  addonsPath: z.string().min(1).nullable(),
  /** Game client process name used for window capture; verify in the game. */
  gameProcessName: z.string().min(1).nullable(),
  /** Codex CLI path; null selects the default installation under %LOCALAPPDATA%. */
  codexPath: z.string().min(1).nullable(),
  /** Codex model; null selects the subscription's default model. */
  codexModel: z.string().min(1).nullable(),
  /** fixed returns a test reply without AI; codex uses Codex and the forever tools. */
  modelAdapter: z.enum(['fixed', 'codex']),
  fixedReplyDelayMs: z.int().min(0).max(3_600_000),
  /** Include question text and game data in logs. */
  logContent: z.boolean(),
});
export type BridgeConfig = z.output<typeof BridgeConfig>;

export const DEFAULT_CONFIG: BridgeConfig = {
  serverNamespace: null,
  addonsPath: null,
  // Comma-separated client process names: Wow.exe is the local Forever client (observed
  // November 1, 2026); WowB comes from the researched wow-ai setup.
  gameProcessName: 'Wow,WowB',
  codexPath: null,
  codexModel: null,
  modelAdapter: 'codex',
  fixedReplyDelayMs: 0,
  logContent: false,
};

export interface DataPaths {
  dataDir: string;
  database: string;
  config: string;
  cache: string;
  backups: string;
  logs: string;
  run: string;
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FOREVER_ASSISTANT_HOME) return env.FOREVER_ASSISTANT_HOME;
  const localAppData = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'ForeverAssistant');
}

export function dataPaths(dataDir: string): DataPaths {
  return {
    dataDir,
    database: join(dataDir, 'assistant.sqlite'),
    config: join(dataDir, 'config.json'),
    cache: join(dataDir, 'cache'),
    backups: join(dataDir, 'backups'),
    logs: join(dataDir, 'logs'),
    run: join(dataDir, 'run'),
  };
}

/** A missing file selects defaults; an invalid file is a startup error. */
export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const partial = BridgeConfig.partial().parse(raw);
  return BridgeConfig.parse({ ...DEFAULT_CONFIG, ...partial });
}
