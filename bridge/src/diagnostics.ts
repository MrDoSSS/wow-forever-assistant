// Diagnostics: by default log only IDs, phases, timings, sizes and codes.
// Question text and game data require explicit opt-in (includeContent).
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from './clock.js';

export type DiagValue = string | number | boolean | null | undefined | readonly string[];
export type DiagFields = Record<string, DiagValue>;
export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagRecord {
  at: number;
  level: DiagLevel;
  event: string;
  fields: DiagFields;
}

export interface Diagnostics {
  readonly includeContent: boolean;
  event(name: string, fields?: DiagFields): void;
  warn(name: string, fields?: DiagFields): void;
  error(name: string, fields?: DiagFields): void;
}

abstract class BaseDiagnostics implements Diagnostics {
  constructor(
    protected readonly clock: Clock,
    readonly includeContent: boolean,
  ) {}

  protected abstract write(record: DiagRecord): void;

  event(name: string, fields: DiagFields = {}): void {
    this.write({ at: this.clock.now(), level: 'info', event: name, fields });
  }

  warn(name: string, fields: DiagFields = {}): void {
    this.write({ at: this.clock.now(), level: 'warn', event: name, fields });
  }

  error(name: string, fields: DiagFields = {}): void {
    this.write({ at: this.clock.now(), level: 'error', event: name, fields });
  }
}

export interface JsonlDiagnosticsOptions {
  dir: string;
  clock: Clock;
  echo?: boolean;
  includeContent?: boolean;
}

export class JsonlDiagnostics extends BaseDiagnostics {
  private readonly dir: string;
  private readonly echo: boolean;

  constructor(options: JsonlDiagnosticsOptions) {
    super(options.clock, options.includeContent ?? false);
    this.dir = options.dir;
    this.echo = options.echo ?? false;
    mkdirSync(this.dir, { recursive: true });
  }

  protected write(record: DiagRecord): void {
    const day = new Date(record.at).toISOString().slice(0, 10);
    const line = JSON.stringify({ at: new Date(record.at).toISOString(), level: record.level, event: record.event, ...record.fields });
    try {
      appendFileSync(join(this.dir, `bridge-${day}.jsonl`), `${line}\n`, 'utf8');
    } catch {
      // Logging failures must not stop the bridge.
    }
    if (this.echo) (record.level === 'info' ? console.log : console.error)(line);
  }
}

export class MemoryDiagnostics extends BaseDiagnostics {
  readonly records: DiagRecord[] = [];

  constructor(clock: Clock, includeContent = false) {
    super(clock, includeContent);
  }

  protected write(record: DiagRecord): void {
    this.records.push(record);
  }

  named(event: string): DiagRecord[] {
    return this.records.filter((r) => r.event === event);
  }
}

/** Short key representation for logs. */
export function shortKey(key: string): string {
  return key.slice(0, 12);
}
