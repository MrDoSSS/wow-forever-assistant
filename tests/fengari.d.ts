declare module 'fengari' {
  const fengari: {
    lua: any;
    lauxlib: any;
    lualib: any;
    to_luastring(value: string): Uint8Array;
    to_jsstring(value: Uint8Array): string;
  };
  export default fengari;
}
