// Lua literal serializer for Inbox.lua. Arrays are sequences;
// null is an absent field restored by the addon from the schema; an empty array is {}.
// Quote strings and escape control bytes with three-digit decimal escapes.
// Keep non-ASCII text as UTF-8 so Lua 5.1 reads the literal without loss.

const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function luaString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString().padStart(3, '0')}`;
    else if (code >= 0xd800 && code <= 0xdfff) throw new Error('lone surrogate in Lua string');
    else out += ch;
  }
  return `${out}"`;
}

function luaNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('non-finite number in Lua literal');
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('unsafe integer in Lua literal');
  return Object.is(value, -0) ? '0' : String(value);
}

function luaKey(key: string): string {
  return IDENTIFIER.test(key) && !LUA_KEYWORDS.has(key) ? key : `[${luaString(key)}]`;
}

export function toLuaLiteral(value: unknown): string {
  if (value === null || value === undefined) throw new Error('null is only allowed as an object field');
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return luaNumber(value);
    case 'string':
      return luaString(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `{${value.map((item) => toLuaLiteral(item)).join(',')}}`;
      }
      const parts: string[] = [];
      for (const [key, field] of Object.entries(value)) {
        if (field === null || field === undefined) continue;
        parts.push(`${luaKey(key)}=${toLuaLiteral(field)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`unsupported value in Lua literal: ${typeof value}`);
  }
}

export function luaByteLength(literal: string): number {
  return Buffer.byteLength(literal, 'utf8');
}
