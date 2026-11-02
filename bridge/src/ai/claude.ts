// Claude Code CLI adapter: `claude -p` with stream-json events, a bridge-chosen session ID
// for resumption, the reply schema as structured output and one forever MCP server.
// --restricted ignores user, project and local settings (hooks, plugins, permissions), the
// only built-in tool is WebSearch, and the system prompt replaces the coding-agent one.
// The init event is checked before the model answers: any other tool or a missing forever
// server stops the attempt. Sessions live under the CLI's projects directory for the fixed
// working directory run/claude. A Job Object host starts the process; the channel token is
// stored in a file.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { TOOL_NAMES } from '../contracts.js';
import type { Diagnostics } from '../diagnostics.js';
import type { ActivePlanBrief } from '../domain/plan.js';
import type { ToolChannelHub } from '../app/tool-channel.js';
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from './adapter.js';
import { ProcessHostError, startHosted, type HostedProcess, type HostOptions } from './process-host.js';
import { buildPrompt, type AccountBrief } from './prompt.js';

const SYSTEM_PROMPT = [
  'You are the in-game assistant for World of Warcraft: Forever. The rules are in the user messages. Use only the forever tools and web search, and end every turn with the structured output.',
  // Claude tends to write item names as plain text and leave the links to the item list under the answer.
  'In the reply text, write every item that has an itemRefId as its [[item:<itemRefId>]] marker in place of the item name: the player hovers and Shift+clicks these links.',
].join('\n');

/**
 * Tools the model may see: the forever MCP tools, the built-in web search and StructuredOutput,
 * which --json-schema adds to return the reply (observed in CLI 2.1.310, November 2, 2026).
 */
const BUILT_IN_TOOLS = ['WebSearch', 'StructuredOutput'];
export const ALLOWED_TOOLS = [...BUILT_IN_TOOLS, ...TOOL_NAMES.map((name) => `mcp__forever__${name}`)];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CLI requires a UUID: keep a stored UUID, derive one from any other stored session ID. */
export function claudeSessionId(stored: string): string {
  if (UUID.test(stored)) return stored.toLowerCase();
  const h = createHash('sha256').update(stored).digest('hex');
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface ClaudeCommand {
  exe: string;
  /** Arguments before the CLI's own, used by the fake Claude in tests. */
  prefixArgs: string[];
}

export interface ClaudeArgsInput {
  sessionId: string;
  resume: boolean;
  /** Reply JSON Schema text. */
  schema: string;
  mcp: { exe: string; script: string; pipe: string; tokenFile: string; attemptId: string };
  model: string | null;
  effort: string | null;
}

/** Pass arguments as an array; the question uses stdin; arguments never contain the token. */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const mcpConfig = {
    mcpServers: {
      forever: { command: input.mcp.exe, args: [input.mcp.script, '--pipe', input.mcp.pipe, '--token-file', input.mcp.tokenFile, '--attempt', input.mcp.attemptId] },
    },
  };
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--restricted',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--tools',
    'WebSearch',
    // forever tools only read bridge data and are approved in advance; anything else is denied.
    '--allowedTools',
    'mcp__forever',
    'WebSearch',
    '--permission-mode',
    'dontAsk',
    '--system-prompt',
    SYSTEM_PROMPT,
    '--json-schema',
    input.schema,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
    ...(input.resume ? ['--resume', input.sessionId] : ['--session-id', input.sessionId]),
  ];
}

/** Observed `claude -p --output-format stream-json` event shapes; ignore unknown events. */
export interface ClaudeEvents {
  sessionId: string | null;
  init: { tools: string[]; forever: string | null } | null;
  result: { isError: boolean; text: string | null; structured: unknown; detail: string; costUsd: number | null; turns: number | null } | null;
  unknownTypes: Set<string>;
}

