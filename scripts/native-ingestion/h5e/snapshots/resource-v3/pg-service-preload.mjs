// Exact startup-only hook. No spawn wrapper and no installed-file mutation.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startupTransform } from './resource-contract.mjs';
import { pins } from './transforms.mjs';
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.PAPERCLIP_RESOURCE_COUNTER_RELEASE, 'combined-h5e-resource-v2');
const appRoot = realpathSync(process.env.PAPERCLIP_INGESTION_APP_ROOT);
const expected = pins.variants[process.env.PAPERCLIP_RESOURCE_VARIANT]?.serverIndex;
assert.ok(expected); const filename = path.join(appRoot, expected.path);
let loaded = false;
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith('file:') || fileURLToPath(url) !== filename) return nextLoad(url, context);
  assert.equal(loaded, false, 'Duplicate compiled PG startup owner'); loaded = true;
  const original = readFileSync(filename, 'utf8');
  const source = startupTransform(original, expected.sha256, new URL('./pg-service.mjs', import.meta.url).href);
  return { format: 'module', shortCircuit: true, source };
} });
