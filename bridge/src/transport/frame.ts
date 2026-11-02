// Outgoing addon frame: 128x24 cells of 4x4 physical pixels,
// three RGB bits per cell; 1152 bytes = 48-byte header + 1..1024-byte fragment + zero padding.
// Also reassembles messages with memory and TTL limits.
import type { InboundMessage } from '../app/router.js';
import type { Clock } from '../clock.js';
import { LIMITS } from '../contracts.js';

export const FRAME = {
  cols: 128,
  rows: 24,
  cellPx: 4,
  offsetPx: 8,
  widthPx: 512,
  heightPx: 96,
  capacity: 1152,
  headerBytes: 48,
  maxFragmentBytes: 1024,
  maxFragments: 128,
  low: 8,
  high: 247,
  /** Channel values < 64 mean 0, > 191 mean 1; other values reject the frame. */
  zeroBelow: 64,
  oneAbove: 191,
} as const;

const MAGIC = [0x46, 0x41, 0x53, 0x31]; // "FAS1"

export function fletcher16(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let a = 0;
  let b = 0;
  for (let i = start; i < end; i++) {
    a = (a + bytes[i]!) % 255;
    b = (b + a) % 255;
  }
  return a + 256 * b;
}

export interface FrameHeader {
  kind: number;
  originSessionId: string;
  messageSequence: number;
  fragmentIndex: number;
  fragmentCount: number;
  fragmentBytes: number;
  messageBytes: number;
}

export function fragmentCountFor(messageBytes: number): number {
  return Math.ceil(messageBytes / FRAME.maxFragmentBytes);
}

/** Build a 1152-byte fragment frame (the addon normally does this; used here for tests and simulation). */
export function encodeFrame(header: Omit<FrameHeader, 'fragmentBytes'>, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(FRAME.capacity);
  const view = new DataView(frame.buffer);
  frame.set(MAGIC, 0);
  frame[4] = 1;
  frame[5] = header.kind;
  view.setUint16(6, FRAME.headerBytes, true);
  frame.set(Buffer.from(header.originSessionId, 'hex'), 8);
  view.setUint32(24, header.messageSequence, true);
  view.setUint16(28, header.fragmentIndex, true);
  view.setUint16(30, header.fragmentCount, true);
  view.setUint16(32, payload.length, true);
  view.setUint32(36, header.messageBytes, true);
  view.setUint16(40, fletcher16(payload), true);
  view.setUint16(42, fletcher16(frame, 0, FRAME.headerBytes), true);
  frame.set(payload, FRAME.headerBytes);
  return frame;
}

export function fragmentMessage(message: InboundMessage): Uint8Array[] {
  const count = fragmentCountFor(message.bytes.length);
  return Array.from({ length: count }, (_, index) =>
    encodeFrame(
      {
        kind: message.kind,
        originSessionId: message.originSessionId,
        messageSequence: message.messageSequence,
        fragmentIndex: index,
        fragmentCount: count,
        messageBytes: message.bytes.length,
      },
      message.bytes.subarray(index * FRAME.maxFragmentBytes, (index + 1) * FRAME.maxFragmentBytes),
    ),
  );
}

export type FrameParse =
  | { ok: true; header: FrameHeader; payload: Uint8Array }
  | { ok: false; reason: 'no_frame' | 'bad_header' | 'header_checksum' | 'fragment_checksum' | 'bad_padding' };

