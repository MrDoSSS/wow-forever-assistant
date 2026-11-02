// OpenRouter adapter: Chat Completions with the forever tools as functions that the bridge
// runs in process through the attempt tool channel, optional model-invoked web search and
// the reply schema as structured output. Many providers treat the schema only as a hint, so
// the schema is also in the system message and a final message that breaks it gets one repair
// round inside the attempt. OpenRouter keeps no session: a local transcript holds the chat's
// earlier questions and answers and the full messages of the latest attempt, so a correction
// keeps its tool results. Every new question carries the full rules.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ModelReply, TOOL_DESCRIPTIONS, TOOL_NAMES, ToolArgs, type RequestKey, type ToolName } from '../contracts.js';
import type { Diagnostics } from '../diagnostics.js';
import type { ActivePlanBrief } from '../domain/plan.js';
import { describeIssues } from '../domain/reply.js';
import type { ToolChannelHub } from '../app/tool-channel.js';
import { randomId, sha256Hex } from '../ids.js';
import type { AdapterResult, AttemptHooks, AttemptInput, ModelAdapter } from './adapter.js';
import { buildPrompt, correctionPrompt, type AccountBrief } from './prompt.js';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Model requests per attempt; the last one cannot call tools and must answer. */
const MAX_ROUNDS = 20;
/** After this time the model cannot call more tools and answers with what it has. */
const ANSWER_AFTER_MS = 180_000;
const ANSWER_NOW =
  'No more tool calls are possible for this question. Answer now with what the tool results show and name what is still unknown in limitations.';
/** Earlier questions and answers kept in a transcript, two messages each. */
const HISTORY_MESSAGES = 40;
/** One request including its body. */
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 5_000];
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'user'; content: string }
  // reasoning_details goes back unchanged: Gemini and Anthropic need it to continue after tool results.
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Transcript {
  version: 1;
  /** Earlier questions of the chat with their final answers, oldest first. */
  history: ChatMessage[];
  /** All messages of the latest attempt, for a correction of the same question. */
  last: { request: RequestKey; messages: ChatMessage[] } | null;
}

interface Completion {
  /** Provider that served the request. */
  provider?: string;
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number;
    server_tool_use?: { web_search_requests?: number };
    server_tool_use_details?: { web_search_requests?: number };
  };
  error?: { code?: number | string; message?: string };
}

type Failure = Extract<AdapterResult, { kind: 'failure' }>;

/** The forever tools as functions, plus OpenRouter's server-side web search when enabled. */
export function toolDefinitions(webSearch: boolean): object[] {
  const functions = TOOL_NAMES.map((name) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(ToolArgs[name], { io: 'input' });
    return { type: 'function', function: { name, description: TOOL_DESCRIPTIONS[name], parameters } };
  });
  return webSearch ? [...functions, { type: 'openrouter:web_search', parameters: { max_results: 5 } }] : functions;
}

