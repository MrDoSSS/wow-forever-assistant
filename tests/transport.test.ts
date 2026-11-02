import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { parseCaptureLine, runCaptureScript } from '../bridge/src/transport/capture.js';
import { DeliveryPublisher, SlotPool, slotName, type PoolWriter } from '../bridge/src/transport/delivery.js';
import {
  decodePixels,
  fletcher16,
  FRAME,
  fragmentMessage,
  framePixels,
  parseFrame,
  Reassembler,
} from '../bridge/src/transport/frame.js';
import { FrameReceiver } from '../bridge/src/transport/receiver.js';
import { configLua, installKit, InstallError } from '../tools/install.js';
import { AddonSession, answer, FakeClock, harness, identity, tempDir } from './fakes.js';
import { readInbox } from './lua-reader.js';

const ORIGIN = '0123456789abcdef0123456789abcdef';
const bytesOf = (text: string) => new TextEncoder().encode(text);

function frameFor(text: string, sequence = 1, kind = 2) {
  return fragmentMessage({ kind, originSessionId: ORIGIN, messageSequence: sequence, bytes: bytesOf(text) });
}

describe('frame codec', () => {
  it('uses Fletcher-16 as specified (reference vectors)', () => {
    assert.equal(fletcher16(bytesOf('abcde')), 0xc8f0);
    assert.equal(fletcher16(bytesOf('abcdef')), 0x2057);
    assert.equal(fletcher16(bytesOf('abcdefgh')), 0x0627);
  });

  it('round-trips header fields and payload', () => {
    const [frame] = frameFor('{"a":1}', 77);
    const parsed = parseFrame(frame!);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.ok && parsed.header, {
      kind: 2,
      originSessionId: ORIGIN,
      messageSequence: 77,
      fragmentIndex: 0,
      fragmentCount: 1,
      fragmentBytes: 7,
      messageBytes: 7,
    });
  });

  it('rejects damaged checksums, reserved bytes, unknown kinds, wrong counts and dirty padding', () => {
    const [frame] = frameFor('{"a":1}');
    const damaged = (mutate: (f: Uint8Array) => void) => {
      const copy = new Uint8Array(frame!);
      mutate(copy);
      return parseFrame(copy);
    };
    assert.deepEqual(damaged((f) => (f[48] = 0x30)), { ok: false, reason: 'fragment_checksum' });
    assert.deepEqual(damaged((f) => (f[25] = f[25]! ^ 1)), { ok: false, reason: 'header_checksum' });
    assert.deepEqual(damaged((f) => (f[0] = 0)), { ok: false, reason: 'no_frame' });
    assert.deepEqual(damaged((f) => (f[100] = 1)), { ok: false, reason: 'bad_padding' });
    const withHeader = (mutate: (f: Uint8Array) => void) =>
      damaged((f) => {
        mutate(f);
        const check = new Uint8Array(f.subarray(0, 48));
        check[42] = 0;
        check[43] = 0;
        new DataView(f.buffer).setUint16(42, fletcher16(check), true);
      });
    assert.deepEqual(withHeader((f) => (f[34] = 1)), { ok: false, reason: 'bad_header' });
    assert.deepEqual(withHeader((f) => (f[5] = 8)), { ok: false, reason: 'bad_header' });
    assert.deepEqual(withHeader((f) => (f[30] = 2)), { ok: false, reason: 'bad_header' });
  });

  it('decodes pixels and rejects intermediate or disagreeing values', () => {
    const [frame] = frameFor('{"text":"\u041f\u0440\u0438\u0432\u0435\u0442"}');
    const rgb = framePixels(frame!);
    const decoded = decodePixels(rgb, FRAME.widthPx, FRAME.heightPx);
    assert.ok(decoded.ok && Buffer.compare(decoded.frame, frame!) === 0);

    const ambiguous = new Uint8Array(rgb);
    ambiguous[(50 * FRAME.widthPx + 101) * 3] = 128;
    assert.deepEqual(decodePixels(ambiguous, FRAME.widthPx, FRAME.heightPx), { ok: false, reason: 'ambiguous_pixel' });
    const disagree = new Uint8Array(rgb);
    const at = (50 * FRAME.widthPx + 102) * 3;
    disagree[at] = disagree[at] === FRAME.high ? FRAME.low : FRAME.high;
    assert.deepEqual(decodePixels(disagree, FRAME.widthPx, FRAME.heightPx), { ok: false, reason: 'pixel_disagreement' });
    // Hidden field: game scenery occupies its location, which is not a transport error.
    const scene = new Uint8Array(rgb.length).fill(120);
    assert.deepEqual(decodePixels(scene, FRAME.widthPx, FRAME.heightPx), { ok: false, reason: 'no_frame' });
    // Cell borders are not read; blurred borders are allowed.
    const blurred = new Uint8Array(rgb);
    blurred[0] = 128;
    assert.ok(decodePixels(blurred, FRAME.widthPx, FRAME.heightPx).ok);
  });
});

