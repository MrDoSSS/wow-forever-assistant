// CaptureAdapter: the frame field image from the game window.
// The implementation uses a separate bridge/capture.ps1 process emitting JSON lines.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import type { Diagnostics } from '../diagnostics.js';
import { resourcePath } from '../paths.js';
import { FRAME } from './frame.js';

export interface CapturedImage {
  at: number;
  width: number;
  height: number;
  rgb: Uint8Array;
}

export const CAPTURE_STATUS_CODES = [
  'ok',
  'not_configured',
  'process_not_found',
  'window_not_found',
  'minimized',
  'client_too_small',
  'capture_failed',
  'host_exited',
] as const;
export type CaptureStatusCode = (typeof CAPTURE_STATUS_CODES)[number];

export interface CaptureEvents {
  frame(image: CapturedImage): void;
  status(code: CaptureStatusCode, detail: string): void;
}

export interface CaptureAdapter {
  readonly name: string;
  start(events: CaptureEvents): void;
  stop(): Promise<void>;
  /** A single capture attempt for diagnostics. */
  probe(): Promise<{ status: CaptureStatusCode; detail: string; image: CapturedImage | null }>;
}

const CaptureLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), code: z.enum(CAPTURE_STATUS_CODES), detail: z.string() }),
  z.object({
    type: z.literal('frame'),
    at: z.int().min(0),
    width: z.int().min(1).max(4096),
    height: z.int().min(1).max(4096),
    rgb: z.string(),
  }),
]);
export type CaptureLine = z.output<typeof CaptureLine>;

export function parseCaptureLine(line: string): { kind: 'status'; code: CaptureStatusCode; detail: string } | { kind: 'frame'; image: CapturedImage } | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = CaptureLine.safeParse(json);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.type === 'status') return { kind: 'status', code: value.code, detail: value.detail };
  const rgb = new Uint8Array(Buffer.from(value.rgb, 'base64'));
  if (rgb.length !== value.width * value.height * 3) return null;
  return { kind: 'frame', image: { at: value.at, width: value.width, height: value.height, rgb } };
}

export interface PowerShellCaptureOptions {
  processName: string | null;
  intervalMs?: number;
  diag: Diagnostics;
  powershell?: string;
  scriptPath?: string;
  restartDelayMs?: number;
}

export function captureArgs(scriptPath: string, extra: string[]): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...extra];
}

export class PowerShellCapture implements CaptureAdapter {
  readonly name = 'powershell';
  private child: ChildProcess | null = null;
  private stopped = true;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: PowerShellCaptureOptions) {}

  private get script(): string {
    return this.options.scriptPath ?? resourcePath('bridge', 'capture.ps1');
  }

  private fieldArgs(): string[] {
    return [
      '-ProcessName',
      this.options.processName ?? '',
      '-IntervalMs',
      String(this.options.intervalMs ?? 250),
      '-OffsetX',
      String(FRAME.offsetPx),
      '-OffsetY',
      String(FRAME.offsetPx),
      '-Width',
      String(FRAME.widthPx),
      '-Height',
      String(FRAME.heightPx),
    ];
  }

  start(events: CaptureEvents): void {
    this.stopped = false;
    if (!this.options.processName) {
      events.status('not_configured', 'gameProcessName');
      return;
    }
    this.launch(events);
  }

  private launch(events: CaptureEvents): void {
    const args = [...this.fieldArgs(), '-ParentPid', String(process.pid)];
    const child = spawn(this.options.powershell ?? 'powershell.exe', captureArgs(this.script, args), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => {
      const parsed = parseCaptureLine(line);
      if (!parsed) {
        this.options.diag.warn('capture.bad_line', { bytes: line.length });
        return;
      }
      if (parsed.kind === 'status') events.status(parsed.code, parsed.detail);
      else events.frame(parsed.image);
    });
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000);
    });
    child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.options.diag.error('capture.exited', { code: code ?? -1, stderr: stderr.slice(-500) });
      events.status('host_exited', `exit ${code ?? -1}`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (!this.stopped) this.launch(events);
      }, this.options.restartDelayMs ?? 5000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill();
    });
  }

  probe(): Promise<{ status: CaptureStatusCode; detail: string; image: CapturedImage | null }> {
    return runCaptureScript(
      this.options.powershell ?? 'powershell.exe',
      this.script,
      this.options.processName ? [...this.fieldArgs(), '-Once'] : ['-Once'],
    );
  }
}

/** Run capture.ps1 once for probing or self-testing. */
export function runCaptureScript(
  powershell: string,
  scriptPath: string,
  extra: string[],
): Promise<{ status: CaptureStatusCode; detail: string; image: CapturedImage | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, captureArgs(scriptPath, extra), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => {
      let status: CaptureStatusCode | null = null;
      let detail = '';
      let image: CapturedImage | null = null;
      for (const line of stdout.split(/\r?\n/)) {
        const parsed = line ? parseCaptureLine(line) : null;
        if (parsed?.kind === 'status') {
          status = parsed.code;
          detail = parsed.detail;
        } else if (parsed?.kind === 'frame') {
          image = parsed.image;
          status ??= 'ok';
        }
      }
      if (status === null) reject(new Error(`capture.ps1 exited ${code}: ${stderr.slice(-500)}`));
      else resolve({ status, detail, image });
    });
  });
}
