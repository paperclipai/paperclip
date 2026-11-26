// Child side of prefetch-child.mjs: runs one prefetch command as the leader of
// its own process group and stops the whole group when the parent that started
// it is gone.
//
// The parent holds the write end of this process's stdin. The kernel closes
// that end when the parent exits for any reason: a Ctrl-C delivered while the
// parent is blocked in synchronous work, a plain `kill`, or SIGKILL. Reading
// EOF here is therefore the only parent-death signal needed, and the parent
// runs no signal handler of its own, so its default termination stays
// immediate. The parent writes to the pipe for one reason only: to ask for a
// deliberate stop where it cannot signal the group, which is Windows, where
// `kill` ends a process outright and a signalled supervisor could not pass
// anything on. Group-wide signals the parent sends through `stopPrefetches`
// on POSIX reach this process too; it passes them on to the command and stays
// alive until the command exits, so its own exit reports the command's
// outcome (exit code, or the same signal).
import { spawn } from 'node:child_process';
import { fstatSync } from 'node:fs';
import { constants } from 'node:os';

const GROUPS = process.platform !== 'win32';
const GRACE_MS = Number(process.env.PAPERCLIP_PREFETCH_GRACE_MS) || 5000;
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write('prefetch supervisor: usage: prefetch-supervisor.mjs <command> [args...]\n');
  process.exit(64);
}

const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
const signalChild = signal => { try { child.kill(signal); } catch {} };
// On POSIX this process leads the group (the parent starts it detached), so
// the group id is its own pid. Without groups only the command is known.
const signalGroup = signal => {
  if (!GROUPS) return signalChild(signal);
  try { process.kill(-process.pid, signal); } catch (error) { if (error.code === 'ESRCH') signalChild(signal); }
};

// A signal to the group arrives here as well as at the command; passing it on
// is harmless when the command already has it, and covers a signal sent to
// this process alone. The parent owns the SIGKILL escalation in that case.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => signalChild(signal));

let stopping = false;
const stopGroup = reason => {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`prefetch supervisor: ${reason}; stopping ${cmd}\n`);
  signalGroup('SIGTERM');
  setTimeout(() => signalGroup('SIGKILL'), GRACE_MS).unref();
};
// Only a pipe can carry a stop request or report the parent's exit (Node
// creates its stdio pipes as socket pairs). Run by hand with a terminal or
// /dev/null on stdin, there is no parent to watch and nothing is read.
let stdinIsPipe = false;
try { const stdin = fstatSync(0); stdinIsPipe = stdin.isFIFO() || stdin.isSocket(); } catch {}
if (stdinIsPipe) {
  process.stdin.on('data', () => stopGroup('stop requested'));
  const parentGone = () => stopGroup('parent exited');
  process.stdin.on('end', parentGone);
  process.stdin.on('close', parentGone);
  process.stdin.on('error', parentGone);
  process.stdin.resume();
}

child.on('error', error => {
  process.stderr.write(`prefetch supervisor: ${error.message}\n`);
  process.exit(127);
});
child.on('exit', (code, signal) => {
  if (signal !== null) {
    // Die of the same signal, so the parent sees the command's fate on this
    // process. Dropping the listener restores the default disposition first.
    process.removeAllListeners(signal);
    try { process.kill(process.pid, signal); } catch {}
    process.exit(128 + (constants.signals[signal] ?? 1));
  }
  process.exit(code ?? 1);
});
