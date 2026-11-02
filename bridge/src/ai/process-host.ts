// Bridge side of the process host (bridge/codex-host.ps1): start the process
// tree in a Job Object, prepare -> persist -> resume, forward streams,
// confirm stopping and verify after restart.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { resourcePath } from '../paths.js';

const HostMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prepared'), pid: z.int(), createdAt: z.number(), hostPid: z.int(), hostCreatedAt: z.number() }),
  z.object({ type: z.literal('stdout'), data: z.string() }),
  z.object({ type: z.literal('stderr'), data: z.string() }),
  z.object({ type: z.literal('stopped'), activeProcesses: z.number() }),
  z.object({ type: z.literal('exit'), code: z.number(), activeProcesses: z.number() }),
  z.object({ type: z.literal('error'), code: z.string(), detail: z.string() }),
  z.object({ type: z.literal('check'), job: z.enum(['absent', 'stopped']), activeProcesses: z.number(), child: z.enum(['absent', 'terminated', 'reused', 'alive', 'none']) }),
]);
type HostMessage = z.output<typeof HostMessage>;

export interface HostSpawn {
  exe: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProcessInfo {
  jobName: string;
  pid: number;
  createdAt: number;
  hostPid: number;
  hostCreatedAt: number;
}

export class ProcessHostError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ProcessHostError';
  }
}

export interface HostOptions {
  powershell?: string;
  scriptPath?: string;
  /** Time allowed for Add-Type compilation and the prepared event. */
  prepareTimeoutMs?: number;
}

const hostArgs = (script: string, extra: string[]) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];

export class HostedProcess {
  private stdoutHandler: (chunk: Buffer) => void = () => {};
  private stderrHandler: (chunk: Buffer) => void = () => {};
  private stopWaiters: ((active: number | null) => void)[] = [];
  readonly exited: Promise<{ code: number | null; activeProcesses: number | null }>;
  private resolveExit!: (value: { code: number | null; activeProcesses: number | null }) => void;
  private hostAlive = true;

  constructor(
    private readonly host: ChildProcess,
    readonly info: ProcessInfo,
  ) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
    host.on('exit', () => {
      this.hostAlive = false;
      for (const waiter of this.stopWaiters.splice(0)) waiter(null);
      this.resolveExit({ code: null, activeProcesses: null });
    });
  }

  /** Host messages after prepared. */
  dispatch(message: HostMessage): void {
    switch (message.type) {
      case 'stdout':
        this.stdoutHandler(Buffer.from(message.data, 'base64'));
        break;
      case 'stderr':
        this.stderrHandler(Buffer.from(message.data, 'base64'));
        break;
      case 'stopped':
        for (const waiter of this.stopWaiters.splice(0)) waiter(message.activeProcesses);
        break;
      case 'exit':
        for (const waiter of this.stopWaiters.splice(0)) waiter(message.activeProcesses);
        this.resolveExit({ code: message.code, activeProcesses: message.activeProcesses });
        break;
    }
  }

  onStdout(handler: (chunk: Buffer) => void): void {
    this.stdoutHandler = handler;
  }

  onStderr(handler: (chunk: Buffer) => void): void {
    this.stderrHandler = handler;
  }

  private send(message: object): void {
    if (this.hostAlive && this.host.stdin?.writable) this.host.stdin.write(`${JSON.stringify(message)}\n`);
  }

  resume(): void {
    this.send({ type: 'resume' });
  }

  write(data: string | Buffer): void {
    this.send({ type: 'stdin', data: Buffer.from(data).toString('base64') });
  }

  closeStdin(): void {
    this.send({ type: 'stdin_close' });
  }

  /** Stop the tree: return remaining job process count (0 confirms stop), or null. */
  stop(): Promise<number | null> {
    if (!this.hostAlive) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.stopWaiters.push(resolve);
      this.send({ type: 'stop' });
    });
  }
}

/** Start a hosted process; the caller resumes it after saving process information. */
export function startHosted(jobName: string, spawnSpec: HostSpawn, options: HostOptions = {}): Promise<HostedProcess> {
  return new Promise((resolve, reject) => {
    const host = spawn(
      options.powershell ?? 'powershell.exe',
      hostArgs(options.scriptPath ?? resourcePath('bridge', 'codex-host.ps1'), ['-JobName', jobName, '-ParentPid', String(process.pid)]),
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: spawnSpec.env ?? process.env },
    );
    let hosted: HostedProcess | null = null;
    let stderr = '';
    const timer = setTimeout(() => {
      if (!hosted) {
        host.kill();
        reject(new ProcessHostError('process host did not report prepared in time'));
      }
    }, options.prepareTimeoutMs ?? 30_000);
    host.stderr!.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-2000)));
    host.on('error', (error) => {
      clearTimeout(timer);
      reject(new ProcessHostError(String(error)));
    });
    host.on('exit', (code) => {
      clearTimeout(timer);
      if (!hosted) reject(new ProcessHostError(`process host exited ${code}: ${stderr.slice(-500)}`));
    });
    createInterface({ input: host.stdout! }).on('line', (line) => {
      const parsed = HostMessage.safeParse(JSON.parse(line));
      if (!parsed.success) return;
      const message = parsed.data;
      if (hosted) {
        hosted.dispatch(message);
        return;
      }
      if (message.type === 'prepared') {
        clearTimeout(timer);
        hosted = new HostedProcess(host, {
          jobName,
          pid: message.pid,
          createdAt: message.createdAt,
          hostPid: message.hostPid,
          hostCreatedAt: message.hostCreatedAt,
        });
        resolve(hosted);
      } else if (message.type === 'error') {
        clearTimeout(timer);
        reject(new ProcessHostError(message.detail));
      }
    });
    host.stdin!.write(`${JSON.stringify({ exe: spawnSpec.exe, args: spawnSpec.args, cwd: spawnSpec.cwd })}\n`);
  });
}

export interface StopCheck {
  job: 'absent' | 'stopped';
  activeProcesses: number;
  child: 'absent' | 'terminated' | 'reused' | 'alive' | 'none';
}

/** After restart, stop a surviving job and child identified by PID and creation time. */
export function checkHosted(jobName: string, childPid: number | null, childCreatedAt: number | null, options: HostOptions = {}): Promise<StopCheck> {
  return new Promise((resolve, reject) => {
    const host = spawn(
      options.powershell ?? 'powershell.exe',
      hostArgs(options.scriptPath ?? resourcePath('bridge', 'codex-host.ps1'), [
        '-JobName',
        jobName,
        '-Check',
        '-ChildPid',
        String(childPid ?? 0),
        '-ChildCreatedAt',
        String(childCreatedAt ?? 0),
      ]),
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    host.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    host.on('error', reject);
    host.on('exit', () => {
      for (const line of stdout.split(/\r?\n/)) {
        const parsed = line ? HostMessage.safeParse(JSON.parse(line)) : null;
        if (parsed?.success && parsed.data.type === 'check') {
          const { job, activeProcesses, child } = parsed.data;
          resolve({ job, activeProcesses, child });
          return;
        }
      }
      reject(new ProcessHostError('process host check produced no result'));
    });
  });
}

/** Stop is confirmed when the job is empty and the child is no longer alive. */
export function stopConfirmed(check: StopCheck): boolean {
  return check.activeProcesses === 0 && check.child !== 'alive';
}
