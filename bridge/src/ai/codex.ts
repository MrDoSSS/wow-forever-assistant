// Codex CLI adapter: `codex exec --json` with an explicit session ID
// for resumption, structured output and one forever MCP server. User
// config, rules and plugins are excluded; the working directory is an empty run/<attemptId>.
// A Job Object host starts the process; the channel token is stored in a file.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TOOL_NAMES } from '../contracts.js';
import type { Diagnostics } from '../diagnostics.js';
import type { ActivePlanBrief } from '../domain/plan.js';
import type { ToolChannelHub } from '../app/tool-channel.js';
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from './adapter.js';
import { ProcessHostError, startHosted, type HostedProcess, type HostOptions } from './process-host.js';
import { buildPrompt, type AccountBrief } from './prompt.js';

/**
 * Mandatory disabled features: shell, browser and extensions.
 * code_mode_host stays enabled: Codex 0.160.1 invokes all tools, including forever MCP
 * and web search, through its exec tool (user decision on November 1, 2026).
 * Live diagnostics verify this capability boundary.
 */
export const HARD_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'apps',
  'plugins',
  'hooks',
  'code_mode',
];

/** Optional disabled features: warn about unknown names. */
export const SOFT_DISABLED_FEATURES = [
  'multi_agent',
  'multi_agent_v2',
  'view_image',
  'image_generation',
  'memories',
  'skill_search',
  'skill_mcp_dependency_install',
  'goals',
];

export interface CodexCommand {
  exe: string;
  /** Arguments before exec, used by the fake Codex in tests. */
  prefixArgs: string[];
}

export interface FeatureProfile {
  disable: string[];
  missingHard: string[];
  missingSoft: string[];
}

/** Parse `codex features list`: name, stage and enabled state. */
export function parseFeatureList(output: string): Set<string> {
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-z0-9_.]+)\s+\S/.exec(line.trim());
    if (match) names.add(match[1]!);
  }
  return names;
}

export function featureProfile(known: Set<string>): FeatureProfile {
  // Disable code_mode with --disable code_mode even when absent from the stage list.
  const missingHard = HARD_DISABLED_FEATURES.filter((f) => f !== 'code_mode' && !known.has(f));
  const missingSoft = SOFT_DISABLED_FEATURES.filter((f) => !known.has(f));
  const disable = [...HARD_DISABLED_FEATURES, ...SOFT_DISABLED_FEATURES].filter((f) => f === 'code_mode' || known.has(f));
  return { disable, missingHard, missingSoft };
}

const toml = (value: unknown) => JSON.stringify(value);

export interface CodexArgsInput {
  sessionId: string | null;
  schemaPath: string;
  lastMessagePath: string;
  disable: string[];
  mcp: { exe: string; script: string; pipe: string; tokenFile: string; attemptId: string };
  model: string | null;
}

/** Pass arguments as an array; the question uses stdin (`-`); arguments never contain the token. */
export function buildCodexArgs(input: CodexArgsInput): string[] {
  const config = [
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    'web_search="live"',
    // Exclude global skills (~/.agents/skills, CODEX_HOME/skills) from model context;
    // --ignore-user-config alone does not exclude them (verified November 1, 2026).
    'skills.include_instructions=false',
    `mcp_servers.forever.command=${toml(input.mcp.exe)}`,
    `mcp_servers.forever.args=${toml([input.mcp.script, '--pipe', input.mcp.pipe, '--token-file', input.mcp.tokenFile, '--attempt', input.mcp.attemptId])}`,
    'mcp_servers.forever.required=true',
    // With approval_policy="never", Codex rejects MCP calls requiring approval;
    // forever tools only read bridge data and are approved in advance.
    'mcp_servers.forever.default_tools_approval_mode="approve"',
    `mcp_servers.forever.enabled_tools=${toml([...TOOL_NAMES])}`,
    'mcp_servers.forever.tool_timeout_sec=240',
    'mcp_servers.forever.startup_timeout_sec=30',
  ];
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--output-schema',
    input.schemaPath,
    '-o',
    input.lastMessagePath,
    ...config.flatMap((c) => ['-c', c]),
    ...input.disable.flatMap((f) => ['--disable', f]),
    ...(input.model ? ['-m', input.model] : []),
  ];
  return input.sessionId ? ['exec', 'resume', input.sessionId, ...common, '-'] : ['exec', ...common, '-'];
}

/** Observed `codex exec --json` event shapes; ignore unknown events. */
export interface CodexEvents {
  sessionId: string | null;
  lastAgentMessage: string | null;
  failure: string | null;
  unknownTypes: Set<string>;
}

