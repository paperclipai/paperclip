import { it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readlink, readdir, lstat, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanupSleepOtelLinks, otelPeerNames, setupSleepOtelPeers } from '../../scripts/sleep-qualification/setup-otel.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sleep-otel-setup-test-'));
  const serverDirectory = path.join(directory, 'server'), temporaryRoot = path.join(directory, 'installs');
  await mkdir(serverDirectory); await mkdir(temporaryRoot);
  await writeFile(path.join(serverDirectory, 'package.json'), JSON.stringify({ peerDependencies: Object.fromEntries(otelPeerNames.map(name => [name, '1.2.3'])) }));
  let installs = 0;
  const install = async prefix => {
    installs++;
    const manifest = JSON.parse(await readFile(path.join(prefix, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const packageDirectory = path.join(prefix, 'node_modules', name);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ version }));
    }
  };
  const options = { serverDirectory, temporaryRoot, install };
  try { await run({ directory, options, install, installs: () => installs, destination: name => path.join(serverDirectory, 'node_modules', name) }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
it('reruns after losing its temporary peers and cleans only its recorded matching links', async () => fixture(async f => {
  const first = await setupSleepOtelPeers(f.options);
  assert.equal(first.linked.length, 5); assert.equal(f.installs(), 1);
  assert.equal((await setupSleepOtelPeers(f.options)).alreadyInstalled, true); assert.equal(f.installs(), 1);
  await rm(first.directory, { recursive: true });
  assert.equal((await lstat(f.destination(otelPeerNames[0]))).isSymbolicLink(), true);
  const repaired = await setupSleepOtelPeers(f.options);
  assert.equal(f.installs(), 2); assert.notEqual(repaired.directory, first.directory);
  for (const name of otelPeerNames) assert.equal(await readlink(f.destination(name)), path.join(repaired.directory, 'node_modules', name));
  const cleaned = await cleanupSleepOtelLinks(f.options); assert.equal(cleaned.removed.length, 5);
  for (const name of otelPeerNames) await assert.rejects(lstat(f.destination(name)), { code: 'ENOENT' });
  assert.ok(await readFile(path.join(repaired.directory, 'qualification-setup.json'), 'utf8')); // Evidence retained.
}));
it('preserves unowned dangling links, incomplete directories and mismatched installed packages', async () => {
  for (const kind of ['dangling', 'directory', 'mismatch']) await fixture(async f => {
    const destination = f.destination(otelPeerNames[0]); await mkdir(path.dirname(destination), { recursive: true });
    if (kind === 'dangling') await symlink(path.join(f.directory, 'foreign-missing'), destination);
    else { await mkdir(destination); await writeFile(path.join(destination, kind === 'mismatch' ? 'package.json' : 'keep.txt'), kind === 'mismatch' ? JSON.stringify({ version: '9.9.9' }) : 'foreign'); }
    await assert.rejects(setupSleepOtelPeers(f.options), /refusing|Refusing/); assert.equal(f.installs(), 0);
    if (kind === 'dangling') assert.equal(await readlink(destination), path.join(f.directory, 'foreign-missing'));
    else assert.ok(await readFile(path.join(destination, kind === 'mismatch' ? 'package.json' : 'keep.txt'), 'utf8'));
  });
});
it('keeps healthy unrelated packages and refuses cleanup after an owned link is replaced', async () => fixture(async f => {
  const destination = f.destination(otelPeerNames[0]); await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const receipt = await setupSleepOtelPeers(f.options); assert.equal(receipt.linked.length, 4);
  const replaced = f.destination(otelPeerNames[1]); await unlink(replaced);
  const foreign = path.join(f.directory, 'foreign'); await mkdir(foreign); await writeFile(path.join(foreign, 'keep.txt'), 'foreign');
  await symlink(foreign, replaced);
  await assert.rejects(cleanupSleepOtelLinks(f.options), /no longer match/);
  assert.equal(await readlink(replaced), foreign); assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'foreign');
  assert.equal(JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8')).version, '1.2.3');
}));
it('preserves an entry introduced during installation and removes an unpublished failed install prefix', async () => fixture(async f => {
  await assert.rejects(setupSleepOtelPeers({ ...f.options, install: async prefix => {
    await f.install(prefix); const destination = f.destination(otelPeerNames[0]); await mkdir(destination, { recursive: true }); await writeFile(path.join(destination, 'keep.txt'), 'new foreign entry');
  } }), /destination changed/);
  assert.equal(await readFile(path.join(f.destination(otelPeerNames[0]), 'keep.txt'), 'utf8'), 'new foreign entry');
  assert.equal((await readdir(f.options.temporaryRoot)).length, 0);
}));
