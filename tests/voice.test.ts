import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MemoryDiagnostics } from '../bridge/src/diagnostics.js';
import { buildInboxLua } from '../bridge/src/transport/packet.js';
import { fletcher16, fragmentMessage } from '../bridge/src/transport/frame.js';
import { FrameReceiver } from '../bridge/src/transport/receiver.js';
import { inboxJson, readLuaData } from '../bridge/src/transport/lua-data.js';
import { toLuaLiteral } from '../bridge/src/transport/lua.js';
import { SilentVoiceTransport } from '../bridge/src/transport/voice.js';
import { FakeClock, tempDir } from './fakes.js';
import { LuaHost } from './lua-host.js';

const origin = '1234567890abcdef1234567890abcdef';
const header = { publicationRevision: 7, targetCharacterKey: 'a'.repeat(64), targetDeliverySessionId: origin, acceptedMessageKeys: [] };

describe('silent voice transport', () => {
  it('filters only assistant playback cues while preserving normal narration events and settings', () => {
    const lua = new LuaHost({ nativeBit: true });
    lua.loadAddon();
    lua.run(`
      ForeverAssistantConfig.transport="silent_voice"
      TextToSpeechFrame=CreateFrame("Frame")
      WowStub.ttsEvents={}
      TextToSpeechFrame:SetScript("OnEvent",function(_,event,id) table.insert(WowStub.ttsEvents,event..":"..tostring(id)) end)
      __FA_NS.Voice.installTtsFilter()
      __FA_NS.Voice.onBookmark("FAV2:OFFLINE",42)
      local handler=TextToSpeechFrame:GetScript("OnEvent")
      handler(TextToSpeechFrame,"VOICE_CHAT_TTS_PLAYBACK_FINISHED",42)
      handler(TextToSpeechFrame,"VOICE_CHAT_TTS_PLAYBACK_FAILED",42)
      assert(#WowStub.ttsEvents==0)
      handler(TextToSpeechFrame,"VOICE_CHAT_TTS_PLAYBACK_FINISHED",43)
      handler(TextToSpeechFrame,"SOME_OTHER_EVENT",42)
      assert(#WowStub.ttsEvents==2)
      WowStub.time=1061
      handler(TextToSpeechFrame,"VOICE_CHAT_TTS_PLAYBACK_FINISHED",42)
      assert(#WowStub.ttsEvents==3)
      ForeverAssistantConfig.transport="pixels"
      WowStub.time=1001
      handler(TextToSpeechFrame,"VOICE_CHAT_TTS_PLAYBACK_FINISHED",42)
      assert(#WowStub.ttsEvents==4)
    `);
    assert.equal(lua.eval('__FA_NS.Voice.stats.suppressedCues'), '2');
  });
  it('converts only generated Lua data, including UTF-8 and escaped controls', () => {
    const data = { text: 'Друид 🐻\n"\\\u0000\u001f', empty: [], nested: [{ n: 1.25e-12, bool: false }], ['and']: 'key' };
    assert.deepEqual(JSON.parse(JSON.stringify(readLuaData(toLuaLiteral(data)))), data);
    for (const invalid of ['{x=function()end}', '{"missing}', '{x=1,x=2}', '{1,x=2}', '"\\999"', '1e309', '{};os.execute("x")']) {
      assert.throws(() => readLuaData(invalid), invalid);
    }
  });

  it('authenticates requests, reassembles checked frames and returns session-bound chunks', async () => {
    const clock = new FakeClock(), diag = new MemoryDiagnostics(clock);
    let received: Uint8Array | undefined;
    const receiver = new FrameReceiver({ clock, diag, receive: (message) => { received = message.bytes; return { status: 'ignored', reason: 'test' } as never; } });
    const directory = tempDir();
    const sharedConfigPath = join(directory, 'voice-shared.txt');
    const transport = new SilentVoiceTransport({ dataDir: directory, diag, port: 0, sharedConfigPath });
    const port = transport.start((frame) => receiver.onFrame(frame));
    const [, token] = readFileSync(join(directory, 'voice-transport.txt'), 'utf8').trimEnd().split('\n');
    assert.equal(readFileSync(sharedConfigPath, 'utf8'), readFileSync(join(directory, 'voice-transport.txt'), 'utf8'));
    const url = `http://127.0.0.1:${port}/voice`;
    const post = (body: string, headers: Record<string, string> = { 'X-Forever-Voice-Token': token! }) => fetch(url, { method: 'POST', headers, body });
    try {
      assert.equal((await post(`FAV2:${origin}:0:0:0:`, {})).status, 403);
      assert.equal((await post(`FAV2:${origin}:0:0:0:`, { 'X-Forever-Voice-Token': token!, Origin: 'http://example.com' })).status, 403);
      assert.equal((await post('garbage')).status, 400);
      assert.equal((await post(`FAV2:${origin}:0:0:0::123`)).status, 200);
      const message = { kind: 2, originSessionId: origin, messageSequence: 5, bytes: new TextEncoder().encode('x'.repeat(2000)) };
      for (const frame of fragmentMessage(message)) assert.equal((await post(`FAV2:${origin}:0:0:0:${Buffer.from(frame).toString('hex')}`)).status, 200);
      assert.deepEqual(received, message.bytes);
      const content = buildInboxLua(header, [toLuaLiteral({ deliveryId: 'abc', type: 'test', body: { text: 'Кошка '.repeat(2000) } })]);
      assert.equal(transport.write(content).failed.length, 0);
      const foreign = await (await post(`FAV2:${'f'.repeat(32)}:0:0:0:`)).text();
      assert.ok(foreign.startsWith('FAV2:OK:'));
      const parts: Buffer[] = [];
      let next = 0, count = 1;
      while (next < count) {
        const marks = (await (await post(`FAV2:${origin}:0:7:${next}:`)).text()).trim().split('\n');
        for (const mark of marks) {
          const fields = mark.split(':');
          assert.equal(fields[2], origin); assert.equal(fields[3], '7');
          const index = Number(fields[4]); count = Number(fields[5]);
          parts[index] = Buffer.from(fields[8]!, 'hex'); next = index + 1;
        }
      }
      assert.equal(Buffer.concat(parts).toString('utf8'), inboxJson(content));
      assert.ok((await (await post(`FAV2:${origin}:7:0:0:`)).text()).startsWith(`FAV2:OK:${origin}:7`));
      assert.equal(transport.write('arbitrary Lua').failed.length, 1);
    } finally { transport.stop(); }
    assert.equal(existsSync(sharedConfigPath), false);
    assert.equal(existsSync(join(directory, 'voice-transport.txt')), false);
  });

  it('uses the silent channel without creating pixels or loading delivery slots, including offline retries', () => {
    const lua = new LuaHost({ nativeBit: true });
    lua.loadAddon();
    lua.run(`
      ForeverAssistantConfig.transport = "silent_voice"
      WowStub.voiceCalls = {}
      C_VoiceChat = {
        GetTtsVoices = function() return {{name="Forever Assistant Silent Bridge 3",voiceID=77}} end,
        SpeakText = function(id,text) assert(id==77); table.insert(WowStub.voiceCalls,text) end,
      }
      C_EncodingUtil = { DeserializeJSON = function(text) WowStub.decodedJson=text; return WowStub.voicePacket end }
      __FA_NS.Assistant.start()
      __FA_NS.tick(1000)
    `);
    const command = lua.eval('WowStub.voiceCalls[1]');
    assert.ok(command.startsWith('FAV2:'));
    const wire = Buffer.from(command.split(':')[5]!, 'hex');
    assert.equal(wire.toString('ascii', 0, 4), 'FAS1');
    assert.equal(lua.eval('ForeverAssistantField == nil'), 'true');
    const packet = { version: 1, ...header, targetCharacterKey: lua.eval('__FA_NS.Assistant.session.characterKey'), targetDeliverySessionId: lua.eval('__FA_NS.Assistant.session.origin'), deliveries: [] };
    const json = JSON.stringify(packet), bytes = Buffer.from(json), sum = fletcher16(bytes);
    lua.run(`WowStub.voicePacket=${toLuaLiteral(packet)}`);
    for (let i = Math.ceil(bytes.length / 512) - 1; i >= 0; i--) {
      const mark = `FAV2:DATA:${packet.targetDeliverySessionId}:7:${i}:${Math.ceil(bytes.length / 512)}:${bytes.length}:${sum}:${bytes.subarray(i * 512, (i + 1) * 512).toString('hex')}`;
      lua.run(`__FA_NS.Voice.onBookmark(${LuaHost.literal(mark)})`);
    }
    assert.equal(lua.eval('WowStub.decodedJson'), json);
    assert.equal(lua.eval('__FA_NS.Assistant.session.lastRevision'), '7');
    assert.equal(lua.eval('#WowStub.loads'), '0');
    lua.run('__FA_NS.Voice.onBookmark("FAV2:OFFLINE"); WowStub.time=1003; __FA_NS.tick(1003)');
    assert.equal(lua.eval('#WowStub.voiceCalls'), '2');
    assert.equal(lua.eval('ForeverAssistantField == nil'), 'true');
    assert.equal(lua.eval('__FA_NS.Voice.stats.packets'), '1');
    lua.run(`__FA_NS.Outbound.queue={}; __FA_NS.Inbound.stop(); __FA_NS.Voice.inflight=nil; WowStub.time=1006; __FA_NS.tick(1006)`);
    const firstIdle = lua.eval('WowStub.voiceCalls[#WowStub.voiceCalls]');
    assert.match(firstIdle, /::[0-9]+$/);
    lua.run(`__FA_NS.Voice.onBookmark("FAV2:OK:${packet.targetDeliverySessionId}:7"); WowStub.time=1008; __FA_NS.tick(1008)`);
    const secondIdle = lua.eval('WowStub.voiceCalls[#WowStub.voiceCalls]');
    assert.notEqual(secondIdle, firstIdle, 'idle polls must stay active and unique');
    const stale = `FAV2:DATA:${packet.targetDeliverySessionId}:7:0:1:1:0:00`;
    lua.run(`__FA_NS.Voice.onBookmark(${LuaHost.literal(stale)})`);
    assert.equal(lua.eval('__FA_NS.Voice.inflight == nil'), 'true', 'stale replies still release a poll');
  });
});
