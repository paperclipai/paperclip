import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.dirname(fileURLToPath(import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function storagePathFor(row) {
  const stored = row.storagePath ?? row.path;
  for (const value of [row.path, stored]) {
    assert.ok(typeof value === 'string' && !path.isAbsolute(value)
      && !value.split('/').includes('..') && path.posix.normalize(value) === value);
  }
  return stored;
}

export async function verifyPackage(root = packageRoot) {
  const manifest = JSON.parse(await readFile(path.join(root, 'sources.json'), 'utf8'));
  assert.equal(manifest.schema, 'paperclip.native-ingestion.h5e-packaged-sources.v1');
  const seen = new Set();
  const storage = new Set();
  let bytes = 0;
  for (const row of manifest.files) {
    const stored = storagePathFor(row);
    assert.ok(!seen.has(row.path), `Duplicate packaged source: ${row.path}`);
    assert.ok(!storage.has(stored), `Duplicate storage path: ${stored}`);
    seen.add(row.path);
    storage.add(stored);
    const actual = await readFile(path.join(root, stored));
    assert.equal(actual.length, row.bytes, `Packaged length changed: ${row.path}`);
    assert.equal(hash(actual), row.sha256, `Packaged bytes changed: ${row.path}`);
    bytes += actual.length;
  }
  for (const directory of ['h5e-v4', 'resource-v3']) {
    const prefix = `snapshots/${directory}/`;
    const packet = JSON.parse(await readFile(path.join(root, prefix, 'source-packet.json'), 'utf8'));
    for (const row of packet.sourceFiles) {
      const copy = manifest.files.find(item => item.path === prefix + row.path);
      assert.ok(copy, `Missing sealed source: ${prefix + row.path}`);
      assert.equal(copy.sha256, row.sha256);
      assert.equal(copy.bytes, row.bytes);
    }
  }
  return { complete: true, exactFiles: seen.size, bytes, sourceOnly: true,
    executionReleased: false, performanceAcceptance: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyPackage(), null, 2));
}