/** Validate magic, enums, lengths, reserved bytes, checksums and padding before allocating a reassembly buffer. */
export function parseFrame(frame: Uint8Array): FrameParse {
  if (frame.length !== FRAME.capacity || MAGIC.some((byte, i) => frame[i] !== byte)) return { ok: false, reason: 'no_frame' };
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const header: FrameHeader = {
    kind: frame[5]!,
    originSessionId: Buffer.from(frame.subarray(8, 24)).toString('hex'),
    messageSequence: view.getUint32(24, true),
    fragmentIndex: view.getUint16(28, true),
    fragmentCount: view.getUint16(30, true),
    fragmentBytes: view.getUint16(32, true),
    messageBytes: view.getUint32(36, true),
  };
  const zeros = (from: number, to: number) => frame.subarray(from, to).every((b) => b === 0);
  const checksum = new Uint8Array(frame.subarray(0, FRAME.headerBytes));
  checksum[42] = 0;
  checksum[43] = 0;
  if (fletcher16(checksum) !== view.getUint16(42, true)) return { ok: false, reason: 'header_checksum' };
  const expectedCount = fragmentCountFor(header.messageBytes);
  const lastBytes = header.messageBytes - (header.fragmentCount - 1) * FRAME.maxFragmentBytes;
  const valid =
    frame[4] === 1 &&
    header.kind >= 1 &&
    header.kind <= 7 &&
    view.getUint16(6, true) === FRAME.headerBytes &&
    zeros(34, 36) &&
    zeros(44, 48) &&
    header.messageSequence >= 1 &&
    header.messageBytes >= 1 &&
    header.messageBytes <= LIMITS.messageBytes &&
    header.fragmentCount >= 1 &&
    header.fragmentCount <= FRAME.maxFragments &&
    header.fragmentCount === expectedCount &&
    header.fragmentIndex < header.fragmentCount &&
    header.fragmentBytes ===
      (header.fragmentIndex < header.fragmentCount - 1 ? FRAME.maxFragmentBytes : lastBytes);
  if (!valid) return { ok: false, reason: 'bad_header' };
  const end = FRAME.headerBytes + header.fragmentBytes;
  const payload = frame.subarray(FRAME.headerBytes, end);
  if (fletcher16(payload) !== view.getUint16(40, true)) return { ok: false, reason: 'fragment_checksum' };
  if (!zeros(end, FRAME.capacity)) return { ok: false, reason: 'bad_padding' };
  return { ok: true, header, payload: new Uint8Array(payload) };
}

// ---------------------------------------------------------------------------
// Pixels: visit cells left to right, top to bottom; channels R, G, B; most significant bit first.

/** Render a frame as a 512x96 RGB image for tests and capture checks. */
export function framePixels(frame: Uint8Array): Uint8Array {
  const { cols, rows, cellPx, widthPx, heightPx, low, high } = FRAME;
  const rgb = new Uint8Array(widthPx * heightPx * 3);
  for (let cell = 0; cell < cols * rows; cell++) {
    const cx = (cell % cols) * cellPx;
    const cy = Math.floor(cell / cols) * cellPx;
    for (let channel = 0; channel < 3; channel++) {
      const bit = cell * 3 + channel;
      const on = (frame[bit >> 3]! >> (7 - (bit & 7))) & 1;
      for (let y = 0; y < cellPx; y++) {
        for (let x = 0; x < cellPx; x++) rgb[((cy + y) * widthPx + cx + x) * 3 + channel] = on ? high : low;
      }
    }
  }
  return rgb;
}

export type PixelDecode =
  | { ok: true; frame: Uint8Array }
  | { ok: false; reason: 'too_small' | 'no_frame' | 'ambiguous_pixel' | 'pixel_disagreement' };

/**
 * Read a frame from an RGB image: (originX, originY) is the field's top-left corner
 * in the image. Read the central 2x2 square of each cell.
 */
export function decodePixels(rgb: Uint8Array, width: number, height: number, originX = 0, originY = 0): PixelDecode {
  const { cols, rows, cellPx, capacity, zeroBelow, oneAbove } = FRAME;
  if (originX + cols * cellPx > width || originY + rows * cellPx > height || rgb.length < width * height * 3) {
    return { ok: false, reason: 'too_small' };
  }
  const frame = new Uint8Array(capacity);
  const readCell = (cell: number): number | 'ambiguous' | 'disagree' => {
    const x0 = originX + (cell % cols) * cellPx + 1;
    const y0 = originY + Math.floor(cell / cols) * cellPx + 1;
    let value = 0;
    for (let channel = 0; channel < 3; channel++) {
      let bit = -1;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const v = rgb[((y0 + dy) * width + x0 + dx) * 3 + channel]!;
          const b = v < zeroBelow ? 0 : v > oneAbove ? 1 : -2;
          if (b === -2) return 'ambiguous';
          if (bit === -1) bit = b;
          else if (bit !== b) return 'disagree';
        }
      }
      value = (value << 1) | bit;
    }
    return value;
  };
  const write = (cell: number, value: number) => {
    for (let channel = 0; channel < 3; channel++) {
      if ((value >> (2 - channel)) & 1) {
        const bit = cell * 3 + channel;
        frame[bit >> 3]! |= 1 << (7 - (bit & 7));
      }
    }
  };
  // Check magic first (the first 11 cells): the field is hidden while idle, which is not an error.
  const magicCells = Math.ceil(32 / 3);
  for (let cell = 0; cell < cols * rows; cell++) {
    const value = readCell(cell);
    if (typeof value !== 'number') {
      if (cell < magicCells) return { ok: false, reason: 'no_frame' };
      return { ok: false, reason: value === 'ambiguous' ? 'ambiguous_pixel' : 'pixel_disagreement' };
    }
    write(cell, value);
    if (cell === magicCells - 1 && MAGIC.some((byte, i) => frame[i] !== byte)) return { ok: false, reason: 'no_frame' };
  }
  return { ok: true, frame };
}

