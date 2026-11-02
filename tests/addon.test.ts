import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ModelAdapter } from '../bridge/src/ai/adapter.js';
import { FixedModelAdapter } from '../bridge/src/ai/fixed.js';
import { Bridge } from '../bridge/src/app/bridge.js';
import type { RouteResult } from '../bridge/src/app/router.js';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { PriceResultBody } from '../bridge/src/contracts.js';
import { characterKeyOf } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { Store } from '../bridge/src/storage/store.js';
import { DeliveryPublisher, SlotPool, slotName } from '../bridge/src/transport/delivery.js';
import { decodePixels, FRAME, fragmentMessage } from '../bridge/src/transport/frame.js';
import { FrameReceiver } from '../bridge/src/transport/receiver.js';
import { installKit } from '../tools/install.js';
import { ControlledModel, FakeClock, flush, tempDir } from './fakes.js';
import { LuaHost } from './lua-host.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Lua cell colors (0..7) -> 512x96 RGB field as seen by capture. */
function cellsToRgb(cells: string): Uint8Array {
  const { cols, cellPx, widthPx, heightPx, low, high } = FRAME;
  const rgb = new Uint8Array(widthPx * heightPx * 3);
  for (let cell = 0; cell < cells.length; cell++) {
    const value = cells.charCodeAt(cell) - 48;
    const cx = (cell % cols) * cellPx;
    const cy = Math.floor(cell / cols) * cellPx;
    for (let y = 0; y < cellPx; y++) {
      for (let x = 0; x < cellPx; x++) {
        const at = ((cy + y) * widthPx + cx + x) * 3;
        rgb[at] = value & 4 ? high : low;
        rgb[at + 1] = value & 2 ? high : low;
        rgb[at + 2] = value & 1 ? high : low;
      }
    }
  }
  return rgb;
}

