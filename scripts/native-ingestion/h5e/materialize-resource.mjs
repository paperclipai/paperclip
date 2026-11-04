// Recreate exact logical source paths in a fresh staging directory. The stored
// upstream package.json fixture is data, not a repository/workspace manifest.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot, hash, storagePathFor, verifyPackage } from './verify-package.mjs';

export async function materializeResource(output, root = packageRoot) {
  assert.ok(typeof output === 'string' && path.isAbsolute(output), 'A fresh absolute staging path is required');
  const repository = await realpath(path.resolve(root, '../../..'));
  const resolvedOutput = path.join(await realpath(path.dirname(output)), path.basename(output));
  assert.ok(resolvedOutput !== repository && !resolvedOutput.startsWith(repository + path.sep), 'Stage outside the repository checkout');
  await verifyPackage(root);
  const manifest = JSON.parse(await readFile(path.join(root, 'sources.json'), 'utf8'));
  const prefix = 'snapshots/resource-v3/';
  const entries = manifest.files.filter(row => row.path.startsWith(prefix));
  assert.ok(entries.length > 0);
  // Existing outputs are never overwritten, including failed partial stages.
  await mkdir(output, { recursive: false, mode: 0o700 });
  for (const row of entries) {
    const relative = row.path.slice(prefix.length), bytes = await readFile(path.join(root, storagePathFor(row)));
    assert.equal(hash(bytes), row.sha256, `Source changed during staging: ${row.path}`);
    const destination = path.join(output, relative);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
  return { complete: true, output, logicalFiles: entries.length,
    sourcePacketSha256: hash(await readFile(path.join(output, 'source-packet.json'))),
    sourceOnly: true, executionReleased: false, performanceAcceptance: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
  console.log(JSON.stringify(await materializeResource(output), null, 2));
}
