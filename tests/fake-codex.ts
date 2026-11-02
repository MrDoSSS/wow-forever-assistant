// Fake Codex CLI for adapter tests: matching arguments, JSONL events, an -o file
// and a real MCP client connected to forever. Select behavior with FAKE_CODEX_SCENARIO.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args[0] === 'features') {
  const names = ['shell_tool', 'unified_exec', 'code_mode_host', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'apps', 'plugins', 'hooks', 'multi_agent', 'memories'];
  process.stdout.write(names.map((n) => `${n.padEnd(40)} stable             true`).join('\n'));
  process.exit(0);
}

const resume = args[1] === 'resume' ? args[2]! : null;
const lastMessagePath = args[args.indexOf('-o') + 1]!;
const config = (key: string): unknown => {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c' && args[i + 1]!.startsWith(`${key}=`)) return JSON.parse(args[i + 1]!.slice(key.length + 1));
  }
  return undefined;
};
if (process.env.FAKE_CODEX_ARGS_FILE) appendFileSync(process.env.FAKE_CODEX_ARGS_FILE, `${JSON.stringify(args)}\n`);

function answer(text: string, extra: Record<string, unknown> = {}) {
  return { status: 'answer', text, itemRefIds: [], evidenceIds: [], locationRefId: null, approxLocation: null, calculationIds: [], limitations: [], clarification: null, ...extra };
}

function finish(reply: unknown): never {
  const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
  writeFileSync(lastMessagePath, text, 'utf8');
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}

/** Minimal stdio MCP client: initialize and tools/call. */
async function mcpSession() {
  const child = spawn(config('mcp_servers.forever.command') as string, config('mcp_servers.forever.args') as string[], { stdio: ['pipe', 'pipe', 'inherit'] });
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
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const call = async (name: string, toolArgs: object) => {
    const response = await request('tools/call', { name, arguments: toolArgs });
    const result = response.result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { status: string; data: Record<string, unknown>; evidenceIds: string[]; limitations: string[] };
  };
  return { call, close: () => child.kill() };
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => (prompt += chunk));
process.stdin.on('end', () => void main());

async function main(): Promise<void> {
  const threadId = resume ?? randomUUID();
  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  const scenario = process.env.FAKE_CODEX_SCENARIO ?? 'echo';
  const mode = resume ? 'resume' : 'new';
  const rules = prompt.includes('Sources, in order of trust');
  switch (scenario) {
    case 'echo':
      finish(answer(`mode=${mode} rules=${rules} question=${prompt.includes('<question>')}`));
    case 'tools': {
      const mcp = await mcpSession();
      const recipe = await mcp.call('get_game_record', { type: 'recipe', id: 14293, recordKey: null, fields: [] });
      const item = await mcp.call('get_game_record', { type: 'item', id: 11287, recordKey: null, fields: [] });
      const calc = await mcp.call('calculate_craft', { recipeRefId: recipe.data.recipeRefId, desiredQuantity: 3, inventoryScope: 'bags' });
      const bogus = await mcp.call('get_game_record', { type: 'recipe', id: 2147483646, recordKey: null, fields: [] });
      mcp.close();
      finish(
        answer(`Lesser Magic Wand: ${String(calc.data.crafts)} crafts; missing lookup: ${bogus.status}`, {
          itemRefIds: [item.data.itemRefId],
          evidenceIds: [...recipe.evidenceIds, ...item.evidenceIds],
          calculationIds: [calc.data.calculationId],
          limitations: [],
        }),
      );
    }
    case 'hang':
      // A grandchild process verifies that stopping kills the whole tree.
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
      return;
    case 'invalid-then-fix':
      if (prompt.includes('rejected your previous final message')) finish(answer(`fixed in ${mode}`));
      finish('{"status":"answer"}');
    case 'fail':
      emit({ type: 'turn.failed', error: { message: 'usage limit reached' } });
      process.exit(1);
  }
}
