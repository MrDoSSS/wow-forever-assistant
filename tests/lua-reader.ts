// Test reader for our serialized Lua literals: inspect delivery contents
// without executing Lua. Read an empty table as [].
export type LuaValue = string | number | boolean | LuaValue[] | { [key: string]: LuaValue };

export function readLua(source: string): LuaValue {
  let pos = 0;
  const bytes = Buffer.from(source, 'utf8');
  const peek = () => String.fromCharCode(bytes[pos]!);
  const expect = (ch: string) => {
    if (peek() !== ch) throw new Error(`expected ${ch} at ${pos}`);
    pos++;
  };
  const readString = (): string => {
    expect('"');
    const out: number[] = [];
    while (peek() !== '"') {
      const byte = bytes[pos]!;
      if (byte === 0x5c) {
        pos++;
        const next = peek();
        if (next === 'n') {
          out.push(0x0a);
          pos++;
        } else if (next === '"' || next === '\\') {
          out.push(next.charCodeAt(0));
          pos++;
        } else if (/[0-9]/.test(next)) {
          const digits = bytes.subarray(pos, pos + 3).toString('latin1');
          if (!/^[0-9]{3}$/.test(digits)) throw new Error(`short decimal escape at ${pos}`);
          out.push(Number(digits));
          pos += 3;
        } else throw new Error(`unknown escape \\${next}`);
      } else {
        if (byte < 0x20) throw new Error(`raw control byte at ${pos}`);
        out.push(byte);
        pos++;
      }
    }
    pos++;
    return Buffer.from(out).toString('utf8');
  };
  const readValue = (): LuaValue => {
    const ch = peek();
    if (ch === '"') return readString();
    if (ch === '{') return readTable();
    const match = /^(true|false|-?[0-9][0-9.eE+-]*)/.exec(bytes.subarray(pos, pos + 40).toString('latin1'));
    if (!match) throw new Error(`unexpected token at ${pos}`);
    pos += match[1]!.length;
    if (match[1] === 'true') return true;
    if (match[1] === 'false') return false;
    return Number(match[1]);
  };
  const readTable = (): LuaValue => {
    expect('{');
    const array: LuaValue[] = [];
    const object: Record<string, LuaValue> = {};
    let keyed = false;
    while (peek() !== '}') {
      let key: string | null = null;
      if (peek() === '[') {
        pos++;
        key = readString();
        expect(']');
        expect('=');
      } else {
        const ident = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(bytes.subarray(pos, pos + 80).toString('latin1'));
        if (ident) {
          key = ident[1]!;
          pos += ident[0].length;
        }
      }
      const value = readValue();
      if (key === null) array.push(value);
      else {
        keyed = true;
        object[key] = value;
      }
      if (peek() === ',') pos++;
    }
    pos++;
    if (keyed && array.length > 0) throw new Error('mixed table');
    return keyed ? object : array;
  };
  const value = readValue();
  if (pos !== bytes.length) throw new Error(`trailing data at ${pos}`);
  return value;
}

/** Inbox.lua -> ForeverAssistantInbox table. */
export function readInbox(source: string): LuaValue {
  const prefix = 'ForeverAssistantInbox=';
  if (!source.startsWith(prefix) || !source.endsWith('\n')) throw new Error('not an Inbox.lua');
  return readLua(source.slice(prefix.length, -1));
}
