// Background downloads for verification scripts: start a child early with its
// output in a log file, join it where the result is needed, and stop it before
// the scratch directory it writes into is removed. No shell, no inherited
// terminal, and a failure is reported where the caller awaits it.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';

const running = child => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

// Returns { name, child, done, durationMs }. `done` resolves on exit code 0
// and otherwise rejects with the tail of the log; the rejection is observed
// here so an unawaited failure never surfaces as an unhandled rejection.
export function startPrefetch({ name, cmd, args, cwd, env, logPath }) {
  const startedAt = Date.now();
  const log = openSync(logPath, 'w');
  let child;
  try {
    child = spawn(cmd, args, { cwd, env, stdio: ['ignore', log, log] });
  } finally {
    closeSync(log); // the child holds its own descriptor
  }
  const handle = { name, child, done: null, durationMs: null };
  let settled = false;
  handle.done = new Promise((settle, reject) => {
    const finish = failure => {
      if (settled) return;
      settled = true;
      // The caller may be blocked in synchronous work when the child exits, so
      // this event can arrive long after the fact. When the child wrote
      // anything, its last write is the end time; both downloads this serves
      // print their final status line as they complete. A silent child falls
      // back to the time the exit was observed.
      let finishedAt = Date.now();
      try {
        const { mtimeMs, size } = statSync(logPath);
        if (size > 0) finishedAt = Math.min(finishedAt, mtimeMs);
      } catch {}
      handle.durationMs = Math.max(0, Math.round(finishedAt - startedAt));
      if (failure === null) return settle();
      let output = '';
      try { output = readFileSync(logPath, 'utf8').trim().slice(-2000); } catch {}
      reject(new Error(`${name} prefetch failed (${failure}): ${output}`));
    };
    child.once('error', error => finish(error.message));
    child.once('exit', (code, signal) => finish(code === 0 ? null : (signal ?? `exit ${code}`)));
  });
  handle.done.catch(() => {});
  return handle;
}

// Stops every prefetch that is still running and resolves only once all of
// them have exited, so the caller can remove their working directory without
// racing a write. A child that ignores SIGTERM is killed after `graceMs`.
export async function stopPrefetches(prefetches, { graceMs = 5000 } = {}) {
  await Promise.all(prefetches.map(async ({ child, done }) => {
    if (running(child)) child.kill('SIGTERM');
    const escalate = setTimeout(() => { if (running(child)) child.kill('SIGKILL'); }, graceMs);
    try { await done; } catch {} finally { clearTimeout(escalate); }
  }));
}