describe('addon primitives', () => {
  it('compiles every Lua file listed in the TOC', () => {
    const lua = new LuaHost();
    const toc = readFileSync(resourcePath('addon', 'ForeverAssistant', 'ForeverAssistant.toc'), 'utf8');
    for (const file of toc.split(/\r?\n/).filter((line) => line.endsWith('.lua'))) {
      lua.compile(resourcePath('addon', 'ForeverAssistant', ...file.split('\\')));
    }
  });

  for (const nativeBit of [false, true]) {
    it(`SHA-256 matches node:crypto (${nativeBit ? 'LuaBitOp' : 'arithmetic'} bit ops)`, () => {
      const lua = new LuaHost({ nativeBit });
      lua.loadAddon();
      assert.equal(lua.eval('FA_BIT_NATIVE == nil and __FA_NS.Bit.native'), String(nativeBit));
      for (const text of ['', 'abc', '\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440', 'x'.repeat(1000), '["forever-test","Forever","Player-1-00000001"]']) {
        assert.equal(lua.eval(`__FA_NS.Sha256.hex(${LuaHost.literal(text)})`), sha(text), text.slice(0, 20));
      }
    });
  }

  it('collects professions from C_SkillInfo when the classic skill API is absent', () => {
    const lua = new LuaHost();
    lua.run(`
      GetNumSkillLines, GetSkillLineInfo = nil, nil
      C_SkillInfo = {
        GetNumSkillLines = function() return 4 end,
        GetSkillLineInfo = function(i)
          return ({
            { name = "Professions", isHeader = true },
            { name = "Tailoring", skillID = 197, rank = 40, maxRank = 75, parentSkillLineID = 0 },
            { name = "Tailoring child", skillID = 197, rank = 40, maxRank = 75, parentSkillLineID = 197 },
            { name = "Staves", skillID = 136, rank = 20, maxRank = 20, parentSkillLineID = 0 },
          })[i]
        end,
      }`);
    lua.loadAddon();
    lua.run('TEST_GROUP = __FA_NS.Context.group("professions", true)');
    assert.equal(lua.eval('TEST_GROUP.availability'), 'available');
    assert.equal(lua.eval('#TEST_GROUP.value'), '1');
    assert.equal(lua.eval('TEST_GROUP.value[1].skillId .. ":" .. TEST_GROUP.value[1].rank'), '197:40');
    const missing = lua.eval('table.concat(select(2, __FA_NS.Context.apiReport()), ",")');
    assert.ok(missing.split(',').includes('GetSkillLineInfo'));
    assert.ok(!missing.split(',').includes('C_SkillInfo.GetSkillLineInfo'));
  });

  it('keeps every visible addon string in Latin: the English client has no Cyrillic glyphs', () => {
    const files = ['Core.lua', 'Assistant.lua', 'Map.lua', 'Integrations/Auctionator.lua', 'Integrations/ItemInfo.lua', 'UI/Items.lua', 'UI/Wrap.lua', 'Transport/Inbound.lua', 'Transport/Outbound.lua', 'Collectors/Context.lua', 'Collectors/Alts.lua', 'UI/Theme.lua', 'UI/Settings.lua', 'UI/Chat.lua', 'Plan.lua', 'UI/PlanWindow.lua', 'ForeverAssistant.toc', 'Bindings.xml'];
    for (const file of files) {
      const lines = readFileSync(resourcePath('addon', 'ForeverAssistant', ...file.split('/')), 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        const code = line.replace(/--.*$/, '');
        // ruRU profession names are matching data, not UI labels.
        if (/[\u0410-\u042f\u0430-\u044f\u0401\u0451]/.test(code) && !/^\s*\["[^"]+"\] = \d+/.test(code)) assert.fail(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
  });

  it('reports no talents below level 10 as a complete empty list', () => {
    const lua = new LuaHost();
    lua.run('UnitLevel = function() return 4 end; GetNumTalentTabs, GetTalentInfo = nil, nil');
    lua.loadAddon();
    lua.run('TEST_GROUP = __FA_NS.Context.group("talents", true)');
    assert.equal(lua.eval('TEST_GROUP.availability .. "/" .. TEST_GROUP.coverage .. "/" .. #TEST_GROUP.value'), 'available/complete/0');
    lua.run('UnitLevel = function() return 12 end; TEST_GROUP = __FA_NS.Context.group("talents", true)');
    assert.equal(lua.eval('TEST_GROUP.availability .. "/" .. TEST_GROUP.reason'), 'unavailable/api_unavailable');
  });

  it('encodes JSON like JSON.stringify and derives the same characterKey', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    const encoded = lua.eval(`__FA_NS.Json.encode({
      text = "\u0421\u0442\u0440\u043e\u043a\u0430 \\"\u0432 \u043a\u0430\u0432\u044b\u0447\u043a\u0430\u0445\\"\\n\\t\\1\\127 ok",
      list = __FA_NS.Json.array({ 1, 2.5, -3, 9007199254740991 }),
      empty = __FA_NS.Json.array(),
      object = {},
      nothing = __FA_NS.Json.null,
      flag = false,
    })`);
    const expected = {
      empty: [],
      flag: false,
      list: [1, 2.5, -3, 9007199254740991],
      nothing: null,
      object: {},
      text: '\u0421\u0442\u0440\u043e\u043a\u0430 "\u0432 \u043a\u0430\u0432\u044b\u0447\u043a\u0430\u0445"\n\t\u0001\u007f ok',
    };
    assert.equal(encoded, JSON.stringify(expected));
    const identity = { serverNamespace: 'forever-test', realm: 'Forever', playerGuid: 'Player-1-00000001', displayName: 'Tester' };
    assert.equal(
      lua.eval(`__FA_NS.Assistant.characterKeyOf({ serverNamespace = "forever-test", realm = "Forever", playerGuid = "Player-1-00000001" })`),
      characterKeyOf(identity),
    );
  });

  it('builds frames byte-for-byte like the bridge codec, including UTF-8 split across fragments', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    const text = `${'a'.repeat(1023)}${'\u0436'.repeat(700)}`;
    const bytes = new TextEncoder().encode(JSON.stringify({ text }));
    const origin = '00112233445566778899aabbccddeeff';
    const expected = fragmentMessage({ kind: 2, originSessionId: origin, messageSequence: 513, bytes });
    assert.equal(expected.length, 3);
    lua.run(`TEST_MESSAGE = { kind = 2, origin = "${origin}", sequence = 513, bytes = ${LuaHost.literal(new TextDecoder().decode(bytes))} }`);
    for (let index = 0; index < expected.length; index++) {
      const hex = lua.eval(`(function()
        local frame = __FA_NS.Codec.frameBytes(TEST_MESSAGE, ${index})
        local out = {}
        for i = 1, #frame do out[i] = string.format("%02x", frame[i]) end
        return table.concat(out)
      end)()`);
      assert.equal(hex, Buffer.from(expected[index]!).toString('hex'), `fragment ${index}`);
      const cells = lua.eval(`table.concat(__FA_NS.Codec.cells(__FA_NS.Codec.frameBytes(TEST_MESSAGE, ${index})))`);
      const decoded = decodePixels(cellsToRgb(cells), FRAME.widthPx, FRAME.heightPx);
      assert.ok(decoded.ok);
      assert.deepEqual(decoded.ok && Buffer.from(decoded.frame), Buffer.from(expected[index]!));
    }
  });
});

/** Addon in fengari <-> real bridge: frames through FrameReceiver, packets through the LoD pool. */
class Exchange {
  readonly lua = new LuaHost();
  readonly clock = new FakeClock();
  readonly diag = new MemoryDiagnostics(this.clock);
  readonly store: Store;
  readonly bridge: Bridge;
  readonly publisher: DeliveryPublisher;
  readonly receiver: FrameReceiver;
  readonly addonsDir: string;
  readonly results: RouteResult[] = [];
  private lastShown = '';

  constructor(model: ModelAdapter = new FixedModelAdapter()) {
    const dir = tempDir();
    this.addonsDir = join(dir, 'AddOns');
    mkdirSync(this.addonsDir);
    installKit({ addonsDir: this.addonsDir, serverNamespace: 'forever-test' });
    this.store = Store.open({ path: join(dir, 'assistant.sqlite'), clock: this.clock });
    this.publisher = new DeliveryPublisher({ store: this.store, pool: new SlotPool(this.addonsDir), clock: this.clock, diag: this.diag });
    this.bridge = new Bridge({ store: this.store, clock: this.clock, diag: this.diag, adapter: model });
    this.receiver = new FrameReceiver({ receive: (m) => this.bridge.receive(m), clock: this.clock, diag: this.diag });
    this.lua.loadAddon();
  }

  get time(): number {
    return Number(this.lua.eval('WowStub.time'));
  }

  start(): void {
    assert.equal(this.lua.eval('__FA_NS.Assistant.start()'), 'true');
  }

  /** One 0.5-second tick: capture and receive the visible frame, then publish a packet. */
  async step(seconds = 0.5): Promise<void> {
    this.lua.run(`WowStub.time = WowStub.time + ${seconds}; __FA_NS.tick(WowStub.time)`);
    const shown = this.lua.eval(`(function()
      local s = __FA_NS.Outbound.lastShown
      if not s or __FA_NS.Outbound.shownAt ~= WowStub.time then return "" end
      return s.origin .. ":" .. s.sequence .. ":" .. s.index
    end)()`);
    if (shown && shown !== this.lastShown) {
      const cells = this.lua.eval('table.concat(__FA_NS.Outbound.lastCells)');
      const result = this.receiver.onImage({ at: this.clock.now(), width: FRAME.widthPx, height: FRAME.heightPx, rgb: cellsToRgb(cells) });
      if (result) this.results.push(result);
    }
    this.lastShown = shown;
    // Do not wait for the whole attempt: the controlled model may never reply.
    await flush();
    this.publisher.publishNow();
    const inbox = readFileSync(join(this.addonsDir, slotName(1), 'Inbox.lua'), 'utf8');
    this.lua.run(`WowStub.inbox = ${LuaHost.literal(inbox)}`);
    this.clock.advance(seconds * 1000);
  }

  async run(seconds: number): Promise<void> {
    for (let t = 0; t < seconds; t += 0.5) await this.step();
  }

  accepted(type: string) {
    return this.results.filter((r) => r.status === 'accepted' && r.type === type);
  }

  history(): string[] {
    const count = Number(this.lua.eval('#__FA_NS.Assistant.state.history'));
    return Array.from({ length: count }, (_, i) => this.lua.eval(`__FA_NS.Assistant.state.history[${i + 1}].text`));
  }
}

describe('addon ↔ bridge exchange', () => {
  it('delivers multiple map links and restores them from bridge history after losing the local cache', async () => {
    const model = new ControlledModel();
    const x = new Exchange(model);
    x.start();
    await x.run(12);
    x.lua.run('__FA_NS.Assistant.ask("Show two places")');
    await x.run(8);
    model.reply({ status: 'answer', text: 'Visit [[map:1]] and [[map:2]].', itemRefIds: [], evidenceIds: [],
      locationRefId: null, approxLocation: null, calculationIds: [], limitations: [], clarification: null,
      locations: [
        { locationRefId: null, approxLocation: { title: 'First camp', zoneName: 'Tirisfal Glades', x: 61.8, y: 51.6, basis: 'fixture', sourceUrl: 'https://example.test/first' } },
        { locationRefId: null, approxLocation: { title: 'Second camp', zoneName: 'Elwynn Forest', x: 41, y: 65, basis: 'fixture', sourceUrl: 'https://example.test/second' } },
      ] });
    await x.run(20);
    assert.equal(x.lua.eval('#__FA_NS.Assistant.state.history[2].locations'), '2');
    x.lua.run('local A = __FA_NS.Assistant; A.state.history = {}; A.currentChat().history = A.state.history; A.start()');
    await x.run(12);
    x.lua.run('MULTI_ENTRY = __FA_NS.Assistant.state.history[2]; MULTI_TEXT = __FA_NS.Items.renderEntry(MULTI_ENTRY)');
    assert.equal(x.lua.eval('#MULTI_ENTRY.locations'), '2');
    const entryId = x.lua.eval('MULTI_ENTRY.entryId');
    const rendered = x.lua.eval('MULTI_TEXT');
    assert.ok(rendered.includes(`|Hfamap:${entryId}:1|h[First camp`), rendered);
    assert.ok(rendered.includes(`|Hfamap:${entryId}:2|h[Second camp`), rendered);
    x.lua.run(`__FA_NS.Items.onClick("famap:${entryId}:2", "", "LeftButton")`);
    assert.equal(x.lua.eval('WowStub.worldMap'), '1429');
    x.lua.run(`__FA_NS.Items.onClick("famap:${entryId}:1", "", "LeftButton")`);
    assert.equal(x.lua.eval('WowStub.worldMap'), '1420');
    x.lua.run(`__FA_NS.Items.onClick("fatrack:${entryId}:2", "", "LeftButton")`);
    assert.equal(x.lua.eval('WowStub.waypoint.uiMapID'), '1429');
    assert.equal(x.lua.eval('__FA_NS.Map.active.title'), 'Second camp');
  });

  it('deletes one chat and its bridge history without resetting another chat', async () => {
    const x = new Exchange();
    x.start();
    await x.run(12);
    const first = x.lua.eval('__FA_NS.Assistant.state.conversationId');
    x.lua.run('__FA_NS.Assistant.ask("Keep this conversation")');
    await x.run(20);
    const preserved = x.history();
    assert.equal(x.lua.eval('__FA_NS.Assistant.newChat()'), 'true');
    const removed = x.lua.eval('__FA_NS.Assistant.state.conversationId');
    x.lua.run('__FA_NS.Assistant.ask("Delete this private title and history")');
    await x.run(20);
    x.lua.run('assert(__FA_NS.Assistant.deleteChat())');
    assert.equal(x.lua.eval('__FA_NS.Assistant.state.conversationId'), first);
    assert.deepEqual(x.history(), preserved);
    const operation = x.lua.eval('next(__FA_NS.Assistant.state.pendingDeletes)');
    const replacement = x.lua.eval(`__FA_NS.Assistant.state.pendingDeletes["${operation}"].replacement`);
    await x.run(20);
    const characterKey = x.lua.eval('__FA_NS.Assistant.session.characterKey');
    assert.equal(x.store.getConversation(characterKey, removed), undefined);
    assert.equal(x.store.listConversationRequests(characterKey, removed).length, 0);
    assert.equal(x.store.getConversation(characterKey, replacement)?.title, 'New chat');
    assert.equal(x.lua.eval('next(__FA_NS.Assistant.state.pendingDeletes)'), 'nil');
    assert.equal(x.lua.eval('#__FA_NS.Assistant.state.chats'), '1');
    assert.deepEqual(x.history(), preserved);
  });

  it('returns to a saved conversation through the bridge without mixing histories', async () => {
    const x = new Exchange();
    x.start();
    await x.run(12);
    const first = x.lua.eval('__FA_NS.Assistant.state.conversationId');
    x.lua.run('__FA_NS.Assistant.ask("First conversation")');
    await x.run(20);
    const firstHistory = x.history();
    assert.equal(firstHistory.length, 2);
    assert.equal(x.lua.eval('__FA_NS.Assistant.newChat()'), 'true');
    await x.run(12);
    x.lua.run('__FA_NS.Assistant.ask("Second conversation")');
    await x.run(20);
    assert.equal(x.history()[0], 'Second conversation');
    assert.equal(x.lua.eval(`__FA_NS.Assistant.selectChat("${first}")`), 'true');
    await x.run(12);
    assert.deepEqual(x.history(), firstHistory);
    assert.equal(x.lua.eval('#__FA_NS.Assistant.state.chats'), '2');
    assert.equal(x.lua.eval('__FA_NS.Assistant.currentChat().history == __FA_NS.Assistant.state.history'), 'true');
  });

  it('says HELLO, asks a question with a real snapshot and shows the fixed answer', async () => {
    const x = new Exchange();
    x.start();
    await x.run(12);
    assert.equal(x.accepted('HELLO').length, 1);
    assert.equal(x.lua.eval('#__FA_NS.Outbound.queue'), '0', 'HELLO and RECEIPTS acknowledged');

    const key = x.lua.eval('(function() local k = __FA_NS.Assistant.ask("Which staff is better for a mage?") return k and k.requestId end)()');
    assert.notEqual(key, 'nil');
    await x.run(20);
    const query = x.accepted('QUERY');
    assert.equal(query.length, 1, JSON.stringify(x.results.filter((r) => r.status !== 'accepted')));
    const characterKey = x.lua.eval('__FA_NS.Assistant.session.characterKey');
    const request = x.store.getActiveRequest(characterKey) ?? x.store.listConversationRequests(characterKey, x.lua.eval('__FA_NS.Assistant.state.conversationId'))[0];
    assert.equal(request?.state, 'completed');

    const snapshot = JSON.parse(x.store.getSnapshotJson({ characterKey, originSessionId: request!.origin_session_id, requestId: request!.request_id })!);
    assert.equal(snapshot.groups.character.value.classToken, 'MAGE');
    assert.equal(snapshot.groups.equipment.value.length, 19);
    assert.equal(snapshot.groups.equipment.value[0].item.itemLink.includes('Hitem:7046'), true);
    assert.equal(snapshot.groups.equipment.value[15].item.itemLink, null);
    assert.deepEqual(snapshot.groups.bags.value.map((b: { count: number }) => b.count), [2, 5]);
    assert.equal(snapshot.groups.quests.value[0].objectives[0].need, 8);
    assert.deepEqual(snapshot.groups.position.value, { mapKey: 'uiMap:1429', x: 0.4123, y: 0.6501, zoneName: 'Elwynn Forest' });
    assert.equal(snapshot.groups.professions.value[0].skillId, 197);
    assert.equal(snapshot.groups.prices.availability, 'unavailable');

    const history = x.history();
    assert.equal(history[0], 'Which staff is better for a mage?');
    assert.match(history[1] ?? '', /Test answer from the bridge/);
    assert.equal(x.lua.eval('__FA_NS.Assistant.state.active'), 'nil');
    await x.run(60);
    assert.equal(x.lua.eval('__FA_NS.Inbound.running'), 'false', 'polling stops when nothing is pending');
    assert.equal(x.lua.eval('#__FA_NS.Outbound.queue'), '0');
    const reads = Number(x.lua.eval('__FA_NS.Inbound.stats.reads'));
    assert.ok(reads >= 4 && reads <= 14, `slot reads: ${reads}`);
    assert.equal(x.store.listPendingDeliveries(characterKey, x.lua.eval('__FA_NS.Assistant.session.origin')).length, 0);
  });

  it('stops a question: CANCEL takes the next frame and a late reply is not shown', async () => {
    const model = new ControlledModel();
    const x = new Exchange(model);
    x.start();
    await x.run(12);
    x.lua.run('__FA_NS.Assistant.ask("Long-running question")');
    await x.run(8);
    assert.equal(model.calls.length, 1);
    x.lua.run('__FA_NS.Assistant.stop()');
    await x.step();
    assert.equal(x.lua.eval('__FA_NS.Outbound.lastShown.sequence'), x.lua.eval('__FA_NS.Assistant.session.sequence'));
    await x.run(12);
    assert.equal(x.accepted('CANCEL').length, 1);
    assert.equal(model.last().signal.aborted, true);

    // A late reply to a cancelled question must not enter history.
    const key = model.last().input.request;
    x.lua.run(`__FA_NS.Assistant.applyPacket({
      version = 1, publicationRevision = 999999, targetCharacterKey = "${key.characterKey}",
      targetDeliverySessionId = "${key.originSessionId}", acceptedMessageKeys = {},
      deliveries = { { deliveryId = "${'e'.repeat(32)}", type = "reply",
        request = { characterKey = "${key.characterKey}", originSessionId = "${key.originSessionId}", requestId = ${key.requestId} },
        body = { status = "answer", text = "Too late", itemRefs = {}, evidenceIds = {}, calculationIds = {}, limitations = {} } } } })`);
    assert.ok(!x.history().includes('Too late'));
  });

  it('ignores packets for another character, another delivery session or an older revision', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    const packet = (revision: number, character = ck, session = origin) =>
      `__FA_NS.Assistant.applyPacket({ version = 1, publicationRevision = ${revision}, targetCharacterKey = "${character}",
         targetDeliverySessionId = "${session}", acceptedMessageKeys = {}, deliveries = {} })`;
    assert.equal(lua.eval(packet(5, 'f'.repeat(64))), 'false');
    assert.equal(lua.eval(packet(5, ck, 'a'.repeat(32))), 'false');
    assert.equal(lua.eval(packet(5)), 'true');
    assert.equal(lua.eval(packet(5)), 'false');
    assert.equal(lua.eval(packet(4)), 'false');
    assert.equal(lua.eval(packet(6)), 'true');
  });

  it('keeps unacknowledged messages with their original IDs and bytes across /reload, but not the old HELLO', async () => {
    const x = new Exchange();
    x.start();
    x.lua.run('__FA_NS.Assistant.ask("Question before reload")');
    const query = x.lua.eval('__FA_NS.Outbound.queue[2].origin .. ":" .. __FA_NS.Outbound.queue[2].sequence');
    const bytes = x.lua.eval('__FA_NS.Outbound.queue[2].bytes');
    // /reload before reception: create a new game session and release loaded slots.
    x.lua.run('WowStub.loaded = {}; __FA_NS.Inbound.nextSlot = 1; __FA_NS.Assistant.start()');
    assert.equal(x.lua.eval('__FA_NS.Outbound.queue[1].origin .. ":" .. __FA_NS.Outbound.queue[1].sequence'), query);
    assert.equal(x.lua.eval('__FA_NS.Outbound.queue[1].bytes'), bytes);
    assert.equal(x.lua.eval('__FA_NS.Outbound.queue[2].type'), 'HELLO');
    assert.equal(x.lua.eval('#__FA_NS.Outbound.queue'), '2');
    await x.run(40);
    assert.equal(x.accepted('HELLO').length, 1);
    assert.equal(x.accepted('QUERY').length, 1);
    assert.equal(x.lua.eval('#__FA_NS.Outbound.queue'), '0');
    assert.match(x.history().at(-1) ?? '', /Test answer from the bridge/);
  });
});