export function applyCodexEvent(state: CodexEvents, line: string): { sessionId?: string } {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
  const type = String(event.type ?? event.msg ?? '');
  switch (type) {
    case 'thread.started':
    case 'session.created': {
      const id = (event.thread_id ?? event.session_id) as string | undefined;
      if (typeof id === 'string' && id) {
        state.sessionId = id;
        return { sessionId: id };
      }
      return {};
    }
    case 'item.completed': {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && (item.type === 'agent_message' || item.item_type === 'assistant_message') && typeof item.text === 'string') {
        state.lastAgentMessage = item.text;
      }
      return {};
    }
    case 'turn.failed': {
      const error = event.error as { message?: string } | undefined;
      state.failure = error?.message ?? 'turn failed';
      return {};
    }
    case 'error':
      state.failure = String(event.message ?? 'codex error');
      return {};
    case 'turn.started':
    case 'turn.completed':
    case 'item.started':
    case 'item.updated':
      return {};
    default:
      state.unknownTypes.add(type.slice(0, 64));
      return {};
  }
}

export interface CodexAdapterOptions {
  command: CodexCommand;
  runDir: string;
  schemaPath: string;
  mcp: { exe: string; script: string };
  channels: ToolChannelHub;
  diag: Diagnostics;
  model?: string | null;
  host?: HostOptions;
  /** Prepared feature profile for tests; otherwise read `codex features list`. */
  profile?: FeatureProfile;
  /** Each JSONL line for Codex boundary diagnostics. */
  onEvent?: (line: string) => void;
  /** Other player characters for the prompt; null means unavailable. */
  account?: (input: AttemptInput) => AccountBrief;
  /** Player's active plan for the prompt; null means no plan. */
  activePlan?: (input: AttemptInput) => ActivePlanBrief;
}

export class CodexAdapter implements ModelAdapter {
  readonly name = 'codex';
  readonly limitations: string[] = [];
  private profile: FeatureProfile | null;

  constructor(private readonly options: CodexAdapterOptions) {
    this.profile = options.profile ?? null;
  }

  /** Profile validation: unknown mandatory disabled features block startup. */
  async prepare(): Promise<FeatureProfile> {
    if (this.profile) return this.profile;
    const { exe, prefixArgs } = this.options.command;
    const { stdout } = await promisify(execFile)(exe, [...prefixArgs, 'features', 'list'], { windowsHide: true, timeout: 30_000 });
    this.profile = featureProfile(parseFeatureList(stdout));
    if (this.profile.missingSoft.length > 0) this.options.diag.warn('codex.soft_features_missing', { features: this.profile.missingSoft });
    return this.profile;
  }

  /** Alt summary for the prompt; read failures omit it without blocking the question. */
  private accountFor(input: AttemptInput): AccountBrief {
    try {
      return this.options.account?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('codex.account_unavailable', { error: String(error) });
      return null;
    }
  }

  private planFor(input: AttemptInput): ActivePlanBrief {
    try {
      return this.options.activePlan?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('codex.plan_unavailable', { error: String(error) });
      return null;
    }
  }

  async run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult> {
    const { diag, runDir } = this.options;
    let profile: FeatureProfile;
    try {
      profile = await this.prepare();
    } catch (error) {
      return { kind: 'failure', code: 'model_profile_unsupported', detail: `codex features list failed: ${String(error)}` };
    }
    if (profile.missingHard.length > 0) {
      return { kind: 'failure', code: 'model_profile_unsupported', detail: `missing hard features: ${profile.missingHard.join(', ')}` };
    }

    const workDir = join(runDir, input.attemptId);
    const tokenFile = join(runDir, `${input.attemptId}.token`);
    const lastMessagePath = join(runDir, `${input.attemptId}.last.json`);
    mkdirSync(workDir, { recursive: true });
    let hosted: HostedProcess | null = null;
    try {
      const channel = await this.options.channels.open({
        attemptId: input.attemptId,
        request: input.request,
        conversationId: input.conversationId,
        datasetId: input.datasetId,
        query: input.query,
      });
      writeFileSync(tokenFile, channel.token, { encoding: 'utf8', mode: 0o600 });
      const args = buildCodexArgs({
        sessionId: input.modelSession.codexSessionId,
        schemaPath: this.options.schemaPath,
        lastMessagePath,
        disable: profile.disable,
        mcp: { ...this.options.mcp, pipe: channel.pipeName, tokenFile, attemptId: input.attemptId },
        model: this.options.model ?? null,
      });
      const { exe, prefixArgs } = this.options.command;
      try {
        hosted = await startHosted(`Local\\ForeverAssistant-${input.attemptId}`, { exe, args: [...prefixArgs, ...args], cwd: workDir }, this.options.host);
      } catch (error) {
        const detail = error instanceof ProcessHostError ? error.detail : String(error);
        return { kind: 'failure', code: 'process_host_unavailable', detail };
      }
      hooks.processStarted?.({
        jobName: hosted.info.jobName,
        hostPid: hosted.info.hostPid,
        hostCreatedAt: hosted.info.hostCreatedAt,
        childPid: hosted.info.pid,
        childCreatedAt: hosted.info.createdAt,
      });

      const events: CodexEvents = { sessionId: null, lastAgentMessage: null, failure: null, unknownTypes: new Set() };
      let pending = '';
      let stderr = '';
      hosted.onStdout((chunk) => {
        pending += chunk.toString('utf8');
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line) continue;
          this.options.onEvent?.(line);
          const update = applyCodexEvent(events, line);
          if (update.sessionId) hooks.sessionStarted(update.sessionId);
        }
      });
      hosted.onStderr((chunk) => (stderr = (stderr + chunk.toString('utf8')).slice(-4000)));

