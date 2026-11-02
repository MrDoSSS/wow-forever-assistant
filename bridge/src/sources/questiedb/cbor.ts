// Decode the definite-length CBOR subset used by QuestieDB's baked metadata.
// No Lua or addon code is executed. Bound recursion, allocations and numeric precision.
export type DataValue = null | boolean | number | string | DataValue[] | { [key: string]: DataValue };

export class QuestieDataError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'QuestieDataError';
  }
}

export function decodeCbor(bytes: Uint8Array, maxNodes = 2_000_000): DataValue {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let nodes = 0;
  const fail = (reason: string): never => { throw new QuestieDataError('bad_cbor', reason); };
  const take = (size: number): number => {
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > data.length) fail('truncated CBOR');
    const start = offset;
    offset += size;
    return start;
  };
  const read = (depth: number): DataValue => {
    if (depth > 48 || ++nodes > maxNodes) fail('CBOR nesting or node limit exceeded');
    const header = data[take(1)]!;
    const major = header >> 5;
    const extra = header & 31;
    if (major === 7) {
      if (extra === 20) return false;
      if (extra === 21) return true;
      if (extra === 22) return null;
      let value: number;
      if (extra === 25) {
        const half = data.readUInt16BE(take(2));
        const sign = half & 0x8000 ? -1 : 1;
        const exponent = (half >> 10) & 31;
        const fraction = half & 1023;
        value = sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? NaN : (1 + fraction / 1024) * 2 ** (exponent - 15));
      } else if (extra === 26) value = data.readFloatBE(take(4));
      else if (extra === 27) value = data.readDoubleBE(take(8));
      else return fail('unsupported CBOR simple value');
      if (!Number.isFinite(value)) fail('non-finite CBOR number');
      return value;
    }
    let length: number;
    if (extra < 24) length = extra;
    else if (extra === 24) length = data.readUInt8(take(1));
    else if (extra === 25) length = data.readUInt16BE(take(2));
    else if (extra === 26) length = data.readUInt32BE(take(4));
    else if (extra === 27) {
      const value = data.readBigUInt64BE(take(8));
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('CBOR integer exceeds safe precision');
      length = Number(value);
    } else return fail('indefinite-length CBOR is unsupported');
    if (major === 0) return length;
    if (major === 1) {
      if (!Number.isSafeInteger(-1 - length)) fail('CBOR integer exceeds safe precision');
      return -1 - length;
    }
    if (major === 2 || major === 3) {
      const start = take(length);
      try { return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, start + length)); }
      catch { return fail('invalid UTF-8 in CBOR string'); }
    }
    if (length > maxNodes - nodes || length > data.length - offset) fail('CBOR collection exceeds limits');
    if (major === 4) return Array.from({ length }, () => read(depth + 1));
    if (major === 5) {
      const result: Record<string, DataValue> = Object.create(null);
      for (let i = 0; i < length; i++) {
        const key = read(depth + 1);
        if (typeof key !== 'string' && typeof key !== 'number') fail('unsupported CBOR map key');
        const name = String(key);
        if (Object.hasOwn(result, name)) fail('duplicate CBOR map key');
        result[name] = read(depth + 1);
      }
      return result;
    }
    return fail('unsupported CBOR type');
  };
  const value = read(0);
  if (offset !== data.length) fail('trailing CBOR bytes');
  return value;
}

export function objectOf(value: DataValue | undefined, context: string): Record<string, DataValue> {
  // Lua numeric-keyed rows may serialize as CBOR arrays; their indices start at one.
  if (Array.isArray(value)) return Object.fromEntries(value.map((field, i) => [String(i + 1), field]));
  if (value === null || value === undefined || typeof value !== 'object') {
    throw new QuestieDataError('unsupported_format', `${context} must be a map`);
  }
  return value;
}