describe('addon polling schedule', () => {
  function idleAddon() {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    return lua;
  }
  const tickTo = (lua: LuaHost, seconds: number) =>
    lua.run(`WowStub.time = 1000 + ${seconds}; __FA_NS.tick(WowStub.time)`);

  it('reads one slot per scheduled moment and does not catch up after a late tick', () => {
    const lua = idleAddon();
    lua.run('__FA_NS.Assistant.ask("Question without a reply")');
    for (const t of [4.9, 5, 9, 10, 15]) tickTo(lua, t);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '2');
    tickTo(lua, 70); // late tick: one read skips scheduled times 16..60
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '3');
    tickTo(lua, 79);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '3');
    tickTo(lua, 80);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '4');
    assert.equal(lua.eval('WowStub.loads[4]'), 'ForeverAssistant_Slot004');
  });

  it('pauses reading after 300 s without QUERY ACK but keeps showing frames', () => {
    const lua = idleAddon();
    lua.run('__FA_NS.Assistant.ask("Question")');
    for (let t = 0; t <= 300; t += 1) tickTo(lua, t);
    assert.equal(lua.eval('__FA_NS.Inbound.paused'), 'query_unacked');
    assert.equal(lua.eval('__FA_NS.Outbound.suspended'), 'false');
    const reads = lua.eval('__FA_NS.Inbound.stats.reads');
    tickTo(lua, 400);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), reads);
    lua.run('__FA_NS.Assistant.retry()');
    tickTo(lua, 406);
    assert.equal(Number(lua.eval('__FA_NS.Inbound.stats.reads')), Number(reads) + 1);
  });

  it('limits a service exchange to six reads, then waits for «Retry»', () => {
    const lua = idleAddon(); // HELLO without a bridge
    for (let t = 0; t <= 120; t += 1) tickTo(lua, t);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '6');
    assert.equal(lua.eval('__FA_NS.Inbound.paused'), 'service');
    assert.equal(lua.eval('__FA_NS.Outbound.suspended'), 'true');
    assert.equal(lua.eval('#__FA_NS.Outbound.queue'), '1', 'the HELLO stays queued');
  });

  it('does not read slots while idle', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    for (let t = 0; t <= 600; t += 5) tickTo(lua, t);
    assert.equal(lua.eval('__FA_NS.Inbound.stats.reads'), '0');
  });
});