export function applyClaudeEvent(state: ClaudeEvents, line: string): { init?: true } {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
  const type = String(event.type ?? '');
  switch (type) {
    case 'system': {
      if (event.subtype !== 'init') return {};
      const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
      state.sessionId = typeof event.session_id === 'string' ? event.session_id : state.sessionId;
      state.init = {
        tools: Array.isArray(event.tools) ? event.tools.map(String) : [],
        forever: servers.find((s) => s.name === 'forever')?.status?.toString() ?? null,
      };
      return { init: true };
    }
    case 'result': {
      const text = typeof event.result === 'string' ? event.result : null;
      // An API error still reports subtype "success"; is_error decides.
      const isError = event.is_error === true || (typeof event.subtype === 'string' && event.subtype.startsWith('error'));
      state.result = {
        isError,
        text,
        structured: event.structured_output ?? null,
        detail: [event.subtype, event.api_error_code, event.terminal_reason, text?.slice(0, 300)].filter(Boolean).join(': '),
        costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null,
        turns: typeof event.num_turns === 'number' ? event.num_turns : null,
      };
      return {};
    }
    case 'assistant':
    case 'user':
    case 'stream_event':
    case 'rate_limit_event':
    case 'tool_progress':
      return {};
    default:
      state.unknownTypes.add(type.slice(0, 64));
      return {};
  }
}

/** Why the started CLI breaks the capability boundary, or null when it fits. */
export function boundaryProblem(init: NonNullable<ClaudeEvents['init']>): string | null {
  if (init.forever !== 'connected') return `forever MCP server is ${init.forever ?? 'missing'}`;
  const extra = init.tools.filter((tool) => !ALLOWED_TOOLS.includes(tool));
  if (extra.length > 0) return `unexpected tools: ${extra.slice(0, 10).join(', ')}`;
  const missing = ALLOWED_TOOLS.filter((tool) => !BUILT_IN_TOOLS.includes(tool) && !init.tools.includes(tool));
  return missing.length > 0 ? `missing forever tools: ${missing.join(', ')}` : null;
}

export interface ClaudeAdapterOptions {
  command: ClaudeCommand;
  /** Holds the fixed working directory run/claude and per-attempt token files. */
  runDir: string;
  schemaPath: string;
  mcp: { exe: string; script: string };
  channels: ToolChannelHub;
  diag: Diagnostics;
  model?: string | null;
  effort?: string | null;
  /** Anthropic API key for the CLI; null uses its login or ANTHROPIC_API_KEY. */
  apiKey?: string | null;
  host?: HostOptions;
  /** Each stream-json line for CLI boundary diagnostics. */
  onEvent?: (line: string) => void;
  /** Other player characters for the prompt; null means unavailable. */
  account?: (input: AttemptInput) => AccountBrief;
  /** Player's active plan for the prompt; null means no plan. */
  activePlan?: (input: AttemptInput) => ActivePlanBrief;
}

export class ClaudeAdapter implements ModelAdapter {
  readonly name = 'claude';
  readonly limitations: string[] = [];
  private readonly schema: string;

  constructor(private readonly options: ClaudeAdapterOptions) {
    const { $schema: _schema, title: _title, ...schema } = JSON.parse(readFileSync(options.schemaPath, 'utf8')) as Record<string, unknown>;
    this.schema = JSON.stringify(schema);
  }

  private accountFor(input: AttemptInput): AccountBrief {
    try {
      return this.options.account?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('claude.account_unavailable', { error: String(error) });
      return null;
    }
  }

  private planFor(input: AttemptInput): ActivePlanBrief {
    try {
      return this.options.activePlan?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('claude.plan_unavailable', { error: String(error) });
      return null;
    }
  }

