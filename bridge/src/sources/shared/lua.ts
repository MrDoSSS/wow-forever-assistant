// Static literal data and SavedVariables parser. No Lua code is executed.
import luaparse from 'luaparse';

export type LiteralValue = null | boolean | number | string | LiteralValue[] | { [key: string]: LiteralValue };

export interface ParseLimits {
  maxDepth: number;
  maxNodes: number;
}

export const PARSE_LIMITS: ParseLimits = { maxDepth: 64, maxNodes: 500_000 };

export interface Assignment {
  /** ['recipes'] or ['leveling', 'Alchemy']. */
  path: string[];
  value: LiteralValue;
}

export type SkipReason = 'duplicate_key' | 'mixed_table' | 'invalid_utf8' | 'non_finite_number';

export interface ParseSkip {
  path: string;
  reason: SkipReason;
}

export interface ParseResult {
  assignments: Assignment[];
  skips: ParseSkip[];
  nodes: number;
}

export type LuaDataErrorCode =
  | 'syntax'
  | 'forbidden_construct'
  | 'ast_limit'
  | 'depth_limit'
  | 'unsupported_format'
  | 'time_limit'
  | 'parser_failed';

export class LuaDataError extends Error {
  constructor(
    readonly code: LuaDataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LuaDataError';
  }
}

/** Per-record error: skip the record and continue parsing the file. */
class RecordError extends Error {
  constructor(readonly reason: SkipReason) {
    super(reason);
  }
}

const ROOT = 'ns';
const SHORT_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };
const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Lua 5.1 string literal from source decoded as latin1, one character per byte.
 * Short strings support control, quote, backslash, newline and up-to-three-digit decimal escapes;
 * long [=*[ ... ]=*] strings omit their initial newline.
 */