describe('item links, Auctionator prices and the map point', () => {
  const HOOD = '|cff1eff00|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r';
  const POTION = '|cnIQ1:|Hitem:118::::::::12:::::::|h[Minor Healing Potion]|h|r';
  const hex = (c: string) => c.repeat(32);

  /** Bridge packet for the current addon session with one delivery. */
  function packet(lua: LuaHost, revision: number, delivery: string) {
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    lua.run(`__FA_NS.Assistant.applyPacket({ version = 1, publicationRevision = ${revision}, targetCharacterKey = "${ck}",
      targetDeliverySessionId = "${origin}", acceptedMessageKeys = {}, deliveries = { ${delivery} } })`);
  }

  function deliver(lua: LuaHost, type: string, body: string, revision = 1) {
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    packet(
      lua,
      revision,
      `{ deliveryId = "${String(revision).padStart(32, 'd')}", type = "${type}",
         request = { characterKey = "${ck}", originSessionId = "${origin}", requestId = 1 }, body = ${body} }`,
    );
  }

  function queued(lua: LuaHost, type: string): Record<string, unknown> {
    const bytes = lua.eval(`(function()
      for i = #__FA_NS.Outbound.queue, 1, -1 do
        local item = __FA_NS.Outbound.queue[i]
        if item.type == "${type}" then return item.bytes end
      end
    end)()`);
    assert.notEqual(bytes, 'nil', `${type} is queued`);
    return JSON.parse(bytes) as Record<string, unknown>;
  }

  it('extracts Shift+clicked links from the question in both colour formats, once each', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run(`TEST_REFS = __FA_NS.Items.extract(${LuaHost.literal(`Compare ${HOOD} and ${POTION}, again ${HOOD}`)})`);
    assert.equal(lua.eval('#TEST_REFS'), '2');
    assert.equal(lua.eval('TEST_REFS[1].itemId .. "/" .. TEST_REFS[2].itemId'), '7046/118');
    assert.equal(lua.eval('TEST_REFS[2].itemLink'), POTION);
    assert.equal(lua.eval('#__FA_NS.Items.extract("no links |Hitem:5|h[x]|h")'), '0');
  });

  it('sends linked items with Auctionator prices in the snapshot', async () => {
    const x = new Exchange();
    x.lua.run('WowStubAuctionator({ [7046] = 25000, [118] = 40 })');
    x.start();
    await x.run(12);
    x.lua.run(`__FA_NS.Assistant.ask(${LuaHost.literal(`Is ${HOOD} worth it? ${POTION}`)})`);
    await x.run(20);
    assert.equal(x.accepted('QUERY').length, 1, JSON.stringify(x.results.filter((r) => r.status !== 'accepted')));
    const characterKey = x.lua.eval('__FA_NS.Assistant.session.characterKey');
    const request = x.store.listConversationRequests(characterKey, x.lua.eval('__FA_NS.Assistant.state.conversationId'))[0]!;
    const snapshot = JSON.parse(x.store.getSnapshotJson({ characterKey, originSessionId: request.origin_session_id, requestId: request.request_id })!);
    const prices = snapshot.groups.prices;
    assert.equal(prices.availability, 'available');
    type Row = { item: { itemId: number }; priceCopper: number; ageDays: number; exactness: string; marketKey: string; sourceVersion: string };
    assert.deepEqual(
      prices.value.map((o: Row) => [o.item.itemId, o.priceCopper, o.ageDays, o.exactness, o.marketKey, o.sourceVersion]),
      [
        [7046, 25000, 2, 'fallback', 'auctionator:Forever Alliance', '341'],
        [118, 40, 2, 'fallback', 'auctionator:Forever Alliance', '341'],
      ],
    );
    assert.match(x.history().at(-1) ?? '', /item links: 2/);
  });

  it('answers a price lookup with observations the bridge schema accepts, or one general reason', () => {
    const lua = new LuaHost();
    lua.run('WowStubAuctionator({ [118] = 40 })');
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    deliver(lua, 'price_lookup', `{ lookupId = "${hex('a')}", items = { { itemId = 118 }, { itemId = 7046, itemLink = ${LuaHost.literal(HOOD)} } } }`);
    const body = PriceResultBody.parse(queued(lua, 'PRICE_RESULT').body);
    assert.equal(body.unavailableReason, null);
    assert.deepEqual(
      body.observations.map((o) => [o.item.itemId, o.item.itemLink, o.priceCopper, o.unavailableReason, o.exactness]),
      [
        [118, null, 40, null, 'exact'],
        [7046, HOOD, null, 'no_price', 'unknown'],
      ],
    );

    const without = new LuaHost();
    without.loadAddon();
    without.run('__FA_NS.Assistant.start()');
    deliver(without, 'price_lookup', `{ lookupId = "${hex('b')}", items = { { itemId = 118 } } }`);
    const general = PriceResultBody.parse(queued(without, 'PRICE_RESULT').body);
    assert.deepEqual([general.observations.length, general.unavailableReason], [0, 'api_unavailable']);

    lua.run('Auctionator.Database = nil');
    assert.equal(lua.eval('__FA_NS.Prices.status()'), 'not_ready');
  });

  it('keeps verified items and the map point of an answer and shows the point on the world map', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    deliver(
      lua,
      'reply',
      `{ status = "answer", text = "Vance Undergloom", evidenceIds = {}, calculationIds = {},
         itemRefs = { { refId = "${hex('c')}", itemId = 118, evidenceIds = { "${hex('e')}" } }, { refId = "${hex('d')}", itemId = 99999, evidenceIds = { "${hex('e')}" } } },
         approxLocation = { title = "Vance Undergloom", zoneName = "Undercity", x = 61.8, y = 51.6, basis = "ForeverMaster trainer record, NPC 5695", sourceUrl = "https://foreverchanges.pro" },
         limitations = { "approx_location" } }`,
    );
    lua.run('TEST_ENTRY = __FA_NS.Assistant.state.history[#__FA_NS.Assistant.state.history]');
    assert.equal(lua.eval('TEST_ENTRY.text'), 'Vance Undergloom');
    assert.equal(lua.eval('__FA_NS.Items.linkFor(TEST_ENTRY.itemRefs[1])'), '|cffffffff|Hitem:118::::::::12:::::::|h[Minor Healing Potion]|h|r');
    assert.equal(lua.eval('__FA_NS.Items.linkFor(TEST_ENTRY.itemRefs[2])'), '|cffffffff|Hitem:99999|h[item 99999]|h|r');

    lua.run('TEST_POINT = __FA_NS.Map.pointOf(TEST_ENTRY)');
    assert.equal(lua.eval('TEST_POINT.mapId'), '1458', 'the zone wins over a dungeon of the same name');
    assert.equal(lua.eval('TEST_POINT.verified'), 'false');
    assert.equal(lua.eval('__FA_NS.Map.describe(TEST_POINT)'), 'Undercity 61.8, 51.6');
    assert.equal(lua.eval('__FA_NS.Map.label(TEST_POINT)'), 'Vance Undergloom (Undercity 61.8, 51.6)');
    assert.equal(lua.eval('__FA_NS.Map.showEntry(TEST_ENTRY.entryId)'), 'true');
    assert.equal(lua.eval('WowStub.worldMap'), '1458');
    lua.run('TEST_PIN = __FA_NS.Map.pinFrame()');
    assert.equal(lua.eval('TEST_PIN.shown'), 'true');
    assert.equal(lua.eval('string.format("%.0f,%.0f", TEST_PIN.point[2], TEST_PIN.point[3])'), '618,-258');
    lua.run('WowStub.worldMap = 1420; __FA_NS.Map.refreshPin()');
    assert.equal(lua.eval('TEST_PIN.shown'), 'true', 'the mark is also on the zone that contains the city');
    assert.equal(lua.eval('string.format("%.0f,%.0f", TEST_PIN.point[2], TEST_PIN.point[3])'), '612,-234');
    lua.run('WowStub.worldMap = 1415; __FA_NS.Map.refreshPin()');
    assert.equal(lua.eval('TEST_PIN.shown'), 'true', 'and on the continent');
    lua.run('WowStub.worldMap = 1429; __FA_NS.Map.refreshPin()');
    assert.equal(lua.eval('TEST_PIN.shown'), 'false', 'but not on a map that does not contain it');

    // Track: city waypoints are forbidden, so place the waypoint on the parent zone.
    assert.equal(lua.eval('__FA_NS.Map.trackEntry(TEST_ENTRY.entryId)'), 'true');
    assert.equal(lua.eval('string.format("%d %.4f %.4f", WowStub.waypoint.uiMapID, WowStub.waypoint.x, WowStub.waypoint.y)'), '1420 0.6118 0.4688');
    assert.equal(lua.eval('WowStub.superTracked'), 'true');
    lua.run('__FA_NS.Map.clear()');
    assert.equal(lua.eval('__FA_NS.Map.active'), 'nil');
    assert.equal(lua.eval('WowStub.waypoint'), 'nil');
    assert.equal(lua.eval('WowStub.superTracked'), 'false');
    lua.run('C_Map.SetUserWaypoint = nil');
    assert.equal(lua.eval('select(2, __FA_NS.Map.trackEntry(TEST_ENTRY.entryId))'), 'no_waypoint_api');

    const link = lua.eval('__FA_NS.Items.mapLink(TEST_ENTRY.entryId, TEST_POINT)');
    assert.ok(link.startsWith('|cffff9933|Hfamap:') && link.includes('|h[Vance Undergloom (Undercity 61.8, 51.6)]|h|r |cff888888(not verified)|r'), link);
    assert.ok(link.endsWith(`|Hfatrack:${lua.eval('TEST_ENTRY.entryId')}|h[Track]|h|r`), link);
    const target = link.slice(link.indexOf('|H') + 2, link.indexOf('|h'));
    assert.equal(lua.eval(`__FA_NS.Items.mapEntryId(${LuaHost.literal(target)})`), lua.eval('TEST_ENTRY.entryId'));
  });

  it('reads a verified point by mapKey, keeps text only for an unknown zone and rejects out-of-range coordinates', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('TEST_POINT = __FA_NS.Map.pointOf({ locationRef = { mapKey = "uiMap:1420", x = 0.618, y = 0.516 } })');
    assert.equal(lua.eval('TEST_POINT.mapId .. "/" .. tostring(TEST_POINT.verified) .. "/" .. TEST_POINT.zoneName'), '1420/true/Tirisfal Glades');
    lua.run('TEST_POINT = __FA_NS.Map.pointOf({ approxLocation = { zoneName = "Nowhere", x = 10, y = 20, basis = "b", sourceUrl = "u" } })');
    assert.equal(lua.eval('TEST_POINT.mapId'), 'nil');
    assert.equal(lua.eval('select(2, __FA_NS.Map.show(TEST_POINT))'), 'no_map');
    assert.equal(lua.eval('__FA_NS.Map.pointOf({ approxLocation = { zoneName = "Undercity", x = 101, y = 20, basis = "b", sourceUrl = "u" } })'), 'nil');
    assert.equal(lua.eval('__FA_NS.Map.pointOf({ locationRef = { mapKey = "zone:1", x = 0.5, y = 0.5 } })'), 'nil');
  });

  it('keeps the unverified point and limitations when the bridge history replaces the chat', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    deliver(
      lua,
      'reply',
      `{ status = "answer", text = "Go to Brill", evidenceIds = {}, calculationIds = {}, itemRefs = {},
         approxLocation = { zoneName = "Tirisfal Glades", x = 61.8, y = 51.6, basis = "b", sourceUrl = "u" }, limitations = { "note" } }`,
    );
    const entryId = lua.eval('__FA_NS.Assistant.state.history[1].entryId');
    const conversationId = lua.eval('__FA_NS.Assistant.state.conversationId');
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    packet(
      lua,
      2,
      `{ deliveryId = "${hex('f')}", type = "history", body = { conversationId = "${conversationId}",
         entries = { { entryId = "${entryId}", role = "assistant", text = "Go to Brill", itemRefs = {},
           request = { characterKey = "${ck}", originSessionId = "${origin}", requestId = 1 } } } } }`,
    );
    assert.equal(lua.eval('#__FA_NS.Assistant.state.history'), '1');
    assert.equal(lua.eval('__FA_NS.Assistant.state.history[1].approxLocation.zoneName'), 'Tirisfal Glades');
    assert.equal(lua.eval('__FA_NS.Assistant.state.history[1].limitations[1]'), 'note');
  });
});

