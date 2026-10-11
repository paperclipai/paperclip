import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startPrefetch, stopPrefetches } from '../prefetch-child.mjs';

// Small local Node children stand in for the image pull and the Grok download;
// none of these tests needs Docker or a network.
const withScratch = async body => {
  const root = mkdtempSync(join(tmpdir(), 'prefetch-child-'));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const start = (root, name, script, cmd = process.execPath, args = ['-e', script]) =>
  startPrefetch({ name, cmd, args, cwd: root, env: process.env, logPath: join(root, `${name}.log`) });
const blockFor = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const untilLogHas = async (path, text) => {
  for (let attempt = 0; attempt < 400; attempt++) {
    try { if (readFileSync(path, 'utf8').includes(text)) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`log never contained ${text}`);
};

test('a successful prefetch resolves, keeps its output, and is left alone by stop', async () => withScratch(async root => {
  const handle = start(root, 'ok', "setTimeout(() => process.stdout.write('fetched\\n'), 150)");
  await handle.done;
  assert.equal(handle.child.exitCode, 0);
  assert.equal(readFileSync(join(root, 'ok.log'), 'utf8'), 'fetched\n');
  assert.ok(handle.durationMs >= 100 && handle.durationMs < 5000, `durationMs ${handle.durationMs}`);
  await stopPrefetches([handle]);
  assert.equal(handle.child.signalCode, null);
}));

test('the duration ends at the download, not when a blocked parent notices the exit', async () => withScratch(async root => {
  const handle = start(root, 'early', "setTimeout(() => process.stdout.write('Status: Downloaded\\n'), 100)");
  // Synchronous work in the parent, as package staging is in the verifier.
  blockFor(1500);
  const noticed = Date.now();
  await handle.done;
  assert.ok(Date.now() - noticed < 500, 'the exit was pending by the time the parent yielded');
  assert.ok(handle.durationMs < 900, `durationMs ${handle.durationMs} must not include the 1500ms the parent was blocked`);
}));

test('a nonzero exit rejects with the log tail where the result is awaited', async () => withScratch(async root => {
  const handle = start(root, 'bad', "process.stderr.write('registry unreachable\\n'); process.exit(3)");
  await assert.rejects(handle.done, /^Error: bad prefetch failed \(exit 3\): registry unreachable$/);
  await stopPrefetches([handle]);
}));

test('a command that cannot start rejects instead of hanging the join or the stop', async () => withScratch(async root => {
  const handle = start(root, 'missing', '', join(root, 'no-such-command'), []);
  await assert.rejects(handle.done, /missing prefetch failed \(.*ENOENT/);
  await stopPrefetches([handle]);
}));

test('stopping a running prefetch waits for it to exit so its directory can be removed safely', async () => withScratch(async root => {
  const handle = start(root, 'slow', "process.stdout.write('started\\n'); setInterval(() => {}, 1000)");
  await untilLogHas(join(root, 'slow.log'), 'started');
  const stopping = Date.now();
  await stopPrefetches([handle]);
  assert.ok(Date.now() - stopping < 4000);
  assert.equal(handle.child.signalCode, 'SIGTERM');
  assert.equal(handle.child.exitCode, null);
  await assert.rejects(handle.done, /slow prefetch failed \(SIGTERM\): started/);
}));

test('a prefetch that ignores SIGTERM is killed after the grace period', async () => withScratch(async root => {
  const handle = start(root, 'stubborn', "process.on('SIGTERM', () => {}); process.stdout.write('ignoring\\n'); setInterval(() => {}, 1000)");
  await untilLogHas(join(root, 'stubborn.log'), 'ignoring');
  const stopping = Date.now();
  await stopPrefetches([handle], { graceMs: 200 });
  assert.ok(Date.now() - stopping >= 200 && Date.now() - stopping < 4000);
  assert.equal(handle.child.signalCode, 'SIGKILL');
}));

test('an unawaited failure never becomes an unhandled rejection', () => {
  const script = `
    import { startPrefetch } from ${JSON.stringify(new URL('../prefetch-child.mjs', import.meta.url).href)};
    import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
    const root = mkdtempSync(join(tmpdir(), 'prefetch-unawaited-'));
    try {
      startPrefetch({ name: 'ignored', cmd: process.execPath, args: ['-e', 'process.exit(2)'], cwd: root, env: process.env, logPath: join(root, 'ignored.log') });
      await new Promise(resolve => setTimeout(resolve, 500));
      console.log('still running');
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still running/);
  assert.doesNotMatch(result.stderr, /unhandled/i);
});
