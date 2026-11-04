import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
  // The parent keeps its default, immediate termination: no handler of ours.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(process.listenerCount(signal), 0, `${signal} handler installed in the parent`);
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

test('a prefetch that ignores SIGTERM is killed after the grace period', { skip: process.platform === 'win32' && 'SIGTERM cannot be ignored on Windows' }, async () => withScratch(async root => {
  const handle = start(root, 'stubborn', "process.on('SIGTERM', () => {}); process.stdout.write('ignoring\\n'); setInterval(() => {}, 1000)");
  await untilLogHas(join(root, 'stubborn.log'), 'ignoring');
  const stopping = Date.now();
  await stopPrefetches([handle], { graceMs: 200 });
  assert.ok(Date.now() - stopping >= 200 && Date.now() - stopping < 4000);
  assert.equal(handle.child.signalCode, 'SIGKILL');
}));

// A process is gone once the kernel no longer knows it, or once it is a zombie
// that only waits to be reaped: either way it can no longer write anywhere.
const gone = pid => {
  try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
  try { return /^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};
const untilGone = async pid => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (gone(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
};
// The child starts a process of its own that announces its pid and then runs
// on, the way the bundled-dependency installs block in `npm install`.
const GRANDCHILD_SCRIPT = `
  const { spawn } = require('node:child_process');
  const grandchild = spawn(process.execPath, ['-e', "process.stdout.write('grandchild ' + process.pid + '\\\\n'); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
  grandchild.on('exit', () => process.exit(0));
`;
const grandchildPid = async log => { await untilLogHas(log, 'grandchild '); return Number(readFileSync(log, 'utf8').match(/grandchild (\d+)/)[1]); };

test('stopping a prefetch also stops the processes it started', { skip: process.platform === 'win32' && 'process groups are POSIX only' }, async () => withScratch(async root => {
  const handle = start(root, 'tree', GRANDCHILD_SCRIPT);
  const pid = await grandchildPid(join(root, 'tree.log'));
  assert.ok(!gone(pid), 'the grandchild runs before the stop');
  await stopPrefetches([handle]);
  assert.ok(await untilGone(pid), `grandchild ${pid} outlived stopPrefetches`);
  assert.notEqual(handle.child.signalCode ?? handle.child.exitCode, null);
}));

test('a stop request written to the pipe ends the command and the processes it started, with no signal to the supervisor', { skip: process.platform === 'win32' && 'the grandchild check reads /proc' }, async () => withScratch(async root => {
  // This is the stop path on a platform without process groups: there `kill`
  // would end the supervisor outright and leave its command running, so
  // `stopPrefetches` writes a request instead. The supervisor answers it
  // the way it answers the parent's exit, and its own exit still reports the
  // command's fate.
  const handle = start(root, 'tree', GRANDCHILD_SCRIPT);
  const pid = await grandchildPid(join(root, 'tree.log'));
  handle.child.stdin.end('stop\n');
  await assert.rejects(handle.done, /tree prefetch failed \(SIGTERM\)/);
  assert.ok(await untilGone(pid), `grandchild ${pid} outlived the stop request`);
  assert.match(readFileSync(join(root, 'tree.log'), 'utf8'), /stop requested; stopping/);
  assert.doesNotMatch(readFileSync(join(root, 'tree.log'), 'utf8'), /parent exited/);
  await stopPrefetches([handle]);
}));

// A separate parent process stands in for the verifier: it starts a prefetch
// whose child starts a grandchild, then does `work` (a module-scope statement).
const parentScript = (root, work) => `
  import { execFileSync } from 'node:child_process';
  import { startPrefetch } from ${JSON.stringify(new URL('../prefetch-child.mjs', import.meta.url).href)};
  startPrefetch({ name: 'tree', cmd: process.execPath, args: ['-e', ${JSON.stringify(GRANDCHILD_SCRIPT)}], cwd: ${JSON.stringify(root)}, env: process.env, logPath: ${JSON.stringify(join(root, 'tree.log'))} });
  ${work}
`;

for (const signal of ['SIGINT', 'SIGKILL']) {
  test(`${signal} to the parent ends the processes a prefetch started, and the parent dies of it at once`, { skip: process.platform === 'win32' && 'process groups are POSIX only' }, async () => withScratch(async root => {
    // The parent runs no handler, so it dies of the signal immediately, and the
    // prefetch tree stops because the parent is gone, not because it was told:
    // SIGKILL leaves the parent no chance to tell anyone anything.
    const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript(root, 'setInterval(() => {}, 1000);')], { cwd: root, stdio: 'ignore' });
    const exited = new Promise(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
    const pid = await grandchildPid(join(root, 'tree.log'));
    parent.kill(signal);
    assert.deepEqual(await exited, { code: null, signal });
    assert.ok(await untilGone(pid), `grandchild ${pid} outlived the parent's ${signal}`);
    assert.match(readFileSync(join(root, 'tree.log'), 'utf8'), /parent exited; stopping/);
  }));
}

test('Ctrl-C while the parent is blocked in synchronous work stops it at once, and the prefetch tree with it', { skip: process.platform === 'win32' && 'process groups are POSIX only' }, async () => withScratch(async root => {
  // The verifier runs `execFileSync` for the standalone builds while prefetches
  // run, and a JavaScript signal handler cannot run until that returns. The
  // parent gets its own group here so the signal can be sent the way a
  // terminal sends Ctrl-C: to the foreground group, which is the parent and
  // its synchronous command, and not the detached prefetch tree.
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript(root, "execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });")], { cwd: root, stdio: 'ignore', detached: true });
  try {
    const exited = new Promise(resolve => parent.once('exit', (code, signal) => resolve({ code, signal })));
    const pid = await grandchildPid(join(root, 'tree.log'));
    const signalled = Date.now();
    process.kill(-parent.pid, 'SIGINT');
    assert.deepEqual(await exited, { code: null, signal: 'SIGINT' });
    assert.ok(Date.now() - signalled < 2000, `the parent took ${Date.now() - signalled}ms to die: it waited for the synchronous command`);
    assert.ok(await untilGone(pid), `grandchild ${pid} outlived the parent's Ctrl-C`);
  } finally {
    try { process.kill(-parent.pid, 'SIGKILL'); } catch {}
  }
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
