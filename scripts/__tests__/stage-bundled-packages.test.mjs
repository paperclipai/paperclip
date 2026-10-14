import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stopPrefetches } from '../prefetch-child.mjs';
import { PREPARE_BUNDLED_PACKAGE_SCRIPT, bundledInstallTimings, bundledPackageSlug, startBundledInstalls } from '../stage-bundled-packages.mjs';

// A small local script stands in for `prepare-bundled-package.mjs`; no test
// here needs npm or a network.
const withScratch = async body => {
  const root = mkdtempSync(join(tmpdir(), 'stage-bundled-packages-'));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const entriesFor = (root, names) => names.map((name, index) => ({ name, stagedSource: join(root, `source-${index}`), target: join(root, `package-${index}`) }));
const fakeScript = (root, body) => { const script = join(root, 'fake-prepare.mjs'); writeFileSync(script, body); return script; };

test('package names map to stable log and timing slugs', () => {
  assert.equal(bundledPackageSlug('@paperclipai/server'), 'server');
  assert.equal(bundledPackageSlug('@paperclipai/adapter-utils'), 'adapter_utils');
  assert.equal(bundledPackageSlug('@paperclipai/db'), 'db');
});

test('the children run the CLI entry release.sh uses, never an in-process call', () => {
  assert.ok(existsSync(PREPARE_BUNDLED_PACKAGE_SCRIPT));
  const source = readFileSync(PREPARE_BUNDLED_PACKAGE_SCRIPT, 'utf8');
  assert.ok(source.includes('if (process.argv[1] === fileURLToPath(import.meta.url))'));
  assert.ok(source.includes('prepareBundledPackage(resolve(sourceDir), resolve(destinationDir))'));
  const release = readFileSync(new URL('../release.sh', import.meta.url), 'utf8');
  assert.match(release, /node "\$REPO_ROOT\/scripts\/prepare-bundled-package\.mjs" "\$REPO_ROOT\/\$pkg_dir" "\$publish_dir"/);
});

test('the installs run at the same time, each with its own source and target', async () => withScratch(async root => {
  // Each child records its arguments, announces itself, and exits only once
  // the other child has announced itself too. Serial children would deadlock
  // here and the five-second guard would turn that into a failure.
  const script = fakeScript(root, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { basename, join } from 'node:path';
    const [source, target] = process.argv.slice(2);
    const root = join(target, '..');
    writeFileSync(join(root, 'started-' + basename(target)), '');
    console.log('install ' + source + ' -> ' + target);
    const other = basename(target) === 'package-0' ? 'package-1' : 'package-0';
    const deadline = Date.now() + 5000;
    while (!existsSync(join(root, 'started-' + other))) {
      if (Date.now() > deadline) { console.error('the other install never started'); process.exit(3); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    writeFileSync(join(target, 'package.json'), '{}');
  `);
  const entries = entriesFor(root, ['@paperclipai/server', '@paperclipai/db']);
  for (const { target } of entries) mkdirSync(target);
  const installs = startBundledInstalls(entries, { logDir: root, cwd: root, script });
  assert.deepEqual(installs.map(({ slug }) => slug), ['server', 'db']);
  await Promise.all(installs.map(({ handle }) => handle.done));
  for (const [index, { stagedSource, target, slug, handle }] of installs.entries()) {
    assert.equal(handle.child.exitCode, 0);
    assert.equal(readFileSync(join(root, `bundled-${slug}.log`), 'utf8'), `install ${stagedSource} -> ${target}\n`);
    assert.equal(target, join(root, `package-${index}`));
    assert.ok(existsSync(join(target, 'package.json')));
  }
  const timings = bundledInstallTimings(installs);
  assert.deepEqual(Object.keys(timings), ['stage_bundled_server_ms', 'stage_bundled_db_ms']);
  for (const value of Object.values(timings)) assert.ok(Number.isInteger(value) && value >= 0);
}));

test('stopping the installs after one fails also stops the npm process the other started', { skip: process.platform === 'win32' && 'process groups are POSIX only' }, async () => withScratch(async root => {
  // The real wrapper blocks in `execFileSync('npm', ['install', ...])`; here
  // the stand-in npm announces its pid and runs on, and the wrapper blocks on
  // it the same way. Stopping only the wrapper would leave it writing.
  const script = fakeScript(root, `
    import { execFileSync } from 'node:child_process';
    const [, target] = process.argv.slice(2);
    if (target.endsWith('package-1')) { console.error('bundled install exploded'); process.exit(2); }
    execFileSync(process.execPath, ['-e', "process.stdout.write('npm ' + process.pid + '\\\\n'); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
  `);
  const installs = startBundledInstalls(entriesFor(root, ['@paperclipai/server', '@paperclipai/db']), { logDir: root, cwd: root, script });
  await assert.rejects(Promise.all(installs.map(({ handle }) => handle.done)), /bundled-db prefetch failed \(exit 2\)/);
  const log = join(root, 'bundled-server.log');
  const logHasPid = () => existsSync(log) && /npm \d+/.test(readFileSync(log, 'utf8'));
  for (let attempt = 0; attempt < 200 && !logHasPid(); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  const npmPid = Number(readFileSync(log, 'utf8').match(/npm (\d+)/)[1]);
  const alive = pid => { try { process.kill(pid, 0); return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch (error) { return error.code !== 'ESRCH'; } };
  assert.ok(alive(npmPid), 'the stand-in npm runs before the stop');
  await stopPrefetches(installs.map(({ handle }) => handle));
  let stopped = false;
  for (let attempt = 0; attempt < 200 && !(stopped = !alive(npmPid)); attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(stopped, `stand-in npm ${npmPid} outlived stopPrefetches`);
  assert.notEqual(installs[0].handle.child.signalCode ?? installs[0].handle.child.exitCode, null);
}));

test('a failed install rejects with the tail of its own log and leaves the others to be stopped', async () => withScratch(async root => {
  const script = fakeScript(root, `
    const [, target] = process.argv.slice(2);
    if (target.endsWith('package-1')) { console.error('bundled install exploded'); process.exit(2); }
    setTimeout(() => {}, 30_000);
  `);
  const installs = startBundledInstalls(entriesFor(root, ['@paperclipai/server', '@paperclipai/adapter-utils']), { logDir: root, cwd: root, script });
  await assert.rejects(Promise.all(installs.map(({ handle }) => handle.done)), /bundled-adapter_utils prefetch failed \(exit 2\): bundled install exploded/);
  assert.equal(installs[0].handle.child.exitCode, null, 'the other install is still running when the failure surfaces');
  await stopPrefetches(installs.map(({ handle }) => handle));
  assert.notEqual(installs[0].handle.child.signalCode ?? installs[0].handle.child.exitCode, null);
}));