describe('inline links in the answer text', () => {
  const ref = (c: string) => c.repeat(32);

  it('renders and selects each verified or approximate location independently', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run(`__FA_NS.Assistant.start()
      MULTI_ENTRY = { entryId = "${ref('7')}", role = "assistant", text = "Visit [[map:1]] and [[map:2]].", locations = {
        { locationRef = { mapKey = "uiMap:1420", title = "First camp", x = 0.61, y = 0.51 } },
        { approxLocation = { title = "Second camp", zoneName = "Elwynn Forest", x = 41, y = 65, basis = "fixture", sourceUrl = "https://example.test/map" } },
        { approxLocation = { title = "Unknown camp", zoneName = "Nowhere", x = 10, y = 20, basis = "fixture", sourceUrl = "https://example.test/map" } }
      } }
      __FA_NS.Assistant.addHistory(MULTI_ENTRY)
      TEST_TEXT, TEST_LINES = __FA_NS.Items.renderEntry(MULTI_ENTRY)`);
    const text = lua.eval('TEST_TEXT');
    assert.ok(text.includes(`|cff66ff66|Hfamap:${ref('7')}:1|h[First camp`), text);
    assert.ok(text.includes(`|cffff9933|Hfamap:${ref('7')}:2|h[Second camp`), text);
    assert.ok(text.includes(`|Hfatrack:${ref('7')}:2|h[Track]`), text);
    assert.equal(lua.eval('#TEST_LINES'), '1');
    assert.match(lua.eval('TEST_LINES[1]'), /Unknown camp.*zone not found/);
    assert.equal(lua.eval(`select(2, __FA_NS.Items.mapEntryId("famap:${ref('7')}:2"))`), '2');
    for (const index of ['0', '-1', '21', 'bad']) assert.equal(lua.eval(`__FA_NS.Items.mapEntryId("famap:${ref('7')}:${index}")`), 'nil');
    lua.run(`__FA_NS.Items.onClick("famap:${ref('7')}:2", "", "LeftButton")`);
    assert.equal(lua.eval('__FA_NS.Map.active.title'), 'Second camp');
    assert.equal(lua.eval('WowStub.worldMap'), '1429');
    lua.run(`__FA_NS.Items.onClick("fatrack:${ref('7')}:1", "", "LeftButton")`);
    assert.equal(lua.eval('__FA_NS.Map.active.title'), 'First camp');
    assert.equal(lua.eval('WowStub.waypoint.uiMapID'), '1420');
    lua.run('MULTI_ENTRY.text = "No inline links"; TEST_TEXT, TEST_LINES = __FA_NS.Items.renderEntry(MULTI_ENTRY)');
    assert.equal(lua.eval('#TEST_LINES'), '3', 'all omitted locations are still listed under the reply');
  });

  it('turns item and map markers into links in place and lists only what the text did not use', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run(`TEST_ENTRY = { entryId = "${ref('9')}", role = "assistant",
      text = "Take [[item:${ref('c')}]] and go to [[map]]. Also [[item:${ref('f')}]] and [[note]].",
      itemRefs = { { refId = "${ref('c')}", itemId = 118 }, { refId = "${ref('d')}", itemId = 7046 } },
      locationRef = { mapKey = "uiMap:1420", title = "Vance Undergloom", x = 0.618, y = 0.516 },
      limitations = { "market_unverified" } }
      TEST_TEXT, TEST_LINES = __FA_NS.Items.renderEntry(TEST_ENTRY)`);
    const text = lua.eval('TEST_TEXT');
    const potion = '|cffffffff|Hitem:118::::::::12:::::::|h[Minor Healing Potion]|h|r';
    const point = `|cff66ff66|Hfamap:${ref('9')}|h[Vance Undergloom (Tirisfal Glades 61.8, 51.6)]|h|r |cff40c0ff|Hfatrack:${ref('9')}|h[Track]|h|r`;
    assert.equal(text, `Take ${potion} and go to ${point}. Also [item] and [[note]].`);
    assert.equal(lua.eval('#TEST_LINES'), '2', 'the map point is inline, so only items and limitations follow');
    assert.equal(lua.eval('TEST_LINES[1]'), '|cffaaaaaaItems:|r |cffffffff|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r');
    assert.equal(lua.eval('TEST_LINES[2]'), '|cff888888- market_unverified|r');
  });

  it('puts the point on its own line when the text has no marker, and keeps text only for an unknown zone', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run(`TEST_TEXT, TEST_LINES = __FA_NS.Items.renderEntry({ entryId = "${ref('8')}", text = "Somewhere far away.",
      approxLocation = { title = "Old Camp", zoneName = "Nowhere", x = 10, y = 20, basis = "b", sourceUrl = "u" } })`);
    assert.equal(lua.eval('TEST_TEXT'), 'Somewhere far away.');
    assert.equal(lua.eval('TEST_LINES[1]'), '|cffaaaaaaMap:|r Old Camp (Nowhere 10.0, 20.0) (zone not found on your map)');
    lua.run(`TEST_POINT = __FA_NS.Map.pointOf({ approxLocation = { title = ${LuaHost.literal('\u0410\u0443\u043a\u0446\u0438\u043e\u043d\u0435\u0440')}, zoneName = "Undercity", x = 66, y = 44, basis = "b", sourceUrl = "u" } })`);
    assert.equal(lua.eval('__FA_NS.Map.label(TEST_POINT)'), 'Undercity 66.0, 44.0', 'a non-Latin title is not shown');
  });
});

