// Child process for parsing one Data file (parse.ts: parseInProcess).
import { LuaDataError, parseDataFile, type ParserLimits } from './parse.js';

process.once('message', (input) => {
  const { bytes, limits } = input as { bytes: Uint8Array; limits: ParserLimits };
  let reply;
  try {
    const result = parseDataFile(bytes, limits);
    reply = { ok: true, result };
  } catch (error) {
    const code = error instanceof LuaDataError ? error.code : 'syntax';
    reply = { ok: false, code, message: String((error as Error).message ?? error) };
  }
  process.send!(reply, () => process.disconnect());
});