describe('reassembler', () => {
  const header = (frame: Uint8Array) => {
    const parsed = parseFrame(frame);
    assert.ok(parsed.ok);
    return parsed as Extract<ReturnType<typeof parseFrame>, { ok: true }>;
  };

  it('assembles out-of-order fragments with Russian UTF-8 split at the boundary', () => {
    const text = JSON.stringify({ text: `${'a'.repeat(1012)}${'\u0451'.repeat(800)}` });
    const frames = frameFor(text);
    assert.equal(frames.length, 3);
    const r = new Reassembler(new FakeClock());
    const order = [2, 0, 0, 1];
    const results = order.map((i) => {
      const { header: h, payload } = header(frames[i]!);
      return r.add(h, payload);
    });
    assert.deepEqual(results.slice(0, 3).map((x) => x.status), ['incomplete', 'incomplete', 'repeat']);
    const done = results[3]!;
    assert.equal(done.status, 'complete');
    assert.equal(done.status === 'complete' && new TextDecoder('utf-8', { fatal: true }).decode(done.message.bytes), text);
  });

  it('drops a message on conflicting fragment bytes or metadata', () => {
    const r = new Reassembler(new FakeClock());
    const a = frameFor(`{"t":"${'x'.repeat(1500)}"}`, 5);
    const b = frameFor(`{"t":"${'y'.repeat(1500)}"}`, 5);
    const first = header(a[0]!);
    assert.equal(r.add(first.header, first.payload).status, 'incomplete');
    const other = header(b[0]!);
    assert.equal(r.add(other.header, other.payload).status, 'conflict');
    assert.equal(r.pendingCount, 0);
    const longer = frameFor(`{"t":"${'x'.repeat(2500)}"}`, 5);
    r.add(first.header, first.payload);
    const meta = header(longer[1]!);
    assert.equal(r.add(meta.header, meta.payload).status, 'conflict');
  });

  it('limits incomplete messages to 8 and 1 MiB', () => {
    const r = new Reassembler(new FakeClock());
    for (let seq = 1; seq <= 8; seq++) {
      const f = header(frameFor(`{"t":"${'x'.repeat(1500)}"}`, seq)[0]!);
      assert.equal(r.add(f.header, f.payload).status, 'incomplete');
    }
    const ninth = header(frameFor(`{"t":"${'x'.repeat(1500)}"}`, 9)[0]!);
    assert.equal(r.add(ninth.header, ninth.payload).status, 'overflow');

    const big = new Reassembler(new FakeClock(), { maxMessages: 8, maxBytes: 200_000, ttlMs: 300_000 });
    const huge = (seq: number) => header(frameFor(`{"t":"${'x'.repeat(120_000)}"}`, seq)[0]!);
    assert.equal(big.add(huge(1).header, huge(1).payload).status, 'incomplete');
    assert.equal(big.add(huge(2).header, huge(2).payload).status, 'overflow');
  });

  it('expires after 300 s without a new fragment; repeats do not extend TTL', () => {
    const clock = new FakeClock();
    const r = new Reassembler(clock);
    const frames = frameFor(`{"t":"${'x'.repeat(1500)}"}`);
    const first = header(frames[0]!);
    r.add(first.header, first.payload);
    clock.advance(200_000);
    assert.equal(r.add(first.header, first.payload).status, 'repeat');
    clock.advance(100_001);
    const second = header(frames[1]!);
    assert.equal(r.add(second.header, second.payload).status, 'incomplete');
    assert.equal(r.pendingCount, 1);
  });

  it('feeds complete messages from images to the bridge', () => {
    const h = harness();
    const addon = new AddonSession(identity());
    const receiver = new FrameReceiver({ receive: (m) => h.bridge.receive(m), clock: h.clock, diag: h.diag });
    const message = addon.hello();
    const results = fragmentMessage(message).map((frame) =>
      receiver.onImage({ at: 0, width: FRAME.widthPx, height: FRAME.heightPx, rgb: framePixels(frame) }),
    );
    assert.equal(results.at(-1)?.status, 'accepted');
    assert.equal(receiver.stats.messages, 1);
  });
});

