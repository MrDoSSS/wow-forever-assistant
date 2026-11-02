// Share the bounded literal AST reader. Namespace/prelude are selected explicitly;
// neither addon code nor strings containing Lua are executed.
export { LuaDataError, PARSE_LIMITS, type LiteralValue, type ParseResult } from '../shared/lua.js';
import { parseDataFile as parse, PARSE_LIMITS, type ParseLimits } from '../shared/lua.js';
export function parseDataFile(bytes: Uint8Array, limits: ParseLimits = PARSE_LIMITS) { return parse(bytes, limits); }
export function parseLiteral(text: string, limits: ParseLimits = PARSE_LIMITS) { return parse(Buffer.from(text), limits, 'literal'); }
