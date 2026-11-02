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
import { ToolArgs, TOOL_NAMES, type ToolName } from '../contracts.js';
import { encodeIpcFrame, IpcFrameReader } from '../app/ipc.js';
import { randomId } from '../ids.js';

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  find_services:
    'Locate auctioneers, mailboxes, bankers, innkeepers, flight masters, vendors, trainers, repair NPCs or stable masters from the available local references. service="trainer" supports profession and classToken filters (null means any); set both null for other services. Trainer specializations require explicit reference data; a generic trainer flag cannot establish profession or class. Set itemId only for vendor, otherwise null. zoneName null searches all zones; forCharacter null uses the current character, otherwise a saved alt name. NPC faction is filtered and the character\'s map comes first. Results are services with id, trainerGroups, source records and coordinates; coordinates are percentages and alternative source positions are retained. Prefer locationRefId when non-null, otherwise approxLocation. Pass cursor to continue. Distances are straight-line only within the same map; stock, prices, individual recipe teaching and dynamic requirements are unknown.',
  search_game_data:
    'Search the available local game references by name or numeric ID before web search. types [] searches all types; item, recipe, npc, quest and object filter entities; other types select reference sections such as dungeons, professions, training, talents, bis or rewards. Each hit has type, id, name, match and records with source, datasetId, original type and recordKey. Matching records of the same entity type and ID are grouped, with conflicting text retained separately. Fetch every hit with get_game_record using its top-level type, id and recordKey, and fields []. A recipe id is a spell ID. Search results do not issue evidence; fetch details to cite them. Pass the returned cursor to continue. If a source is unavailable, returns results from the other source and reports the gap.',
  get_game_record:
    'Get any local game reference record; the bridge selects the available sources. Use the same type/id/recordKey as search_game_data: item, recipe, npc, quest and object require numeric id and null recordKey; other reference sections require recordKey and null id. fields [] returns all fields, otherwise projects named fields. Returns a common envelope: fields, separate sources with evidence, conflicts, names, locations, itemRefId (items) and recipeRefId (recipes). Recipe fields include skill thresholds, output and reagents; recipeRefId always refers to the complete recipe even if fields are projected. Item fields may include change notes, recipeSpellIds and vendor/drop/quest relationships. NPC fields include trainerGroups when known. Map coordinates are percentages; prefer returned locationRefId or approxLocation. Truncated lists and dynamic requirements cannot establish quest eligibility. Fetch this tool after search to cite evidence.',
  get_source_status: 'Availability, pinned versions, counts, builds and limitations of each local reference source.',
  calculate_craft:
    'Materials for a recipe (recipeRefId from get_game_record with type="recipe"): crafts = ceil(desired/outputCount), needed, owned, missing, and known prices. inventoryScope "bags" counts the bag snapshot of the current character, "account" counts bags, bank and mail of all characters of the player (alts as of their last save), "none" ignores inventory. Unknown prices are not zero. Returns calculationId for calculationIds.',
  lookup_prices:
    'Ask the game addon for its latest saved price observations of up to 100 items (waits up to 180 s). Prices are the last known observation per item, not stock or a purchase guarantee.',
  lookup_items:
    'Ask the game client, through the addon, what it knows about up to 20 items (waits up to 180 s): name, quality, item level, required level, type, subtype, equip slot, vendor price and the tooltip lines the player sees (stats, damage per second, requirements). The client of the player is the authoritative source for Forever item stats: use it instead of web search for stats and requirements. Each item known to the client gets an itemRefId for itemRefIds and [[item:...]] markers, also for items missing from the dataset. Also returns saved price observations when available, subject to their age and market limitations.',
  get_alts:
    'All characters of the player on this server (the current one and alts): name, class, race, faction, level, money, zone, professions with skill and the number of known recipes, equipped item IDs, and when each part was read in the game. The current character comes from the question snapshot; alts come from the addon saved data as of their last logout or /reload. Bank and mail are known only for characters that opened them.',
  find_items_on_alts:
    'Where the player has up to 100 items across all characters: per character the count in bags, bank and mail, and the total. Use it for "do I have", "where is", "who holds" questions and before suggesting to buy materials.',
  plan_craft:
    'Full crafting plan with intermediate crafts (recipeRefId from get_game_record with type="recipe"): takes what the characters already have (inventoryScope as in calculate_craft), crafts an intermediate (bars, cloth, leather, essences...) when a character of the player knows its recipe, or has the profession at the learn skill for a trainer recipe (learn="trainer": learn it first), and it is cheaper or has no price, otherwise buys it; the top recipe may also be a recipe-item recipe (learn="recipe_item", recipeItemId); up to maxDepth levels below the top recipe (usually 3). With lookupPrices=true it asks the addon for saved price observations for the whole tree first (waits up to 180 s). Returns ordered steps with the crafting character, the shopping list with prices, what comes from which character, transfers (what to mail to whom), leftovers and calculationId for calculationIds. Prices are last known observations, not stock or a purchase guarantee. Unknown prices are not zero.',
  find_recipe_crafters:
    'Which characters of the player know up to 50 recipes (spell IDs, as from get_game_record with type="recipe" or search_game_data): knownBy, canLearnNow (has the profession at the learn skill), needsSkill (skill too low), notScanned (has the profession but the addon has not seen its recipe list yet).',
};

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
