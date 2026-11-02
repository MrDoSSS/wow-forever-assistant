// Fake Claude Code CLI for adapter tests: matching arguments, stream-json events, sessions under
// CLAUDE_CONFIG_DIR and a real MCP client connected to forever. Select behavior with FAKE_CLAUDE_SCENARIO.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : null);
if (process.env.FAKE_CLAUDE_ARGS_FILE) appendFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, `${JSON.stringify(args)}\n`);

const resume = option('--resume');
const sessionId = resume ?? option('--session-id')!;
const sessions = join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'fake-run-claude');
const sessionFile = join(sessions, `${sessionId}.jsonl`);

function answer(text: string, extra: Record<string, unknown> = {}) {
  return { status: 'answer', text, itemRefIds: [], evidenceIds: [], locationRefId: null, approxLocation: null, calculationIds: [], limitations: [], clarification: null, ...extra };
}

function finish(reply: unknown, structured = true): never {
  const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, session_id: sessionId });
  emit({ type: 'result', subtype: 'success', is_error: false, result: text, ...(structured && typeof reply !== 'string' ? { structured_output: reply } : {}), session_id: sessionId, total_cost_usd: 0.01, num_turns: 2 });
  process.exit(0);
}

/** Minimal stdio MCP client: initialize, tools/list and tools/call. */
async function mcpSession() {
  const config = JSON.parse(option('--mcp-config')!) as { mcpServers: { forever: { command: string; args: string[] } } };
  const child = spawn(config.mcpServers.forever.command, config.mcpServers.forever.args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) pending.get(message.id)?.(message as Record<string, unknown>);
  });
  let id = 0;
  const request = (method: string, params: object) =>
    new Promise<Record<string, unknown>>((resolve) => {
      id += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = ((await request('tools/list', {})).result as { tools: { name: string }[] }).tools.map((t) => `mcp__forever__${t.name}`);
  const call = async (name: string, toolArgs: object) => {
    const response = await request('tools/call', { name, arguments: toolArgs });
    const result = response.result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { status: string; data: Record<string, unknown>; evidenceIds: string[]; limitations: string[] };
  };
  return { tools, call, close: () => child.kill() };
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (prompt += chunk));
process.stdin.on('end', () => void main());

async function main(): Promise<void> {
  if (resume && !existsSync(sessionFile)) {
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `No conversation found with session ID: ${resume}`, session_id: resume });
    process.exit(1);
  }
  mkdirSync(sessions, { recursive: true });
  appendFileSync(sessionFile, `${JSON.stringify({ prompt: prompt.length })}\n`);
  const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'echo';
  const mcp = await mcpSession();
  const tools = ['WebSearch', 'StructuredOutput', ...mcp.tools, ...(scenario === 'extra-tool' ? ['Bash'] : [])];
  emit({ type: 'system', subtype: 'init', session_id: sessionId, tools, mcp_servers: [{ name: 'forever', status: 'connected', source: 'dynamic' }] });
  const mode = resume ? 'resume' : 'new';
  const rules = prompt.includes('Sources, in order of trust');
  switch (scenario) {
    case 'echo':
      mcp.close();
      finish(answer(`mode=${mode} rules=${rules} question=${prompt.includes('<question>')} schema=${option('--json-schema') !== null}`));
    case 'text':
      mcp.close();
      finish(answer('from result text'), false);
    case 'tools': {
      const recipe = await mcp.call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
      const item = await mcp.call('get_game_record', { type: 'item', id: 11287, recordKey: null, fields: [] });
      const calc = await mcp.call('calculate_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'bags' });
      mcp.close();
      finish(
        answer(`Lesser Magic Wand: ${String(calc.data.crafts)} crafts`, {
          itemRefIds: [item.data.itemRefId],
          evidenceIds: [...recipe.evidenceIds, ...item.evidenceIds],
          calculationIds: [calc.data.calculationId],
        }),
      );
    }
    case 'invalid-then-fix':
      mcp.close();
      if (prompt.includes('rejected your previous final message')) finish(answer(`fixed in ${mode}`));
      finish({ status: 'answer' });
    case 'fail':
      mcp.close();
      emit({ type: 'result', subtype: 'success', is_error: true, api_error_code: 'oauth_not_allowed_for_organization', terminal_reason: 'api_error', result: 'Your organization has disabled Claude subscription access for Claude Code', session_id: sessionId });
      process.exit(1);
    case 'extra-tool':
    case 'hang':
      // Wait to be stopped: the adapter must end the whole tree.
      setInterval(() => {}, 1000);
      return;
  }
}