describe('client item info for lookup_items', () => {
  it('reads item info and tooltip lines from the client and asks the server for uncached items', () => {
    const hood = '|cff1eff00|Hitem:7046::::::::12:::::::|h[Azure Silk Hood]|h|r';
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    lua.run(`__FA_NS.Assistant.applyPacket({ version = 1, publicationRevision = 1, targetCharacterKey = "${ck}",
      targetDeliverySessionId = "${origin}", acceptedMessageKeys = {},
      deliveries = { { deliveryId = "${'1'.repeat(32)}", type = "price_lookup",
        request = { characterKey = "${ck}", originSessionId = "${origin}", requestId = 1 },
        body = { lookupId = "${'a'.repeat(32)}", itemInfo = true,
          items = { { itemId = 7046, itemLink = ${LuaHost.literal(hood)} }, { itemId = 118 }, { itemId = 99999 } } } } } })`);
    const bytes = lua.eval(`(function()
      for _, item in ipairs(__FA_NS.Outbound.queue) do if item.type == "PRICE_RESULT" then return item.bytes end end
    end)()`);
    const body = PriceResultBody.parse(JSON.parse(bytes).body);
    assert.deepEqual([body.observations.length, body.unavailableReason], [0, 'api_unavailable']);
    const [first, second, third] = body.itemInfo;
    assert.deepEqual(
      { ...first, item: first!.item.itemId },
      {
        item: 7046,
        name: 'Azure Silk Hood',
        quality: 2,
        itemLevel: 22,
        requiredLevel: 17,
        itemType: 'Armor',
        itemSubType: 'Cloth',
        equipSlot: 'INVTYPE_HEAD',
        sellPriceCopper: 512,
        tooltip: ['Azure Silk Hood', 'Head    Cloth', '14 Armor', 'Requires Level 17'],
        unavailableReason: null,
      },
    );
    assert.equal(first!.item.itemLink, hood);
    assert.deepEqual([second!.name, second!.equipSlot, second!.tooltip], ['Minor Healing Potion', null, []]);
    assert.deepEqual([third!.item.itemId, third!.name, third!.unavailableReason], [99999, null, 'not_cached']);
    assert.equal(lua.eval('WowStub.cacheRequests[1]'), '99999');
  });

  it('answers a plain price lookup without item info', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    lua.run('__FA_NS.Assistant.start()');
    const ck = lua.eval('__FA_NS.Assistant.session.characterKey');
    const origin = lua.eval('__FA_NS.Assistant.session.origin');
    lua.run(`__FA_NS.Assistant.applyPacket({ version = 1, publicationRevision = 1, targetCharacterKey = "${ck}",
      targetDeliverySessionId = "${origin}", acceptedMessageKeys = {},
      deliveries = { { deliveryId = "${'2'.repeat(32)}", type = "price_lookup",
        request = { characterKey = "${ck}", originSessionId = "${origin}", requestId = 1 },
        body = { lookupId = "${'b'.repeat(32)}", items = { { itemId = 118 } } } } } })`);
    const bytes = lua.eval(`(function()
      for _, item in ipairs(__FA_NS.Outbound.queue) do if item.type == "PRICE_RESULT" then return item.bytes end end
    end)()`);
    assert.equal('itemInfo' in JSON.parse(bytes).body, false);
  });
});

