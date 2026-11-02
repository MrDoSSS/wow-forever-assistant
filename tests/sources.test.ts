import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readSelectedArchive, ARCHIVE_LIMITS } from '../bridge/src/sources/shared/archive.js';
import { decodeLuaString, parseDataFile } from '../bridge/src/sources/shared/lua.js';
import { normalizeText } from '../bridge/src/sources/shared/index.js';
import { httpGet } from '../bridge/src/sources/web.js';
import { makeZip, type ZipEntry } from './zip-writer.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const selection = { root: 'Reference/', select: (name: string) => name.startsWith('Reference/Data/') };
const zip = (extra: ZipEntry[] = []) => makeZip([{ name: 'Reference/Data/Test.lua', data: 'local _, ns = ...\nns.items = {}' }, ...extra]);

describe('archive safety', () => {
  const cases: [string, Uint8Array][] = [
    ['parent path', zip([{name:'Reference/../evil.lua',data:'x'}])],
    ['absolute path', zip([{name:'/etc/evil.lua',data:'x'}])],
    ['case duplicate', zip([{name:'Reference/Data/test.lua',data:'x'}])],
    ['encrypted', zip([{name:'Reference/Media/image.tga',data:'x',flags:1}])],
    ['symlink', zip([{name:'Reference/link',data:'/etc/passwd',unixMode:0o120777}])],
    ['outside root', zip([{name:'Other/data.lua',data:'x'}])],
    ['bad crc', makeZip([{name:'Reference/Data/Test.lua',data:'x',crc:12345}])],
  ];
  for (const [name, archive] of cases) it(`rejects ${name}`, async () => {
    await assert.rejects(readSelectedArchive(archive, selection));
  });
  it('enforces entry count and file size limits', async () => {
    await assert.rejects(readSelectedArchive(zip(),selection,{...ARCHIVE_LIMITS,entries:0}),/entries/);
    await assert.rejects(readSelectedArchive(zip(),selection,{...ARCHIVE_LIMITS,fileBytes:1}),/too large/);
  });
  it('reads selected data only, without executing addon code', async () => {
    const result = await readSelectedArchive(zip([{name:'Reference/UI.lua',data:'error("never execute")'}]),selection);
    assert.deepEqual([...result.files.keys()],['Reference/Data/Test.lua']);
  });
});

describe('static Lua parsing', () => {
  const parse = (text: string) => parseDataFile(bytes(text));
  it('decodes Lua 5.1 bytes and validates UTF-8', () => {
    assert.equal(Buffer.from(decodeLuaString('"\\208\\175"')).toString('utf8'),'Я');
    assert.equal(Buffer.from(decodeLuaString('[==[\nlong]] x]==]')).toString(),'long]] x');
    assert.deepEqual([...decodeLuaString('"\\0012"')],[1,50]);
    const result = parse('ns.items = {[1]="\\255\\254",[2]="ок"}');
    assert.deepEqual({...result.assignments[0]!.value as object},{'2':'ок'});
    assert.deepEqual(result.skips,[{path:'items["1"]',reason:'invalid_utf8'}]);
  });
  it('accepts literal namespace assignments and rejects executable constructs', () => {
    assert.deepEqual(parse('local _, ns = ...\nns.a = {-1,2.5,true,"x"}').assignments,[{path:['a'],value:[-1,2.5,true,'x']}]);
    for (const source of ['print("x")','ns.a=os.time()','ns.a=function() end','local t={}','ns.a=1+2','ns.a={x=y}','Other.a={}','ns={}','for i=1,2 do end']) {
      assert.throws(()=>parse(source),(e:Error & {code?:string})=>e.code==='forbidden_construct',source);
    }
  });
  it('reports duplicate keys and mixed tables, and omits nil fields', () => {
    const result = parse('ns.a={x=1,x=2,y={1,k=2},z=3,n=nil}');
    assert.deepEqual({...result.assignments[0]!.value as object},{z:3});
    assert.deepEqual(result.skips.map(s=>s.reason).sort(),['duplicate_key','mixed_table']);
  });
  it('enforces AST node and nesting limits', () => {
    assert.throws(()=>parseDataFile(bytes('ns.a={1,2,3,4,5,6}'),{maxDepth:64,maxNodes:5}),/AST/);
    assert.throws(()=>parseDataFile(bytes('ns.a={{{{1}}}}'),{maxDepth:3,maxNodes:1000}),/depth/);
  });
  it('normalizes reference names consistently', () => {
    assert.equal(normalizeText('  Ёлка  TEST '),'елка test');
  });
});

describe('reference HTTP', () => {
  const request = {url:'https://example.test/reference.zip',maxBytes:10};
  it('preserves validators and accepts an unchanged snapshot', async () => {
    const result = await httpGet({...request,headers:{'If-None-Match':'"v1"'}},async(_url,init)=>{
      assert.equal(new Headers(init.headers).get('if-none-match'),'"v1"');
      return new Response(null,{status:304,headers:{ETag:'"v1"'}});
    });
    assert.equal(result.status,'not_modified');
  });
  it('retries server failures but not client failures or oversized bodies', async () => {
    let attempts=0;
    const retry = await httpGet(request,async()=>++attempts===1 ? new Response('',{status:503}) : new Response('ok'));
    assert.equal(retry.status,'ok'); assert.equal(attempts,2);
    attempts=0;
    const client = await httpGet(request,async()=>{attempts++;return new Response('',{status:403});});
    assert.equal(client.status,'error'); assert.equal(attempts,1);
    const large = await httpGet(request,async()=>new Response('x'.repeat(11)));
    assert.equal(large.status,'error');
    if(large.status==='error') assert.equal(large.code,'too_large');
  });
});
