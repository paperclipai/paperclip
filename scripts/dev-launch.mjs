import { spawn } from "node:child_process";

// Entry point for .claude/launch.json. The launcher spawns this without a shell,
// so it has to name a real executable: `node` exists everywhere, while Windows has
// no pnpm binary to spawn directly (only pnpm.cmd/.ps1, which raise ENOENT/EINVAL).
// TMPDIR=/tmp keeps sandbox temp paths short on POSIX and is meaningless on Windows.
const env = { ...process.env };
if (process.platform !== "win32") env.TMPDIR = "/tmp";

const isWindows = process.platform === "win32";

// Passed as one command string rather than command + args, which keeps shell: true
// from tripping DEP0190. On POSIX the child gets its own process group so a signal
// can reach the whole `sh -> pnpm -> node` chain rather than just the shell.
const child = spawn("pnpm dev", {
  stdio: "inherit",
  env,
  shell: true,
  detached: !isWindows,
});

/**
 * Terminate the child *and its descendants*.
 *
 * Signalling the shell alone is not enough: it leaves pnpm, the tsx dev runner
 * and the embedded PostgreSQL postmaster running, still holding the server and
 * database ports. The next start then finds a port owned by a process whose
 * parent is gone, cannot identify it, and falls back to a second postmaster over
 * the same data directory.
 *
 * POSIX gets the negative pid, which signals the whole process group created by
 * `detached`. Windows has no equivalent, so walk the tree with taskkill /T.
 */
function terminateChildTree(signal) {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  if (isWindows) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on("error", () => {
      // taskkill missing is not worth failing shutdown over; fall back to the
      // direct kill, which at least stops the shell.
      child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or the pid was never grouped.
    child.kill(signal);
  }
}

let terminating = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(signal, () => {
    if (terminating) return;
    terminating = true;
    terminateChildTree(signal);
  });
}

child.on("error", (error) => {
  console.error(`[dev-launch] could not start "pnpm dev": ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
