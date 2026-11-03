// SAPI is the only client-facing channel. A per-installation capability protects
// the loopback HTTP hop from the registered silent voice to this process.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostics } from '../diagnostics.js';
import type { PoolWriteReport, PoolWriter } from './delivery.js';
import { fletcher16, FRAME } from './frame.js';
import { inboxJson } from './lua-data.js';

export const VOICE_CHUNK_BYTES = 512;
export const VOICE_BATCH = 8;
export const VOICE_MAX_BYTES = 524288;
interface Publication { origin: string; revision: number; length: number; checksum: number; chunks: string[] }

export class SilentVoiceTransport implements PoolWriter {
  private server: Bun.Server<undefined> | null = null;
  private readonly token = randomBytes(32).toString('hex');
  private readonly configPaths: string[];
  private configText = '';
  private publication: Publication | null = null;
  private receiveFrame: ((frame: Uint8Array) => unknown) | null = null;
  readonly stats = { httpRequests: 0, rejectedAuth: 0, rejectedShape: 0, rejectedFrame: 0, requests: 0, frames: 0, publications: 0, returnedChunks: 0 };

  constructor(private readonly options: { dataDir: string; diag: Diagnostics; port?: number; sharedConfigPath?: string }) {
    this.configPaths = [...new Set([join(options.dataDir, 'voice-transport.txt'), ...(options.sharedConfigPath ? [options.sharedConfigPath] : [])])];
  }

  start(receiveFrame: (frame: Uint8Array) => unknown): number {
    this.receiveFrame = receiveFrame;
    this.server = Bun.serve({
      hostname: '127.0.0.1', port: this.options.port ?? 19745, maxRequestBodySize: 8192,
      fetch: (request) => this.handle(request),
    });
    const port = this.server.port!;
    this.configText = `http://127.0.0.1:${port}/voice\n${this.token}\n`;
    mkdirSync(this.options.dataDir, { recursive: true });
    for (const path of this.configPaths) writeFileSync(path, this.configText, 'utf8');
    this.options.diag.event('voice.started', { port });
    return port;
  }

  stop(): void {
    this.server?.stop(true); this.server = null;
    for (const path of this.configPaths) {
      try { if (readFileSync(path, 'utf8') === this.configText) unlinkSync(path); } catch { }
    }
  }

  write(content: string): PoolWriteReport {
    try {
      const json = inboxJson(content);
      const packet = JSON.parse(json) as { targetDeliverySessionId: string; publicationRevision: number };
      const bytes = Buffer.from(json, 'utf8');
      if (bytes.length > VOICE_MAX_BYTES || !/^[0-9a-f]{32}$/.test(packet.targetDeliverySessionId)
        || !Number.isSafeInteger(packet.publicationRevision) || packet.publicationRevision < 1) throw new Error('invalid voice publication');
      const chunks: string[] = [];
      for (let at = 0; at < bytes.length; at += VOICE_CHUNK_BYTES) chunks.push(bytes.subarray(at, at + VOICE_CHUNK_BYTES).toString('hex'));
      this.publication = { origin: packet.targetDeliverySessionId, revision: packet.publicationRevision, length: bytes.length, checksum: fletcher16(bytes), chunks };
      this.stats.publications++;
      return { written: 1, unchanged: 0, failed: [] };
    } catch (error) {
      this.options.diag.error('voice.publish_failed', { error: String(error) });
      return { written: 0, unchanged: 0, failed: [{ slot: 'silent_voice', error: 'serialization_failed' }] };
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ transport: 'silent_voice', ...this.stats });
    if (request.method !== 'POST' || url.pathname !== '/voice') return new Response('Not found', { status: 404 });
    this.stats.httpRequests++;
    const token = request.headers.get('X-Forever-Voice-Token') ?? '';
    if (request.headers.has('origin') || !/^[0-9a-f]{64}$/.test(token)
      || !timingSafeEqual(Buffer.from(token), Buffer.from(this.token))) {
      this.stats.rejectedAuth++;
      if (this.stats.rejectedAuth <= 3) this.options.diag.warn('voice.auth_rejected', { tokenLength: token.length, originHeader: request.headers.has('origin'), receivedHash: createHash('sha256').update(token).digest('hex').slice(0,12), expectedHash: createHash('sha256').update(this.token).digest('hex').slice(0,12) });
      return new Response('Forbidden', { status: 403 });
    }
    const text = await request.text();
    const match = /^FAV2:([0-9a-f]{32}):([0-9]{1,16}):([0-9]{1,16}):([0-9]{1,4}):([0-9a-f]*)(?::[0-9]{1,16})?$/.exec(text);
    if (!match) {
      this.stats.rejectedShape++;
      if (this.stats.rejectedShape <= 3) this.options.diag.warn('voice.shape_rejected', { bytes: text.length, fields: text.split(':').map((s) => String(s.length)) });
      return new Response('Invalid voice request', { status: 400 });
    }
    const [, origin, appliedText, wantedText, partText, hex] = match;
    const applied = Number(appliedText), wanted = Number(wantedText), part = Number(partText);
    if (!Number.isSafeInteger(applied) || !Number.isSafeInteger(wanted) || hex!.length > FRAME.capacity * 2 || hex!.length % 2)
      return new Response('Invalid voice limits', { status: 400 });
    this.stats.requests++;
    if (hex!.length) {
      if (hex!.length !== FRAME.capacity * 2) { this.stats.rejectedFrame++; return new Response('Invalid frame length', { status: 400 }); }
      this.stats.frames++;
      try { this.receiveFrame?.(Buffer.from(hex!, 'hex')); }
      catch (error) { this.options.diag.warn('voice.receive_failed', { error: String(error) }); return new Response('Receive failed', { status: 503 }); }
    }
    const packet = this.publication;
    if (!packet || packet.origin !== origin || packet.revision <= applied)
      return new Response(`FAV2:OK:${origin}:${packet && packet.origin === origin ? packet.revision : 0}\n`);
    const first = wanted === packet.revision && part < packet.chunks.length ? part : 0;
    const marks = packet.chunks.slice(first, first + VOICE_BATCH).map((chunk, index) =>
      `FAV2:DATA:${origin}:${packet.revision}:${first + index}:${packet.chunks.length}:${packet.length}:${packet.checksum}:${chunk}`);
    this.stats.returnedChunks += marks.length;
    return new Response(`${marks.join('\n')}\n`, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