describe('LoD pool and publication', () => {
  function setup() {
    const h = harness();
    const addonsDir = join(h.dir, 'AddOns');
    mkdirSync(addonsDir);
    installKit({ addonsDir, serverNamespace: 'forever-test', slotCount: 200 });
    const pool = new SlotPool(addonsDir);
    const publisher = new DeliveryPublisher({ store: h.store, pool, clock: h.clock, diag: h.diag });
    return { h, addonsDir, pool, publisher };
  }
  const inbox = (dir: string, slot = 1) => readFileSync(join(dir, slotName(slot), 'Inbox.lua'), 'utf8');

  it('writes the same packet into every slot and skips unchanged publications', async () => {
    const { h, addonsDir, publisher } = setup();
    assert.deepEqual(publisher.publishNow(), { status: 'skipped', reason: 'no_target' });
    const addon = new AddonSession(identity());
    h.bridge.receive(addon.hello());
    const result = publisher.publishNow();
    assert.equal(result.status, 'published');
    assert.equal(result.status === 'published' && result.report.pool.written, 200);
    assert.equal(inbox(addonsDir, 1), inbox(addonsDir, 200));
    const packet = readInbox(inbox(addonsDir)) as Record<string, unknown>;
    assert.equal(packet.publicationRevision, 1);
    assert.equal(packet.targetCharacterKey, addon.characterKey);
    assert.equal((packet.acceptedMessageKeys as unknown[]).length, 1);
    assert.deepEqual((packet.deliveries as { type: string }[]).map((d) => d.type), ['hello', 'history']);
    assert.deepEqual(publisher.publishNow(), { status: 'skipped', reason: 'unchanged' });

    const { message } = addon.query('Question');
    h.bridge.receive(message);
    h.model.reply(answer());
    await h.bridge.scheduler.idle();
    const next = publisher.publishNow();
    assert.equal(next.status === 'published' && next.report.revision, 2);
    assert.equal((readInbox(inbox(addonsDir)) as { deliveries: unknown[] }).deliveries.length, 3);
  });

  it('does not rewrite the pool when an already acknowledged message is repeated', () => {
    const { h, publisher } = setup();
    const addon = new AddonSession(identity());
    const hello = addon.hello();
    h.bridge.receive(hello);
    h.bridge.receive(addon.receipts([randomId()]));
    assert.equal(publisher.publishNow().status, 'published');
    for (const message of [hello, hello]) {
      h.clock.advance(500);
      assert.equal(h.bridge.receive(message).status, 'duplicate');
      assert.deepEqual(publisher.publishNow(), { status: 'skipped', reason: 'unchanged' });
    }
  });

  it('keeps deliveries pending when a slot cannot be replaced and retries the whole pool', () => {
    const { h, addonsDir, publisher } = setup();
    const addon = new AddonSession(identity());
    h.bridge.receive(addon.hello());
    // The game client holds a slot open, so replacing its file fails.
    const failing: PoolWriter = {
      write: (content) => {
        const report = new SlotPool(addonsDir).write(content);
        report.failed.push({ slot: slotName(7), error: 'EPERM' });
        return report;
      },
    };
    const flaky = new DeliveryPublisher({ store: h.store, pool: failing, clock: h.clock, diag: h.diag });
    assert.deepEqual(flaky.publishNow(), { status: 'failed', reason: 'pool_write' });
    assert.equal(h.store.listPendingDeliveries(addon.characterKey, addon.originSessionId).length, 2);
    // The next publication is not considered unchanged; rewrite the pool again.
    assert.equal(publisher.publishNow().status, 'published');
    assert.match(inbox(addonsDir, 7), /^ForeverAssistantInbox=/);
  });

  it('keeps every packet within 256 KiB and 100 deliveries; the rest stays queued', () => {
    const { h, addonsDir, publisher } = setup();
    const addon = new AddonSession(identity());
    h.bridge.receive(addon.hello());
    h.store.transaction('fill', () => {
      for (let i = 0; i < 150; i++) {
        h.bridge.outbox.create({
          characterKey: addon.characterKey,
          conversationId: addon.conversationId,
          fallbackTarget: addon.originSessionId,
          now: h.clock.now(),
          draft: { type: 'error', request: null, body: { code: 'history_changed', text: '\u044f'.repeat(500) } },
        });
      }
    });
    publisher.publishNow();
    const content = inbox(addonsDir);
    assert.ok(Buffer.byteLength(content) <= 256 * 1024);
    assert.equal((readInbox(content) as { deliveries: unknown[] }).deliveries.length, 100);
    assert.equal(h.store.listPendingDeliveries(addon.characterKey, addon.originSessionId).length, 152);
  });

  it('reports missing and foreign slots before writing', () => {
    const dir = tempDir();
    const pool = new SlotPool(dir, 3);
    assert.deepEqual(pool.check(), { ok: false, missing: [slotName(1), slotName(2), slotName(3)], foreign: [] });
    installKit({ addonsDir: dir, serverNamespace: 'x', slotCount: 3 });
    writeFileSync(join(dir, slotName(2), `${slotName(2)}.toc`), '## Interface: 16001\n');
    assert.deepEqual(pool.check(), { ok: false, missing: [], foreign: [slotName(2)] });
  });
});

