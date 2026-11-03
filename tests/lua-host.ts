// Run the Lua addon in fengari (Lua 5.3) with a fake WoW API (tests/wow-stubs.lua).
// Lua 5.3 does not prove client compatibility; these tests verify logic and bytes.
import { readFileSync } from 'node:fs';
import fengari from 'fengari';
import { resourcePath } from '../bridge/src/paths.js';
import { luaString } from '../bridge/src/transport/lua.js';

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

export const ADDON_FILES = [
  'Config.lua',
  'Core.lua',
  'Bit.lua',
  'Json.lua',
  'Sha256.lua',
  'Transport/Codec.lua',
  'Transport/Outbound.lua',
  'Transport/Inbound.lua',
  'Transport/Voice.lua',
  'Collectors/Context.lua',
  'Collectors/Alts.lua',
  'Integrations/Auctionator.lua',
  'Integrations/ItemInfo.lua',
  'Map.lua',
  'UI/Items.lua',
  'UI/Wrap.lua',
  'Assistant.lua',
  'Plan.lua',
];

export class LuaHost {
  private readonly L: unknown;

  constructor(options: { nativeBit?: boolean; stubs?: boolean } = {}) {
    this.L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(this.L);
    if (options.stubs !== false) this.runFile(resourcePath('tests', 'wow-stubs.lua'));
    if (options.nativeBit) {
      // Client LuaBitOp returns signed 32-bit numbers. Fengari integers are also 32-bit,
      // so coerce inputs to signed 32-bit values before operating on them.
      this.run(`
        local function i(x) x = x % 4294967296; if x >= 2147483648 then x = x - 4294967296 end; return math.tointeger(x) end
        bit = {
          band = function(a, b) return i(a) & i(b) end,
          bor = function(a, b) return i(a) | i(b) end,
          bxor = function(a, b) return i(a) ~ i(b) end,
          bnot = function(a) return ~i(a) end,
          rshift = function(a, n) return i(a) >> n end,
          lshift = function(a, n) return i(a) << n end,
        }`);
    }
  }

  private check(status: number): void {
    if (status !== lua.LUA_OK) {
      const message = to_jsstring(lua.lua_tolstring(this.L, -1));
      lua.lua_pop(this.L, 1);
      throw new Error(`Lua: ${message}`);
    }
  }

  run(code: string, name = 'test'): void {
    this.check(lauxlib.luaL_loadbuffer(this.L, to_luastring(code), null, to_luastring(name)));
    this.check(lua.lua_pcall(this.L, 0, 0, 0));
  }

  runFile(path: string, args: 'addon' | 'none' = 'none'): void {
    const bytes = new Uint8Array(readFileSync(path));
    this.check(lauxlib.luaL_loadbuffer(this.L, bytes, null, to_luastring(`@${path}`)));
    if (args === 'addon') {
      lua.lua_pushstring(this.L, to_luastring('ForeverAssistant'));
      lua.lua_getglobal(this.L, to_luastring('__FA_NS'));
      this.check(lua.lua_pcall(this.L, 2, 0, 0));
    } else {
      this.check(lua.lua_pcall(this.L, 0, 0, 0));
    }
  }

  /** Compile only: check syntax of files not executed in tests, such as the chat window. */
  compile(path: string): void {
    const bytes = new Uint8Array(readFileSync(path));
    this.check(lauxlib.luaL_loadbuffer(this.L, bytes, null, to_luastring(`@${path}`)));
    lua.lua_pop(this.L, 1);
  }

  /** Load addon files in TOC order using a shared namespace, as in the client's `...` argument. */
  loadAddon(files = ADDON_FILES): void {
    this.run('__FA_NS = {}');
    for (const file of files) this.runFile(resourcePath('addon', 'ForeverAssistant', file), 'addon');
  }

  /** Lua expression value as a string (tostring); return hex for byte assertions. */
  eval(expression: string): string {
    this.check(lauxlib.luaL_loadbuffer(this.L, to_luastring(`return tostring(${expression})`), null, to_luastring('eval')));
    this.check(lua.lua_pcall(this.L, 0, 1, 0));
    const value = to_jsstring(lua.lua_tolstring(this.L, -1));
    lua.lua_pop(this.L, 1);
    return value;
  }

  /** JavaScript string as a Lua literal, preserving UTF-8 bytes. */
  static literal(value: string): string {
    return luaString(value);
  }
}