      let stopActive: number | null | undefined;
      const onAbort = () => {
        void hosted!.stop().then((active) => (stopActive = active));
      };
      signal.addEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
      hooks.phase('generating');
      hosted.resume();
      hosted.write(buildPrompt(input, this.accountFor(input), this.planFor(input)));
      hosted.closeStdin();
      const exit = await hosted.exited;
      signal.removeEventListener('abort', onAbort);
      if (pending.trim()) applyCodexEvent(events, pending.trim());
      if (events.unknownTypes.size > 0) diag.event('codex.unknown_events', { types: [...events.unknownTypes].slice(0, 20) });

      const stopConfirmed = exit.activeProcesses === 0 || stopActive === 0;
      if (signal.aborted) {
        return { kind: 'failure', code: 'model_error', detail: 'aborted', stopConfirmed };
      }
      if (!stopConfirmed) {
        return { kind: 'failure', code: 'process_stop_unconfirmed', detail: 'codex process tree did not stop', stopConfirmed: false };
      }
      const text = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, 'utf8') : events.lastAgentMessage;
      if (text === null || text.trim() === '') {
        const detail = events.failure ?? `codex exited ${exit.code}: ${stderr.slice(-500)}`;
        diag.warn('codex.no_output', { attemptId: input.attemptId, code: exit.code ?? -1, detail: detail.slice(0, 300) });
        return { kind: 'failure', code: 'model_error', detail, stopConfirmed };
      }
      try {
        return { kind: 'output', output: JSON.parse(text), stopConfirmed };
      } catch {
        // Not JSON: bridge validation will reject the result and allow one correction attempt.
        return { kind: 'output', output: text, stopConfirmed };
      }
    } finally {
      await this.options.channels.close(input.attemptId);
      for (const path of [tokenFile, lastMessagePath]) rmSync(path, { force: true });
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

export interface CanaryReport {
  bytes: number;
  skills: boolean;
  agentsMd: boolean;
  multiAgentRole: boolean;
}

/**
 * Instruction canary without calling the model: `codex debug prompt-input`
 * with our settings and disabled features shows the model's input.
 */
export async function promptCanary(command: CodexCommand, disable: string[], cwd: string): Promise<CanaryReport> {
  const config = buildCodexArgs({
    sessionId: null,
    schemaPath: '',
    lastMessagePath: '',
    disable,
    mcp: { exe: process.execPath, script: 'mcp.js', pipe: 'pipe', tokenFile: 'token', attemptId: 'canary' },
    model: null,
  }).flatMap((arg, i, all) => (all[i - 1] === '-c' && !arg.startsWith('mcp_servers.') ? ['-c', arg] : []));
  // MCP does not change instructions, but rendering would try to start a required server.
  const args = [...command.prefixArgs, 'debug', 'prompt-input', ...config, ...disable.flatMap((f) => ['--disable', f]), 'canary'];
  const { stdout } = await promisify(execFile)(command.exe, args, { cwd, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return {
    bytes: stdout.length,
    skills: stdout.includes('skills_instructions'),
    agentsMd: /AGENTS\.md instructions|<user_instructions>/.test(stdout),
    multiAgentRole: stdout.includes('multi_agent_role'),
  };
}

/** Codex CLI path from settings or the default installation under %LOCALAPPDATA%. */
export function resolveCodexPath(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const candidate = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe') : null;
  return candidate && existsSync(candidate) ? candidate : null;
}
