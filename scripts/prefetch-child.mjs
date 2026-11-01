// Background downloads for verification scripts: start a child early with its
// output in a log file, join it where the result is needed, and stop it before
// the scratch directory it writes into is removed. No shell, no inherited
// terminal, and a failure is reported where the caller awaits it.
//
// A child may start processes of its own: the bundled-dependency installs are
// a Node wrapper blocked in `npm install`. Signalling only the wrapper would
// leave npm writing into the scratch root while it is removed, so on POSIX
// each command runs under `prefetch-supervisor.mjs` as the leader of its own
// process group, and stopping signals and waits for the whole group. A group
// of its own no longer receives the terminal's Ctrl-C, and the parent cannot
// forward it: the verifier spends most of its time blocked in `execFileSync`,
// where no JavaScript signal handler can run, and installing one would also
// replace the parent's immediate default termination. Instead the supervisor
// holds a pipe from the parent and stops its group when the pipe closes, which
// the kernel does when the parent exits for any reason. The parent installs
// no signal handlers.
//
// Windows has no process groups and `kill` there ends a process outright, so a
// signalled supervisor could pass nothing on and its command would run on
// after cleanup returned. There a deliberate stop goes through the same pipe
// as a written request, which the supervisor answers by ending its command,
// and only the SIGKILL escalation targets the supervisor itself.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PREFETCH_SUPERVISOR_SCRIPT = fileURLToPath(new URL('./prefetch-supervisor.mjs', import.meta.url));

const GROUPS = process.platform !== 'win32';
const running = child => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Signals the child's whole process group (POSIX). Without groups the
// supervisor is asked to stop its command through the pipe it watches, since
// `kill` would end the supervisor at once and leave the command running; only
// SIGKILL is sent to the supervisor itself, after it has had its chance.
const signalTree = (child, signal) => {
  if (child.pid === undefined) return;
  if (!GROUPS) {
    if (!running(child)) return;
    if (signal === 'SIGKILL') child.kill(signal);
    else if (child.stdin?.writable) child.stdin.end('stop\n');
    return;
  }
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
// True while any member of the child's group exists. On a platform without
// groups only the child itself is known.
const treeAlive = child => {
  if (child.pid === undefined) return false;
  if (!GROUPS) return running(child);
  try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

// Returns { name, child, done, durationMs }. `child` is the supervisor, whose
// exit code or signal is the command's. `done` resolves on exit code 0 and
// otherwise rejects with the tail of the log; the rejection is observed here
// so an unawaited failure never surfaces as an unhandled rejection.
export function startPrefetch({ name, cmd, args, cwd, env, logPath }) {
  const startedAt = Date.now();
  const log = openSync(logPath, 'w');
  let child;
  try {
    // stdin is the pipe the supervisor watches; nothing is ever written to it.
    child = spawn(process.execPath, [PREFETCH_SUPERVISOR_SCRIPT, cmd, ...args], { cwd, env, stdio: ['pipe', log, log], detached: GROUPS });
  } finally {
    closeSync(log); // the child holds its own descriptor
  }
  child.stdin?.on('error', () => {});
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

// Stops every prefetch that is still running, together with any process it
// started, and resolves only once all of them have exited, so the caller can
// remove their working directory without racing a write. A tree that ignores
// SIGTERM is killed after `graceMs`; one that still exists `graceMs` after
// that is given up on so cleanup cannot hang.
export async function stopPrefetches(prefetches, { graceMs = 5000 } = {}) {
  await Promise.all(prefetches.map(async ({ child, done }) => {
    const started = Date.now();
    let termed = false, killed = false;
    while (treeAlive(child)) {
      const elapsed = Date.now() - started;
      if (!termed) { signalTree(child, 'SIGTERM'); termed = true; }
      else if (!killed && elapsed >= graceMs) { signalTree(child, 'SIGKILL'); killed = true; }
      else if (killed && elapsed >= 2 * graceMs) break;
      await sleep(25);
    }
    try { await done; } catch {}
  }));
}