/** Final message as JSON; a code fence or text around the object is tolerated. */
export function parseReply(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  for (const candidate of [trimmed, start >= 0 && end > start ? trimmed.slice(start, end + 1) : null]) {
    if (candidate === null) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  // Not JSON: bridge validation will reject the result and allow one correction attempt.
  return text;
}

/** Why a final message breaks the reply schema, or null when it fits. */
export function replyProblem(text: string): string | null {
  const output = parseReply(text);
  if (typeof output === 'string') return 'the final message is not a JSON object';
  const parsed = ModelReply.safeParse(output);
  return parsed.success ? null : `schema: ${describeIssues(parsed.error)}`;
}

const earlierQuestion = (text: string) =>
  ['Earlier question in this chat; its snapshot, tool results and IDs are no longer available:', '<question>', text, '</question>'].join('\n');

const sameRequest = (a: RequestKey, b: RequestKey) =>
  a.characterKey === b.characterKey && a.originSessionId === b.originSessionId && a.requestId === b.requestId;

/** Tool name and arguments without formatting differences. */
function callKey(call: ToolCall): string {
  let args = call.function?.arguments ?? '';
  try {
    args = JSON.stringify(JSON.parse(args || '{}'));
  } catch {
    // Invalid JSON keeps its text; the tool call reports it.
  }
  return `${String(call.function?.name)}\u0000${args}`;
}

/** An earlier result returned again for a repeated call, without running the tool. */
function repeatedResult(result: unknown): unknown {
  const note = 'duplicate_call: the same tool was already called with the same arguments for this question; this is that result';
  const body = result as { limitations?: unknown };
  return Array.isArray(body.limitations) ? { ...body, limitations: [...(body.limitations as string[]), note] } : result;
}

export interface OpenRouterAdapterOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: string | null;
  webSearch?: boolean;
  schemaPath: string;
  /** Transcript files, one per model session. */
  sessionsDir: string;
  channels: ToolChannelHub;
  diag: Diagnostics;
  /** Other player characters for the prompt; null means unavailable. */
  account?: (input: AttemptInput) => AccountBrief;
  /** Player's active plan for the prompt; null means no plan. */
  activePlan?: (input: AttemptInput) => ActivePlanBrief;
  /** HTTP client and endpoint for tests. */
  fetch?: typeof fetch;
  url?: string;
}

export class OpenRouterAdapter implements ModelAdapter {
  readonly name = 'openrouter';
  readonly limitations: string[];
  private readonly tools: object[];
  private readonly replySchema: unknown;
  /** System message with the reply schema, sent with every request but not kept in transcripts. */
  private readonly outputContract: string;

  constructor(private readonly options: OpenRouterAdapterOptions) {
    const webSearch = options.webSearch ?? true;
    this.limitations = webSearch ? [] : ['Web search is off: answers use only the game references and the client.'];
    this.tools = toolDefinitions(webSearch);
    const { $schema: _schema, title: _title, ...schema } = JSON.parse(readFileSync(options.schemaPath, 'utf8')) as Record<string, unknown>;
    this.replySchema = schema;
    this.outputContract = [
      'Output schema: the final message is exactly one JSON object and nothing else, without a code fence or text around it.',
      'It matches this JSON Schema: every property is required (null or [] when nothing applies) and no other property is allowed.',
      JSON.stringify(schema),
    ].join('\n');
  }

  private accountFor(input: AttemptInput): AccountBrief {
    try {
      return this.options.account?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('openrouter.account_unavailable', { error: String(error) });
      return null;
    }
  }

  private planFor(input: AttemptInput): ActivePlanBrief {
    try {
      return this.options.activePlan?.(input) ?? null;
    } catch (error) {
      this.options.diag.warn('openrouter.plan_unavailable', { error: String(error) });
      return null;
    }
  }

  async run(input: AttemptInput, hooks: AttemptHooks, signal: AbortSignal): Promise<AdapterResult> {
    // The stored session ID names the transcript; a missing file starts the chat over under it.
    const sessionId = input.modelSession.codexSessionId ?? randomId();
    const path = this.transcriptPath(sessionId);
    const transcript = this.load(path);
    const last = transcript.last;
    let history = transcript.history;
    let messages: ChatMessage[];
    if (input.correction && last && sameRequest(last.request, input.request)) {
      // Keep the rejected attempt with its tool results; its answer is replaced in the history.
      history = history.slice(0, -2);
      messages = [...last.messages, { role: 'user', content: correctionPrompt(input.correction.reason) }];
    } else {
      const fresh = { ...input, modelSession: { ...input.modelSession, codexSessionId: null } };
      messages = [...history, { role: 'user', content: buildPrompt(fresh, this.accountFor(input), this.planFor(input)) }];
    }

    this.options.channels.attach({
      attemptId: input.attemptId,
      request: input.request,
      conversationId: input.conversationId,
      datasetId: input.datasetId,
      query: input.query,
    });
    try {
      hooks.phase('generating');
      const outcome = await this.converse(input.attemptId, messages, signal);
      if (signal.aborted) return { kind: 'failure', code: 'model_error', detail: 'aborted' };
      if (outcome.kind === 'failure') {
        this.options.diag.warn('openrouter.failed', { attemptId: input.attemptId, detail: outcome.detail.slice(0, 500) });
        return outcome;
      }
      const answered: ChatMessage[] = [{ role: 'user', content: earlierQuestion(input.query.text) }, { role: 'assistant', content: outcome.text }];
      this.save(path, {
        version: 1,
        history: [...history, ...answered].slice(-HISTORY_MESSAGES),
        last: { request: input.request, messages },
      });
      if (input.modelSession.codexSessionId === null) hooks.sessionStarted(sessionId);
      return { kind: 'output', output: parseReply(outcome.text) };
    } finally {
      await this.options.channels.close(input.attemptId);
    }
  }

