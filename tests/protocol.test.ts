import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  contractSchemas,
  Delivery,
  GameReply,
  Identity,
  ItemInput,
  LIMITS,
  Message,
  ModelReply,
  Policy,
  S,
} from '../bridge/src/contracts.js';
import { unknownFieldPaths } from '../bridge/src/app/router.js';
import { characterKeyOf, randomId } from '../bridge/src/ids.js';
import { resourcePath } from '../bridge/src/paths.js';
import { luaString, toLuaLiteral } from '../bridge/src/transport/lua.js';
import { buildInboxLua, MAX_DELIVERY_LUA_BYTES } from '../bridge/src/transport/packet.js';
import { generateSchemas } from '../tools/generate-schemas.js';
import { answer } from './fakes.js';
import { readInbox, readLua } from './lua-reader.js';

interface FixtureCase {
  name: string;
  schema: string;
  value: unknown;
  negatives: { name: string; path: (string | number)[]; value?: unknown; remove?: boolean }[];
}

function withChange(value: unknown, path: (string | number)[], change: { value?: unknown; remove?: boolean }): unknown {
  const copy = structuredClone(value) as Record<string | number, unknown>;
  let node = copy;
  for (const segment of path.slice(0, -1)) node = node[segment] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  if (change.remove) delete node[last];
  else node[last] = change.value;
  return copy;
}

describe('fixtures', () => {
  const fixture = JSON.parse(readFileSync(resourcePath('fixtures', 'requests.json'), 'utf8')) as { cases: FixtureCase[] };

  for (const testCase of fixture.cases) {
    it(`${testCase.name}: valid example and one-field negatives`, () => {
      const schema = contractSchemas.get(testCase.schema);
      assert.ok(schema, `schema ${testCase.schema} is registered`);
      const parsed = schema.safeParse(testCase.value);
      assert.ok(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues));
      for (const negative of testCase.negatives) {
        const result = schema.safeParse(withChange(testCase.value, negative.path, negative));
        assert.equal(result.success, false, `negative "${negative.name}" must be rejected`);
      }
    });
  }

  it('hello fixture characterKey matches the identity hash', () => {
    const hello = fixture.cases[0]!.value as { characterKey: string; body: { identity: Identity } };
    assert.equal(characterKeyOf(hello.body.identity), hello.characterKey);
  });
});

describe('contracts', () => {
  it('limits S by UTF-8 bytes, not characters', () => {
    assert.ok(S.safeParse('\u044f'.repeat(512)).success);
    assert.equal(S.safeParse('\u044f'.repeat(513)).success, false);
    assert.ok(S.safeParse('a'.repeat(LIMITS.stringBytes)).success);
    assert.equal(S.safeParse('a'.repeat(LIMITS.stringBytes + 1)).success, false);
  });

  it('rejects strings with lone surrogates', () => {
    assert.equal(S.safeParse('ok\ud800').success, false);
  });

  it('accepts only a client item link with the same ID', () => {
    const link = '|cff1eff00|Hitem:11287::::::::12:::::::|h[Lesser Magic Wand]|h|r';
    assert.ok(ItemInput.safeParse({ itemId: 11287, itemLink: link }).success);
    assert.equal(ItemInput.safeParse({ itemId: 11288, itemLink: link }).success, false);
    assert.equal(ItemInput.safeParse({ itemId: 11287, itemLink: '[Lesser Magic Wand]' }).success, false);
  });

  it('keeps enabled groups unique and in table order', () => {
    assert.ok(Policy.safeParse({ revision: 1, resetEpoch: 0, enabledGroups: ['character', 'bags'] }).success);
    assert.equal(Policy.safeParse({ revision: 1, resetEpoch: 0, enabledGroups: ['bags', 'character'] }).success, false);
    assert.equal(Policy.safeParse({ revision: 1, resetEpoch: 0, enabledGroups: ['bags', 'bags'] }).success, false);
  });

  it('enforces reply status rules', () => {
    assert.ok(ModelReply.safeParse(answer()).success);
    assert.equal(ModelReply.safeParse(answer('x', { status: 'partial' })).success, false);
    assert.ok(ModelReply.safeParse(answer('x', { status: 'partial', limitations: ['no prices'] })).success);
    assert.equal(ModelReply.safeParse(answer('x', { status: 'error' })).success, false);
    assert.equal(ModelReply.safeParse(answer('\u044f'.repeat(LIMITS.replyTextBytes / 2 + 1))).success, false);
  });

  it('tolerates extra fields in addon messages and reports their paths', () => {
    const json = {
      version: 1,
      type: 'RECEIPTS',
      originSessionId: randomId(),
      messageSequence: 1,
      characterKey: 'a'.repeat(64),
      extra: true,
      body: { deliveryIds: [randomId()], note: 'x' },
    };
    const parsed = Message.parse(json);
    assert.deepEqual(unknownFieldPaths(json, parsed).sort(), ['body.note', 'extra']);
  });

  it('allows request=null only for hello/history/cleared/error deliveries', () => {
    const body = answer() as unknown;
    const reply = { deliveryId: randomId(), type: 'reply', request: null, body };
    assert.equal(Delivery.safeParse(reply).success, false);
    const error = { deliveryId: randomId(), type: 'error', request: null, body: { code: 'history_changed', text: 'x' } };
    assert.ok(Delivery.safeParse(error).success);
  });

  it('builds GameReply from the same rules', () => {
    const game = { ...answer(), itemRefs: [], locationRef: null } as Record<string, unknown>;
    delete game.itemRefIds;
    delete game.locationRefId;
    assert.ok(GameReply.safeParse(game).success);
  });
});

