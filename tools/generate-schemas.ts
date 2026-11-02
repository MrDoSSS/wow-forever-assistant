// Deterministically generate schemas/*.schema.json from bridge/src/contracts.ts.
// --check compares generated output with disk files and fails on differences.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { contractRegistry, MODEL_REPLY_DESCRIPTIONS, ModelReply, SCHEMA_FILES } from '../bridge/src/contracts.js';
import { packageRoot } from '../bridge/src/paths.js';

type JsonSchema = Record<string, unknown>;

const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const REF_PREFIX = '#/$defs/';

function collectRefs(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(REF_PREFIX)) {
        out.add(value.slice(REF_PREFIX.length));
      } else {
        collectRefs(value, out);
      }
    }
  }
}

/** Put a description first on the property at path, through arrays and nullable objects. */
function describeField(schema: JsonSchema, path: string[], description: string): void {
  let node = schema;
  for (const [index, key] of path.entries()) {
    while (!node.properties) {
      const next = (node.anyOf as JsonSchema[] | undefined)?.find((branch) => branch.type === 'object' || branch.type === 'array') ?? (node.items as JsonSchema | undefined);
      if (!next) throw new Error(`no object at ${path.slice(0, index).join('.')}`);
      node = next;
    }
    const properties = node.properties as Record<string, JsonSchema>;
    if (!properties[key]) throw new Error(`no property ${path.slice(0, index + 1).join('.')}`);
    if (index === path.length - 1) properties[key] = { description, ...properties[key] };
    else node = properties[key];
  }
}

function strip(schema: JsonSchema): JsonSchema {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

export function generateSchemas(): Map<string, string> {
  // io: 'input' permits extra protocol object fields; strict objects
  // (ModelReply and tool arguments) keep additionalProperties:false.
  const exported = z.toJSONSchema(contractRegistry, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'input',
    uri: (id) => `${REF_PREFIX}${id}`,
  }).schemas as Record<string, JsonSchema>;

  const closure = (roots: readonly string[]): string[] => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      const schema = exported[id];
      if (!schema) throw new Error(`schema ${id} is not registered`);
      seen.add(id);
      const refs = new Set<string>();
      collectRefs(schema, refs);
      queue.push(...refs);
    }
    return [...seen].sort();
  };

  const files = new Map<string, string>();
  for (const [name, roots] of Object.entries(SCHEMA_FILES)) {
    const defs: Record<string, JsonSchema> = {};
    for (const id of closure(roots)) defs[id] = strip(exported[id]!);
    const document = {
      $schema: DRAFT,
      $id: `https://forever-assistant.local/schemas/${name}.schema.json`,
      title: `Forever Assistant v1: ${name}`,
      roots: [...roots],
      $defs: defs,
    };
    files.set(`${name}.schema.json`, `${JSON.stringify(document, null, 2)}\n`);
  }

  // Standalone root schema for structured model output (--output-schema):
  // fully expanded without external references.
  // The bridge reads older replies without locations and plan; new model output requires both.
  const modelOutput = ModelReply.safeExtend({
    locations: ModelReply.shape.locations.unwrap(),
    plan: ModelReply.shape.plan.unwrap(),
  });
  const modelReply = z.toJSONSchema(modelOutput, {
    target: 'draft-2020-12',
    unrepresentable: 'throw',
    io: 'input',
    metadata: z.registry(),
  }) as JsonSchema;
  for (const [path, description] of Object.entries(MODEL_REPLY_DESCRIPTIONS)) describeField(modelReply, path.split('.'), description);
  files.set(
    'model-reply.schema.json',
    `${JSON.stringify({ $schema: DRAFT, title: 'ModelReply', ...strip(modelReply) }, null, 2)}\n`,
  );
  return files;
}

function main(): void {
  const check = process.argv.includes('--check');
  const dir = join(packageRoot(), 'schemas');
  const files = generateSchemas();
  const stale: string[] = [];
  if (!check) mkdirSync(dir, { recursive: true });
  for (const [file, content] of files) {
    const path = join(dir, file);
    if (check) {
      let current: string | null = null;
      try {
        current = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      } catch {
        current = null;
      }
      if (current !== content) stale.push(file);
    } else {
      writeFileSync(path, content, 'utf8');
    }
  }
  if (check && stale.length > 0) {
    console.error(`JSON Schema differs from contracts.ts: ${stale.join(', ')}. Run bun run schemas:generate.`);
    process.exit(1);
  }
  console.log(check ? `JSON Schema matches (${files.size} files)` : `Wrote ${files.size} files to ${dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