describe('installer', () => {
  it('installs the addon, Config.lua and 200 LoD slots', () => {
    const dir = tempDir();
    const report = installKit({ addonsDir: dir, serverNamespace: 'wow-forever "\u0442\u0435\u0441\u0442"' });
    assert.equal(report.slotsWritten, 200);
    assert.deepEqual(report.slotsForeign, []);
    const toc = readFileSync(join(dir, slotName(200), `${slotName(200)}.toc`), 'utf8');
    assert.match(toc, /## LoadOnDemand: 1/);
    assert.match(toc, /## Dependencies: ForeverAssistant/);
    assert.match(toc, /## Interface: 16001/);
    assert.equal(readFileSync(join(dir, 'ForeverAssistant', 'Config.lua'), 'utf8'), configLua('wow-forever "\u0442\u0435\u0441\u0442"', 200));
    assert.ok(existsSync(join(dir, 'ForeverAssistant', 'Transport', 'Codec.lua')));
    for (const file of ['NotoSans-Regular.ttf', 'OFL.txt']) {
      assert.deepEqual(
        readFileSync(join(dir, 'ForeverAssistant', 'Fonts', file)),
        readFileSync(resourcePath('addon', 'ForeverAssistant', 'Fonts', file)),
      );
    }
    // Reinstalling must preserve a slot's published packet.
    writeFileSync(join(dir, slotName(1), 'Inbox.lua'), 'ForeverAssistantInbox={}\n');
    installKit({ addonsDir: dir, serverNamespace: 'wow-forever' });
    assert.equal(readFileSync(join(dir, slotName(1), 'Inbox.lua'), 'utf8'), 'ForeverAssistantInbox={}\n');
  });

  it('never overwrites folders without our markers', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'ForeverAssistant'));
    writeFileSync(join(dir, 'ForeverAssistant', 'ForeverAssistant.toc'), '## Title: Someone else\n');
    assert.throws(() => installKit({ addonsDir: dir, serverNamespace: 'x' }), InstallError);

    const other = tempDir();
    mkdirSync(join(other, slotName(5)));
    const report = installKit({ addonsDir: other, serverNamespace: 'x' });
    assert.deepEqual(report.slotsForeign, [slotName(5)]);
    assert.equal(report.slotsWritten, 199);
  });

  it('copies exactly the files listed in the addon TOC', () => {
    const toc = readFileSync(resourcePath('addon', 'ForeverAssistant', 'ForeverAssistant.toc'), 'utf8');
    const files = toc.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    for (const file of files) assert.ok(existsSync(resourcePath('addon', 'ForeverAssistant', ...file.split('\\'))), file);
  });
});

describe('capture adapter', () => {
  it('validates capture.ps1 output lines', () => {
    const rgb = Buffer.alloc(2 * 1 * 3, 7).toString('base64');
    assert.deepEqual(parseCaptureLine('{"type":"status","code":"minimized","detail":""}'), {
      kind: 'status',
      code: 'minimized',
      detail: '',
    });
    const frame = parseCaptureLine(`{"type":"frame","at":5,"width":2,"height":1,"rgb":"${rgb}"}`);
    assert.equal(frame?.kind, 'frame');
    assert.equal(parseCaptureLine(`{"type":"frame","at":5,"width":3,"height":1,"rgb":"${rgb}"}`), null);
    assert.equal(parseCaptureLine('{"type":"status","code":"exploded","detail":""}'), null);
    assert.equal(parseCaptureLine('not json'), null);
  });

  const windows = process.platform === 'win32';

  it('reports a missing game process', { skip: !windows }, async () => {
    const result = await runCaptureScript('powershell.exe', resourcePath('bridge', 'capture.ps1'), [
      '-ProcessName',
      `NoSuchProcess${randomId().slice(0, 8)}`,
      '-Once',
    ]);
    assert.equal(result.status, 'process_not_found');
    assert.equal(result.image, null);
  });

  // Display a window for about one second, only on explicit request.
  it('captures a frame drawn in a real window', { skip: !windows || process.env.FA_CAPTURE_SELFTEST !== '1' }, async () => {
    const [frame] = frameFor('{"text":"\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0437\u0430\u0445\u0432\u0430\u0442\u0430"}');
    const file = join(tempDir(), 'field.rgb');
    writeFileSync(file, framePixels(frame!));
    const result = await runCaptureScript('powershell.exe', resourcePath('bridge', 'capture.ps1'), ['-SelfTestRgbFile', file]);
    assert.equal(result.status, 'ok');
    const decoded = decodePixels(result.image!.rgb, result.image!.width, result.image!.height);
    assert.ok(decoded.ok && Buffer.compare(decoded.frame, frame!) === 0);
  });
});
