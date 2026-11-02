// forever MCP proxy: a stdio server for Codex. It only forwards
// allowed tools to the bridge attempt channel; it has no SQL or general file
// access. The pipe and token file path are arguments; the token itself
// never appears on the command line.
//
//   bun bridge/src/sources/mcp.ts --pipe <name> --token-file <path> --attempt <attemptId>
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { TOOL_DESCRIPTIONS, ToolArgs, TOOL_NAMES } from '../contracts.js';
import { encodeIpcFrame, IpcFrameReader } from '../app/ipc.js';
import { randomId } from '../ids.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/** One tool call through the pipe: request -> one response frame. */
export function callBridge(pipe: string, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipe);
    const reader = new IpcFrameReader();
    socket.on('connect', () => socket.write(encodeIpcFrame(request)));
    socket.on('data', (chunk: Buffer) => {
      for (const event of reader.push(chunk)) {
        socket.end();
        if (event.kind === 'message') resolve(event.value);
        else reject(new Error(`bridge frame ${event.reason}`));
        return;
      }
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('bridge closed the tool channel')));
  });
}

export async function runProxy(): Promise<void> {
  const pipe = argument('--pipe');
  const attemptId = argument('--attempt');
  const token = readFileSync(argument('--token-file'), 'utf8').trim();
  const server = new McpServer({ name: 'forever', version: '0.3.0' });
  for (const tool of TOOL_NAMES) {
    // Every tool only reads bridge data; it neither changes the game world nor makes external requests.
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: tool !== 'lookup_prices' && tool !== 'lookup_items', openWorldHint: false };
    server.registerTool(tool, { description: TOOL_DESCRIPTIONS[tool], inputSchema: ToolArgs[tool], annotations }, async (args: unknown) => {
      try {
        const result = await callBridge(pipe, { version: 1, token, callId: randomId(), attemptId, tool, args });
        const status = (result as { status?: string }).status;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], isError: status === 'error' };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', limitations: [String(error)] }) }], isError: true };
      }
    });
  }
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProxy().catch((error: unknown) => {
    process.stderr.write(`forever MCP proxy: ${String(error)}\n`);
    process.exit(1);
  });
}