  /**
   * Tool loop: call the model, run its tool calls, repeat until a final message. A final
   * message that breaks the schema gets one repair round, so the bridge correction stays
   * for reference errors. After MAX_ROUNDS or ANSWER_AFTER_MS the model must answer.
   */
  private async converse(attemptId: string, messages: ChatMessage[], signal: AbortSignal): Promise<{ kind: 'text'; text: string } | Failure> {
    const usage = { rounds: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, webSearches: 0, repairs: 0, repeatedCalls: 0 };
    const providers = new Set<string>();
    const results = new Map<string, unknown>();
    const answerBy = performance.now() + ANSWER_AFTER_MS;
    let told = false;
    try {
      for (let round = 1; ; round++) {
        const answerNow = round >= MAX_ROUNDS || performance.now() >= answerBy;
        if (answerNow && !told) {
          // tool_choice "none" alone does not stop every model from trying more tools.
          told = true;
          messages.push({ role: 'user', content: ANSWER_NOW });
        }
        const started = performance.now();
        const response = await this.complete(messages, answerNow, signal);
        this.options.diag.event('openrouter.round', {
          attemptId,
          round,
          answerNow,
          provider: response.provider ?? null,
          ms: Math.round(performance.now() - started),
          finishReason: response.choices?.[0]?.finish_reason ?? null,
          toolCalls: answerNow ? [] : (response.choices?.[0]?.message?.tool_calls ?? []).map((c) => String(c.function?.name).slice(0, 64)),
          completionTokens: response.usage?.completion_tokens ?? null,
          reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? null,
        });
        if (response.provider) providers.add(response.provider);
        usage.rounds = round;
        usage.promptTokens += response.usage?.prompt_tokens ?? 0;
        usage.completionTokens += response.usage?.completion_tokens ?? 0;
        usage.costUsd += response.usage?.cost ?? 0;
        usage.webSearches += response.usage?.server_tool_use_details?.web_search_requests ?? response.usage?.server_tool_use?.web_search_requests ?? 0;
        const choice = response.choices?.[0];
        const message = choice?.message;
        if (!message) return { kind: 'failure', code: 'model_error', detail: `no message in the response: ${response.error?.message ?? 'empty'}` };
        const calls = answerNow ? [] : (message.tool_calls ?? []);
        messages.push({
          role: 'assistant',
          content: message.content ?? null,
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
          ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
        });
        if (calls.length === 0) {
          const text = message.content?.trim() ?? '';
          if (text === '') return { kind: 'failure', code: 'model_error', detail: `empty final message, finish_reason ${choice?.finish_reason ?? 'unknown'}` };
          const problem = usage.repairs === 0 ? replyProblem(text) : null;
          if (problem === null) return { kind: 'text', text };
          usage.repairs++;
          messages.push({ role: 'user', content: correctionPrompt(problem) });
          continue;
        }
        for (const call of calls) {
          const started = performance.now();
          const key = callKey(call);
          const earlier = results.get(key);
          let result: unknown;
          if (earlier !== undefined) {
            usage.repeatedCalls++;
            result = repeatedResult(earlier);
          } else {
            result = await this.tool(attemptId, call);
            results.set(key, result);
          }
          this.options.diag.event('openrouter.tool', {
            attemptId,
            tool: String(call.function?.name).slice(0, 64),
            status: earlier !== undefined ? 'repeated' : String((result as { status?: unknown }).status ?? 'unknown'),
            ms: Math.round(performance.now() - started),
          });
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
    } catch (error) {
      return { kind: 'failure', code: 'model_error', detail: signal.aborted ? 'aborted' : String(error) };
    } finally {
      this.options.diag.event('openrouter.usage', { attemptId, model: this.options.model, providers: [...providers], ...usage });
    }
  }

  private async tool(attemptId: string, call: ToolCall): Promise<unknown> {
    const name = call.function?.name;
    if (!(TOOL_NAMES as readonly string[]).includes(name)) return { status: 'error', limitations: [`unknown_tool: ${String(name).slice(0, 64)}`] };
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return { status: 'error', limitations: ['invalid_arguments: the arguments are not JSON'] };
    }
    return this.options.channels.call(attemptId, name as ToolName, args);
  }

  /** One Chat Completions request; retries rate limits, server errors and dropped connections. */
  private async complete(messages: ChatMessage[], answerNow: boolean, signal: AbortSignal): Promise<Completion> {
    const effort = this.options.reasoningEffort ?? null;
    const body = JSON.stringify({
      model: this.options.model,
      messages: [{ role: 'system', content: this.outputContract }, ...messages],
      tools: this.tools,
      tool_choice: answerNow ? 'none' : 'auto',
      response_format: { type: 'json_schema', json_schema: { name: 'model_reply', strict: true, schema: this.replySchema } },
      ...(effort ? { reasoning: { effort } } : {}),
      // Route only to providers that accept every parameter above, including tools and the schema.
      provider: { require_parameters: true },
    });
    const fetchImpl = this.options.fetch ?? fetch;
    for (let retry = 0; ; retry++) {
      const wait = RETRY_DELAYS_MS[retry];
      let response: Response;
      try {
        response = await fetchImpl(this.options.url ?? OPENROUTER_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json', 'X-Title': 'WoW Forever Assistant' },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (error) {
        if (signal.aborted || wait === undefined || (error as Error).name === 'TimeoutError') throw error;
        await delay(wait, undefined, { signal });
        continue;
      }
      if (response.ok) {
        const completion = (await response.json()) as Completion;
        if (completion.error) throw new Error(`OpenRouter error ${completion.error.code ?? ''}: ${completion.error.message ?? 'unknown'}`);
        return completion;
      }
      const detail = (await response.text()).slice(0, 500);
      if (!RETRY_STATUSES.has(response.status) || wait === undefined) throw new Error(`OpenRouter HTTP ${response.status}: ${detail}`);
      await delay(wait, undefined, { signal });
    }
  }

  private transcriptPath(sessionId: string): string {
    return join(this.options.sessionsDir, `${/^[\w-]{1,128}$/.test(sessionId) ? sessionId : sha256Hex(sessionId)}.json`);
  }

  /** A missing or unreadable transcript starts the chat over. */
  private load(path: string): Transcript {
    const empty: Transcript = { version: 1, history: [], last: null };
    if (!existsSync(path)) return empty;
    try {
      const transcript = JSON.parse(readFileSync(path, 'utf8')) as Transcript;
      return transcript.version === 1 && Array.isArray(transcript.history) ? transcript : empty;
    } catch (error) {
      this.options.diag.warn('openrouter.transcript_unreadable', { error: String(error) });
      return empty;
    }
  }

  /** A failed save loses only the chat context, not the answer. */
  private save(path: string, transcript: Transcript): void {
    try {
      mkdirSync(this.options.sessionsDir, { recursive: true });
      writeFileSync(`${path}.tmp`, JSON.stringify(transcript), 'utf8');
      renameSync(`${path}.tmp`, path);
    } catch (error) {
      this.options.diag.warn('openrouter.transcript_save_failed', { error: String(error) });
    }
  }
}