describe('chat line wrapping', () => {
  // Width counts visible characters; color and link codes take no space.
  const MEASURE = `local function measure(s)
    s = s:gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|cn[%w_]+:", ""):gsub("|H.-|h(.-)|h", "%1"):gsub("|r", "")
    return #s
  end`;
  const wrap = (text: string, width: number) => {
    const lua = new LuaHost();
    lua.loadAddon();
    return JSON.parse(lua.eval(`(function() ${MEASURE}
      return __FA_NS.Json.encode(__FA_NS.Json.array(__FA_NS.Wrap.lines(${LuaHost.literal(text)}, ${width}, measure))) end)()`)) as string[];
  };

  it('breaks words to the width and keeps paragraphs', () => {
    assert.deepEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']);
    assert.deepEqual(wrap('one\n\ntwo  words', 20), ['one', '', 'two  words']);
    assert.deepEqual(wrap('averyveryverylongword x', 5), ['averyveryverylongword', 'x']);
  });

  it('never splits an item link and carries an open color to the next line', () => {
    const link = '|cff1eff00|Hitem:7046::|h[Azure Silk Hood]|h|r';
    assert.deepEqual(wrap(`see ${link} now`, 10), ['see', link, 'now']);
    assert.deepEqual(wrap('|cff888888one two three|r', 7), ['|cff888888one two|r', '|cff888888three|r']);
  });

  it('only splits by newlines without a measure', () => {
    const lua = new LuaHost();
    lua.loadAddon();
    assert.equal(lua.eval('#__FA_NS.Wrap.lines("a b c\\nd", 100, nil)'), '2');
  });
});