export function decodeLuaString(raw: string): Uint8Array {
  const bytes: number[] = [];
  const long = /^\[(=*)\[/.exec(raw);
  if (long) {
    let body = raw.slice(long[0].length, raw.length - long[0].length);
    if (body.startsWith('\r\n') || body.startsWith('\n\r')) body = body.slice(2);
    else if (body.startsWith('\n') || body.startsWith('\r')) body = body.slice(1);
    for (let i = 0; i < body.length; i++) bytes.push(body.charCodeAt(i) & 0xff);
    return new Uint8Array(bytes);
  }
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== '\\') {
      bytes.push(ch.charCodeAt(0) & 0xff);
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next in SHORT_ESCAPES) bytes.push(SHORT_ESCAPES[next]!);
    else if (next === '\n' || next === '\r') {
      bytes.push(10);
      const after = body[i + 1];
      if ((after === '\n' || after === '\r') && after !== next) i++;
    } else if (/[0-9]/.test(next)) {
      let digits = next;
      while (digits.length < 3 && /[0-9]/.test(body[i + 1] ?? '')) digits += body[++i];
      const value = Number(digits);
      if (value > 255) throw new LuaDataError('syntax', 'decimal escape too large');
      bytes.push(value);
    } else {
      // Lua 5.1 escaped quotes, backslashes and other characters evaluate to the character itself.
      bytes.push(next.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function stringValue(node: { raw: string }): string {
  try {
    return utf8.decode(decodeLuaString(node.raw));
  } catch (error) {
    if (error instanceof LuaDataError) throw error;
    throw new RecordError('invalid_utf8');
  }
}

type Node = luaparse.Node;

class Converter {
  readonly skips: ParseSkip[] = [];

  constructor(private readonly limits: ParseLimits) {}

  value(node: Node, depth: number, path: string): LiteralValue {
    switch (node.type) {
      case 'StringLiteral':
        return stringValue(node);
      case 'NumericLiteral':
        if (!Number.isFinite(node.value)) throw new RecordError('non_finite_number');
        return node.value;
      case 'BooleanLiteral':
        return node.value;
      case 'NilLiteral':
        return null;
      case 'UnaryExpression':
        if (node.operator === '-' && node.argument.type === 'NumericLiteral') return -node.argument.value;
        throw new LuaDataError('forbidden_construct', `unary ${node.operator} at ${path}`);
      case 'TableConstructorExpression':
        return this.table(node, depth + 1, path);
      default:
        throw new LuaDataError('forbidden_construct', `${node.type} at ${path}`);
    }
  }

  private key(node: luaparse.TableKey | luaparse.TableKeyString, path: string): string {
    if (node.type === 'TableKeyString') return node.key.name;
    const key = node.key;
    if (key.type === 'StringLiteral') return stringValue(key);
    if (key.type === 'NumericLiteral') return String(key.value);
    if (key.type === 'UnaryExpression' && key.operator === '-' && key.argument.type === 'NumericLiteral') {
      return String(-key.argument.value);
    }
    throw new LuaDataError('forbidden_construct', `${key.type} key at ${path}`);
  }

  /** A child record error skips only that record. */
  private child(node: Node, depth: number, path: string): { ok: true; value: LiteralValue } | { ok: false } {
    try {
      return { ok: true, value: this.value(node, depth, path) };
    } catch (error) {
      if (!(error instanceof RecordError)) throw error;
      this.skips.push({ path, reason: error.reason });
      return { ok: false };
    }
  }

  table(node: luaparse.TableConstructorExpression, depth: number, path: string): LiteralValue {
    if (depth > this.limits.maxDepth) throw new LuaDataError('depth_limit', `table depth over ${this.limits.maxDepth} at ${path}`);
    const positional = node.fields.filter((f): f is luaparse.TableValue => f.type === 'TableValue');
    const keyed = node.fields.filter((f): f is luaparse.TableKey | luaparse.TableKeyString => f.type !== 'TableValue');
    if (positional.length > 0 && keyed.length > 0) throw new RecordError('mixed_table');
    if (keyed.length === 0) {
      const list: LiteralValue[] = [];
      positional.forEach((field, i) => {
        const result = this.child(field.value, depth, `${path}[${i + 1}]`);
        if (result.ok) list.push(result.value);
      });
      return list;
    }
    const keys = keyed.map((field) => this.key(field, path));
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const object: { [key: string]: LiteralValue } = Object.create(null);
    keyed.forEach((field, i) => {
      const key = keys[i]!;
      const childPath = `${path}[${JSON.stringify(key)}]`;
      if (counts.get(key)! > 1) {
        if (!(key in object)) this.skips.push({ path: childPath, reason: 'duplicate_key' });
        object[key] = null;
        return;
      }
      // A field assigned nil in a constructor is absent.
      if (field.value.type === 'NilLiteral') return;
      const result = this.child(field.value, depth, childPath);
      if (result.ok) object[key] = result.value;
    });
    for (const [key, count] of counts) if (count > 1) delete object[key];
    return object;
  }
}

function assignmentPath(variable: Node, root = ROOT): string[] | null {
  if (variable.type === 'MemberExpression' && variable.indexer === '.' && variable.base.type === 'Identifier' && variable.base.name === root) {
    return [variable.identifier.name];
  }
  // ns.<name>.<identifier> is equivalent to ["<string>"]; 0.5.0 uses this for leveling.ids.
  if (
    variable.type === 'MemberExpression' &&
    variable.indexer === '.' &&
    variable.base.type === 'MemberExpression' &&
    variable.base.indexer === '.' &&
    variable.base.base.type === 'Identifier' &&
    variable.base.base.name === root
  ) {
    return [variable.base.identifier.name, variable.identifier.name];
  }
  if (
    variable.type === 'IndexExpression' &&
    variable.index.type === 'StringLiteral' &&
    variable.base.type === 'MemberExpression' &&
    variable.base.indexer === '.' &&
    variable.base.base.type === 'Identifier' &&
    variable.base.base.name === root
  ) {
    return [variable.base.identifier.name, utf8.decode(decodeLuaString(variable.index.raw))];
  }
  return null;
}

export function parseDataFile(bytes: Uint8Array, limits: ParseLimits = PARSE_LIMITS, format: 'namespace' | 'literal' = 'namespace'): ParseResult {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let nodes = 0;
  let chunk: luaparse.Chunk;
  try {
    chunk = luaparse.parse(source, {
      luaVersion: '5.1',
      encodingMode: 'none',
      comments: false,
      scope: false,
      locations: false,
      ranges: false,
      onCreateNode: () => {
        if (++nodes > limits.maxNodes) throw new LuaDataError('ast_limit', `more than ${limits.maxNodes} AST nodes`);
      },
    } as Partial<luaparse.Options>) as luaparse.Chunk;
  } catch (error) {
    if (error instanceof LuaDataError) throw error;
    if (error instanceof RangeError) throw new LuaDataError('depth_limit', 'nesting too deep');
    throw new LuaDataError('syntax', String((error as Error).message ?? error));
  }

  const converter = new Converter(limits);
  const assignments: Assignment[] = [];
  for (const statement of chunk.body) {
    if (format === 'namespace' && statement.type === 'LocalStatement' && statement.variables.length === 2 &&
      statement.variables[0]?.name === '_' && statement.variables[1]?.name === 'ns' && statement.init.length === 1 && statement.init[0]?.type === 'VarargLiteral') continue;
    if (format === 'literal' && statement.type === 'ReturnStatement' && chunk.body.length === 1 && statement.arguments.length === 1) {
      assignments.push({ path: ['returned'], value: converter.value(statement.arguments[0]!, 0, 'returned') });
      continue;
    }
    if (statement.type !== 'AssignmentStatement' || statement.variables.length !== 1 || statement.init.length !== 1) {
      throw new LuaDataError('forbidden_construct', statement.type);
    }
    if (format === 'literal') throw new LuaDataError('forbidden_construct', 'expected one literal return');
    const path = assignmentPath(statement.variables[0]!);
    if (!path) throw new LuaDataError('forbidden_construct', `assignment to ${statement.variables[0]!.type}`);
    let value: LiteralValue;
    try {
      value = converter.value(statement.init[0]!, 0, path.join('.'));
    } catch (error) {
      if (error instanceof RecordError) throw new LuaDataError('unsupported_format', `${path.join('.')}: ${error.reason}`);
      throw error;
    }
    assignments.push({ path, value });
  }
  return { assignments, skips: converter.skips, nodes };
}

/**
 * Client SavedVariables file: literal assignments to global names
 * (`ForeverAssistantDB = { ... }`). Return only requested names;
 * skip assignments to other globals and reject other constructs.
 */
export function parseSavedVariables(
  bytes: Uint8Array,
  names: readonly string[],
  limits: ParseLimits = PARSE_LIMITS,
): { values: Record<string, LiteralValue>; skips: ParseSkip[] } {
  const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  let nodes = 0;
  let chunk: luaparse.Chunk;
  try {
    chunk = luaparse.parse(source, {
      luaVersion: '5.1',
      encodingMode: 'none',
      comments: false,
      scope: false,
      locations: false,
      ranges: false,
      onCreateNode: () => {
        if (++nodes > limits.maxNodes) throw new LuaDataError('ast_limit', `more than ${limits.maxNodes} AST nodes`);
      },
    } as Partial<luaparse.Options>) as luaparse.Chunk;
  } catch (error) {
    if (error instanceof LuaDataError) throw error;
    if (error instanceof RangeError) throw new LuaDataError('depth_limit', 'nesting too deep');
    throw new LuaDataError('syntax', String((error as Error).message ?? error));
  }
  const converter = new Converter(limits);
  const values: Record<string, LiteralValue> = Object.create(null);
  for (const statement of chunk.body) {
    if (statement.type !== 'AssignmentStatement' || statement.variables.length !== 1 || statement.init.length !== 1) {
      throw new LuaDataError('forbidden_construct', statement.type);
    }
    const variable = statement.variables[0]!;
    if (variable.type !== 'Identifier') throw new LuaDataError('forbidden_construct', `assignment to ${variable.type}`);
    if (!names.includes(variable.name)) continue;
    try {
      values[variable.name] = converter.value(statement.init[0]!, 0, variable.name);
    } catch (error) {
      if (error instanceof RecordError) throw new LuaDataError('unsupported_format', `${variable.name}: ${error.reason}`);
      throw error;
    }
  }
  return { values, skips: converter.skips };
}
