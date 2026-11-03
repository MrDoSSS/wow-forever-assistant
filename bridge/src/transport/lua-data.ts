// Read only the data grammar emitted by toLuaLiteral. Never execute Lua code.
export type LuaData = string | number | boolean | LuaData[] | { [key: string]: LuaData };

export function readLuaData(source: string): LuaData {
  if (Buffer.byteLength(source) > 524288) throw new Error('Lua data too large');
  const bytes = Buffer.from(source, 'utf8');
  let pos = 0;
  const peek = () => pos < bytes.length ? String.fromCharCode(bytes[pos]!) : '';
  const expect = (ch: string) => { if (peek() !== ch) throw new Error(`expected ${ch} at ${pos}`); pos++; };
  const string = (): string => {
    expect('"');
    const out: number[] = [];
    while (peek() !== '"') {
      if (pos >= bytes.length) throw new Error('unterminated Lua string');
      let byte = bytes[pos++]!;
      if (byte === 92) {
        const ch = peek();
        if (ch === 'n') { byte = 10; pos++; }
        else if (ch === '"' || ch === '\\') { byte = bytes[pos++]!; }
        else {
          const digits = bytes.subarray(pos, pos + 3).toString('latin1');
          if (!/^[0-9]{3}$/.test(digits) || Number(digits) > 255) throw new Error('invalid Lua escape');
          byte = Number(digits); pos += 3;
        }
      } else if (byte < 32) throw new Error('raw control byte');
      out.push(byte);
    }
    pos++;
    return Buffer.from(out).toString('utf8');
  };
  const value = (depth: number): LuaData => {
    if (depth > 128) throw new Error('Lua data too deep');
    if (peek() === '"') return string();
    if (peek() === '{') {
      pos++;
      const array: LuaData[] = [];
      const object: Record<string, LuaData> = Object.create(null);
      let keyed = false;
      while (peek() !== '}') {
        if (pos >= bytes.length) throw new Error('unterminated Lua table');
        let key: string | null = null;
        if (peek() === '[') { pos++; key = string(); expect(']'); expect('='); }
        else {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(bytes.subarray(pos, pos + 256).toString('latin1'));
          if (match) { key = match[1]!; pos += match[0].length; }
        }
        const field = value(depth + 1);
        if (key === null) array.push(field);
        else { if (Object.hasOwn(object, key)) throw new Error('duplicate Lua key'); keyed = true; object[key] = field; }
        if (peek() !== '}') expect(',');
      }
      pos++;
      if (keyed && array.length) throw new Error('mixed Lua table');
      return keyed ? object : array;
    }
    const match = /^(true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(bytes.subarray(pos, pos + 64).toString('latin1'));
    if (!match) throw new Error(`unexpected Lua data at ${pos}`);
    pos += match[0].length;
    if (match[0] === 'true') return true;
    if (match[0] === 'false') return false;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error('invalid Lua number');
    return number;
  };
  const result = value(0);
  if (pos !== bytes.length) throw new Error('trailing Lua data');
  return result;
}

export function inboxJson(source: string): string {
  const prefix = 'ForeverAssistantInbox=';
  if (!source.startsWith(prefix) || !source.endsWith('\n')) throw new Error('invalid inbox envelope');
  return JSON.stringify(readLuaData(source.slice(prefix.length, -1)));
}
