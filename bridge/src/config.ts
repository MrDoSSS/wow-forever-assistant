// Installation settings and paths. On Windows the data directory is
// %LOCALAPPDATA%\ForeverAssistant; source files do not contain the user's name.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const BridgeConfig = z.strictObject({
  transport: z.enum(['pixels', 'silent_voice']),
  voicePort: z.int().min(1024).max(65535),
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
  /** Claude Code CLI path; null selects ~\.local\bin\claude.exe or claude.exe on PATH. */
  claudePath: z.string().min(1).nullable(),
  /** Claude model alias or full name; null selects the CLI's default model. */
  claudeModel: z.string().min(1).nullable(),
  /** Claude effort level; null keeps the CLI's default. */
  claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  /** Anthropic API key for the CLI; null uses its login or the ANTHROPIC_API_KEY environment variable. */
  claudeApiKey: z.string().min(1).nullable(),
  /** OpenRouter model ID, for example google/gemini-3.8-flash. */
  openrouterModel: z.string().min(1),
  /** OpenRouter API key; null reads the OPENROUTER_API_KEY environment variable. */
  openrouterApiKey: z.string().min(1).nullable(),
  /** Reasoning effort for models that support it; null keeps the model's default. */
  openrouterReasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).nullable(),
  /** Model-invoked OpenRouter web search, billed per search in addition to tokens. */
  openrouterWebSearch: z.boolean(),
  /**
   * fixed returns a test reply without AI; codex uses Codex and the forever tools;
   * claude uses the Claude Code CLI and openrouter calls an OpenRouter model with the same tools.
   */
  modelAdapter: z.enum(['fixed', 'codex', 'claude', 'openrouter']),
  fixedReplyDelayMs: z.int().min(0).max(3_600_000),
  /** Include question text and game data in logs. */
  logContent: z.boolean(),
});
export type BridgeConfig = z.output<typeof BridgeConfig>;

export const DEFAULT_CONFIG: BridgeConfig = {
  transport: 'pixels',
  voicePort: 19745,
  serverNamespace: null,
  addonsPath: null,
  // Comma-separated client process names: Wow.exe is the local Forever client (observed
  // November 1, 2026); WowB comes from the researched wow-ai setup.
  gameProcessName: 'Wow,WowB',
  codexPath: null,
  codexModel: null,
  claudePath: null,
  claudeModel: null,
  claudeEffort: null,
  claudeApiKey: null,
  openrouterModel: 'google/gemini-3.8-flash',
  openrouterApiKey: null,
  openrouterReasoningEffort: null,
  openrouterWebSearch: true,
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
  /** Chat transcripts of adapters without their own session storage. */
  sessions: string;
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
    sessions: join(dataDir, 'sessions'),
  };
}

/** A missing file selects defaults; an invalid file is a startup error. */
export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const partial = BridgeConfig.partial().parse(raw);
  return BridgeConfig.parse({ ...DEFAULT_CONFIG, ...partial });
}