describe('lua codec', () => {
  it('escapes quotes, backslashes, newlines and control bytes with 3-digit escapes', () => {
    assert.equal(luaString('a"b\\c\nd\re\u0001f9'), '"a\\"b\\\\c\\nd\\013e\\001f9"');
  });

  it('keeps Cyrillic as raw UTF-8 and round-trips through the reader', () => {
    const value = { text: '\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440! «\u0451»', list: [1, 2.5, -3], flag: true, end: 'keyword', 'a-b': 1, nothing: null };
    const literal = toLuaLiteral(value);
    assert.ok(literal.includes('\u041f\u0440\u0438\u0432\u0435\u0442'));
    assert.ok(literal.includes('["end"]='));
    assert.ok(!literal.includes('nothing'));
    assert.deepEqual(readLua(literal), { text: '\u041f\u0440\u0438\u0432\u0435\u0442, \u043c\u0438\u0440! «\u0451»', list: [1, 2.5, -3], flag: true, end: 'keyword', 'a-b': 1 });
  });

  it('writes empty arrays as {} and rejects non-finite numbers and nulls in arrays', () => {
    assert.equal(toLuaLiteral({ list: [] }), '{list={}}');
    assert.throws(() => toLuaLiteral({ n: Number.NaN }));
    assert.throws(() => toLuaLiteral([null]));
  });

  it('wraps deliveries into an Inbox.lua assignment within the packet limit', () => {
    const delivery = toLuaLiteral({ deliveryId: randomId(), type: 'error', body: { code: 'busy', text: 'Busy' } });
    const inbox = buildInboxLua(
      {
        publicationRevision: 7,
        targetCharacterKey: 'b'.repeat(64),
        targetDeliverySessionId: randomId(),
        acceptedMessageKeys: [{ originSessionId: randomId(), messageSequence: 3 }],
      },
      [delivery],
    );
    const table = readInbox(inbox) as Record<string, unknown>;
    assert.equal(table.version, 1);
    assert.equal(table.publicationRevision, 7);
    assert.equal((table.deliveries as unknown[]).length, 1);
    assert.ok(MAX_DELIVERY_LUA_BYTES > 200 * 1024 && MAX_DELIVERY_LUA_BYTES < LIMITS.inboxLuaBytes);
  });
});

describe('json schema export', () => {
  it('is deterministic and matches the committed files', () => {
    const first = generateSchemas();
    const second = generateSchemas();
    assert.deepEqual([...first.entries()], [...second.entries()]);
    for (const [file, content] of first) {
      const onDisk = readFileSync(resourcePath('schemas', file), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(onDisk, content, `${file} is up to date`);
    }
  });

  it('gives the model a self-contained strict root schema', () => {
    const schema = JSON.parse(generateSchemas().get('model-reply.schema.json')!) as Record<string, unknown>;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.ok(!JSON.stringify(schema).includes('"$ref"'));
    assert.deepEqual(
      (schema.required as string[]).sort(),
      ['approxLocation', 'calculationIds', 'clarification', 'evidenceIds', 'itemRefIds', 'limitations', 'locationRefId', 'locations', 'plan', 'status', 'text'],
    );
  });
});