// ---------------------------------------------------------------------------
// Message reassembly

export interface ReassemblerLimits {
  maxMessages: number;
  maxBytes: number;
  ttlMs: number;
}

export const DEFAULT_REASSEMBLER_LIMITS: ReassemblerLimits = { maxMessages: 8, maxBytes: 1 << 20, ttlMs: 300_000 };

interface Partial {
  kind: number;
  messageBytes: number;
  fragmentCount: number;
  fragments: (Uint8Array | undefined)[];
  received: number;
  lastNewAt: number;
}

export type AssembleResult =
  | { status: 'incomplete' | 'repeat' }
  | { status: 'complete'; message: InboundMessage }
  | { status: 'conflict' | 'overflow' };

export class Reassembler {
  private readonly partials = new Map<string, Partial>();

  constructor(
    private readonly clock: Clock,
    private readonly limits: ReassemblerLimits = DEFAULT_REASSEMBLER_LIMITS,
  ) {}

  get pendingCount(): number {
    return this.partials.size;
  }

  get pendingBytes(): number {
    let total = 0;
    for (const p of this.partials.values()) total += p.messageBytes;
    return total;
  }

  /** Remove messages with no new valid fragment within TTL; duplicates do not extend it. */
  expire(): number {
    const now = this.clock.now();
    let removed = 0;
    for (const [key, partial] of this.partials) {
      if (now - partial.lastNewAt > this.limits.ttlMs) {
        this.partials.delete(key);
        removed++;
      }
    }
    return removed;
  }

  add(header: FrameHeader, payload: Uint8Array): AssembleResult {
    this.expire();
    const now = this.clock.now();
    const key = `${header.originSessionId}:${header.messageSequence}`;
    let partial = this.partials.get(key);
    if (partial) {
      if (
        partial.kind !== header.kind ||
        partial.messageBytes !== header.messageBytes ||
        partial.fragmentCount !== header.fragmentCount
      ) {
        this.partials.delete(key);
        return { status: 'conflict' };
      }
    } else if (header.fragmentCount > 1) {
      if (this.partials.size >= this.limits.maxMessages || this.pendingBytes + header.messageBytes > this.limits.maxBytes) {
        return { status: 'overflow' };
      }
      partial = {
        kind: header.kind,
        messageBytes: header.messageBytes,
        fragmentCount: header.fragmentCount,
        fragments: new Array(header.fragmentCount),
        received: 0,
        lastNewAt: now,
      };
      this.partials.set(key, partial);
    } else {
      return { status: 'complete', message: this.message(header, payload) };
    }

    const existing = partial.fragments[header.fragmentIndex];
    if (existing) {
      if (Buffer.compare(existing, payload) !== 0) {
        this.partials.delete(key);
        return { status: 'conflict' };
      }
      return { status: 'repeat' };
    }
    partial.fragments[header.fragmentIndex] = payload;
    partial.received++;
    partial.lastNewAt = now;
    if (partial.received < partial.fragmentCount) return { status: 'incomplete' };
    this.partials.delete(key);
    return { status: 'complete', message: this.message(header, Buffer.concat(partial.fragments as Uint8Array[])) };
  }

  private message(header: FrameHeader, bytes: Uint8Array): InboundMessage {
    return {
      kind: header.kind,
      originSessionId: header.originSessionId,
      messageSequence: header.messageSequence,
      bytes: new Uint8Array(bytes),
    };
  }
}
