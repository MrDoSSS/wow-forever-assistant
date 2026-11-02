// Tool IPC frames: 4-byte unsigned little-endian length followed by
// UTF-8 JSON, up to 128 KiB. Shared by the bridge and MCP proxy.
import { LIMITS } from '../contracts.js';

export function pipeNameFor(attemptId: string): string {
  return `\\\\.\\pipe\\ForeverAssistant-${attemptId}`;
}

export function encodeIpcFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > LIMITS.ipcFrameBytes) throw new Error(`IPC frame is ${body.length} bytes`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export type FrameEvent = { kind: 'message'; value: unknown } | { kind: 'error'; reason: 'too_large' | 'bad_json' };

/** Frame reader for a stream: invalid length or JSON is a connection error. */
export class IpcFrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): FrameEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: FrameEvent[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > LIMITS.ipcFrameBytes) return [...events, { kind: 'error', reason: 'too_large' }];
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        events.push({ kind: 'message', value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) });
      } catch {
        return [...events, { kind: 'error', reason: 'bad_json' }];
      }
    }
    return events;
  }
}