  /** A saved CLI session with this ID in any project directory. */
  private sessionExists(sessionId: string): boolean {
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
    if (!existsSync(projects)) return false;
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, `${sessionId}.jsonl`)));
  }

  async run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult> {
    const { diag, runDir } = this.options;
    const stored = input.modelSession.codexSessionId;
    // A stored ID without a CLI session (another adapter, deleted history) starts the chat over under it.
    const sessionId = stored === null ? randomUUID() : claudeSessionId(stored);
    const resume = stored !== null && this.sessionExists(sessionId);
    const promptInput = resume ? input : { ...input, modelSession: { ...input.modelSession, codexSessionId: null } };

    const workDir = join(runDir, 'claude');
    const tokenFile = join(runDir, `${input.attemptId}.token`);
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
      const args = buildClaudeArgs({
        sessionId,
        resume,
        schema: this.schema,
        mcp: { ...this.options.mcp, pipe: channel.pipeName, tokenFile, attemptId: input.attemptId },
        model: this.options.model ?? null,
        effort: this.options.effort ?? null,
      });
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // lookup_items and plan_craft wait up to 180 s for the addon.
        MCP_TOOL_TIMEOUT: '240000',
        MCP_TIMEOUT: '30000',
        DISABLE_AUTOUPDATER: '1',
        ...(this.options.apiKey ? { ANTHROPIC_API_KEY: this.options.apiKey } : {}),
      };
      const { exe, prefixArgs } = this.options.command;
      try {
        hosted = await startHosted(`Local\\ForeverAssistant-${input.attemptId}`, { exe, args: [...prefixArgs, ...args], cwd: workDir, env }, this.options.host);
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

      const events: ClaudeEvents = { sessionId: null, init: null, result: null, unknownTypes: new Set() };
      let boundary: string | null = null;
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
          if (!applyClaudeEvent(events, line).init || !events.init) continue;
          boundary = boundaryProblem(events.init);
          if (boundary) {
            diag.error('claude.boundary_violation', { attemptId: input.attemptId, detail: boundary });
            void hosted!.stop();
          } else if (stored === null) hooks.sessionStarted(sessionId);
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
      hosted.write(buildPrompt(promptInput, this.accountFor(input), this.planFor(input)));
      hosted.closeStdin();
      const exit = await hosted.exited;
      signal.removeEventListener('abort', onAbort);
      if (pending.trim()) applyClaudeEvent(events, pending.trim());
      if (events.unknownTypes.size > 0) diag.event('claude.unknown_events', { types: [...events.unknownTypes].slice(0, 20) });
      if (events.result) diag.event('claude.usage', { attemptId: input.attemptId, costUsd: events.result.costUsd, turns: events.result.turns, resume });

      const stopConfirmed = exit.activeProcesses === 0 || stopActive === 0;
      if (signal.aborted) return { kind: 'failure', code: 'model_error', detail: 'aborted', stopConfirmed };
      if (!stopConfirmed) {
        return { kind: 'failure', code: 'process_stop_unconfirmed', detail: 'claude process tree did not stop', stopConfirmed: false };
      }
      if (boundary) return { kind: 'failure', code: 'model_profile_unsupported', detail: boundary, stopConfirmed };
      const result = events.result;
      if (!result || result.isError) {
        const detail = result?.detail || `claude exited ${exit.code}: ${stderr.slice(-500)}`;
        diag.warn('claude.no_output', { attemptId: input.attemptId, code: exit.code ?? -1, detail: detail.slice(0, 300) });
        return { kind: 'failure', code: 'model_error', detail, stopConfirmed };
      }
      if (result.structured !== null) return { kind: 'output', output: result.structured, stopConfirmed };
      try {
        return { kind: 'output', output: JSON.parse(result.text ?? ''), stopConfirmed };
      } catch {
        // Not JSON: bridge validation will reject the result and allow one correction attempt.
        return { kind: 'output', output: result.text ?? '', stopConfirmed };
      }
    } finally {
      await this.options.channels.close(input.attemptId);
      rmSync(tokenFile, { force: true });
    }
  }
}

/** Claude CLI path from settings, the native installer location or PATH. */
export function resolveClaudePath(configured: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (configured) return existsSync(configured) ? configured : null;
  const candidates = [join(env.USERPROFILE ?? homedir(), '.local', 'bin', 'claude.exe'), ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'claude.exe'))];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
