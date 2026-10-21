import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stopPrefetches } from '../prefetch-child.mjs';
import { PACK_ARGS, packConcurrency, packStagedPackages, packTimings } from '../pack-staged-packages.mjs';

// A small local script stands in for npm; no test here needs npm or a network.
// It is run as `node <script> pack --ignore-scripts --pack-destination <dir>`,
// the same argument list the real npm receives.
const withScratch = async body => {
  const root = mkdtempSync(join(tmpdir(), 'pack-staged-packages-'));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const entriesFor = (root, names) => names.map((name, index) => {
  const target = join(root, `package-${index}`);
  mkdirSync(target);
  return { name, index, target, destination: join(root, `pack-${index}`) };
});
const fakeNpm = (root, body) => { const script = join(root, 'fake-npm.mjs'); writeFileSync(script, body); return [process.execPath, script]; };
const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the concurrency defaults to one child per core', () => {
  assert.ok(Number.isInteger(packConcurrency()) && packConcurrency() >= 1);
  assert.deepEqual(PACK_ARGS, ['pack', '--ignore-scripts', '--pack-destination']);
});

test('packs run together up to the concurrency, in the order given, and the tarballs come back in entry order', async () => withScratch(async root => {
  // Each stand-in records when it started and finished, writes one tarball
  // named after its package, and prints the tarball name as npm does. The
  // first two packs are slow and the last two fast, so with two children at
  // a time the slow pair runs together and the fast pair starts only once one
  // of them has finished; the fast packs then finish out of entry order.
  const command = fakeNpm(root, `
    import { basename, join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const destination = args[args.length - 1];
    const name = basename(process.cwd());
    const started = Date.now();
    const delay = name === 'package-0' || name === 'package-1' ? 400 : 50;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    writeFileSync(join(destination, name + '-1.0.0.tgz'), 'tarball');
    writeFileSync(join(destination, '..', 'span-' + name), started + ' ' + Date.now());
    console.log(args.join(' '));
    console.log(name + '-1.0.0.tgz');
  `);
  const entries = entriesFor(root, ['@paperclipai/server', '@paperclipai/db', '@paperclipai/shared', 'paperclipai']);
  const registered = [];
  const packs = await packStagedPackages(entries, { logDir: root, concurrency: 2, register: handle => registered.push(handle), command });
  assert.deepEqual(packs.map(({ name }) => name), entries.map(({ name }) => name));
  assert.deepEqual(packs.map(({ index }) => index), [0, 1, 2, 3]);
  for (const [index, pack] of packs.entries()) {
    assert.equal(pack.tarball, join(root, `pack-${index}`, `package-${index}-1.0.0.tgz`));
    assert.equal(readFileSync(pack.tarball, 'utf8'), 'tarball');
    assert.ok(Number.isInteger(pack.durationMs) && pack.durationMs >= 0);
    const log = readFileSync(join(root, `pack-${index}.log`), 'utf8');
    assert.equal(log.split('\n')[0], `pack --ignore-scripts --pack-destination ${join(root, `pack-${index}`)}`);
  }
  assert.equal(registered.length, 4, 'every pack is registered for cleanup as it starts');
  for (const handle of registered) assert.equal(handle.child.exitCode, 0);
  const span = name => readFileSync(join(root, `span-${name}`), 'utf8').split(' ').map(Number);
  const [slowA, slowB, fastA, fastB] = ['package-0', 'package-1', 'package-2', 'package-3'].map(span);
  assert.ok(slowA[0] < slowB[1] && slowB[0] < slowA[1], 'the two slow packs ran at the same time');
  const firstSlowEnd = Math.min(slowA[1], slowB[1]);
  assert.ok(fastA[0] >= firstSlowEnd - 50 && fastB[0] >= firstSlowEnd - 50, 'a third pack starts only once a slot is free');
  const timings = packTimings(packs, 2);
  assert.equal(timings.pack_concurrency, 2);
  assert.equal(timings.pack_serial_ms, packs.reduce((total, { durationMs }) => total + durationMs, 0));
  assert.equal(timings.pack_longest_ms, Math.max(...packs.map(({ durationMs }) => durationMs)));
}));

test('a failed pack rejects with the tail of its log, launches nothing more, and leaves the running pack to be stopped', async () => withScratch(async root => {
  const command = fakeNpm(root, `
    import { basename } from 'node:path';
    if (basename(process.cwd()) === 'package-1') { console.error('pack exploded'); process.exit(2); }
    setTimeout(() => {}, 30_000);
  `);
  const entries = entriesFor(root, ['@paperclipai/server', '@paperclipai/db', '@paperclipai/shared', 'paperclipai']);
  const registered = [];
  await assert.rejects(packStagedPackages(entries, { logDir: root, concurrency: 2, register: handle => registered.push(handle), command }), /pack-1 prefetch failed \(exit 2\): pack exploded/);
  await settle(100);
  assert.equal(registered.length, 2, 'the two queued packs never start after the failure');
  assert.equal(registered[0].child.exitCode, null, 'the other pack is still running when the failure surfaces');
  assert.ok(!existsSync(join(root, 'pack-2')) && !existsSync(join(root, 'pack-3')));
  await stopPrefetches(registered);
  assert.notEqual(registered[0].child.signalCode ?? registered[0].child.exitCode, null);
}));

test('a pack that exits without producing exactly one tarball is a failure', async () => withScratch(async root => {
  const command = fakeNpm(root, `
    import { basename, join } from 'node:path';
    import { writeFileSync } from 'node:fs';
    const destination = process.argv[process.argv.length - 1];
    const name = basename(process.cwd());
    if (name === 'package-0') { writeFileSync(join(destination, 'a.tgz'), ''); writeFileSync(join(destination, 'b.tgz'), ''); }
  `);
  const entries = entriesFor(root, ['@paperclipai/server', '@paperclipai/db']);
  await assert.rejects(packStagedPackages(entries, { logDir: root, concurrency: 1, command }), /@paperclipai\/server pack produced 2 tarballs/);
  assert.deepEqual(readdirSync(root).filter(name => name.startsWith('pack-') && !name.endsWith('.log')), ['pack-0'], 'the second pack never started');
  await assert.rejects(packStagedPackages([entries[1]], { logDir: root, concurrency: 1, command }), /@paperclipai\/db pack produced 0 tarballs/);
}));

test('no entries resolve at once', async () => withScratch(async root => {
  assert.deepEqual(await packStagedPackages([], { logDir: root, concurrency: 2, command: [process.execPath, '-e', ''] }), []);
}));
