import { spawn } from "node:child_process";

// Entry point for .claude/launch.json. The launcher spawns this without a shell,
// so it has to name a real executable: `node` exists everywhere, while Windows has
// no pnpm binary to spawn directly (only pnpm.cmd/.ps1, which raise ENOENT/EINVAL).
// TMPDIR=/tmp keeps sandbox temp paths short on POSIX and is meaningless on Windows.
const env = { ...process.env };
if (process.platform !== "win32") env.TMPDIR = "/tmp";

// Passed as one command string rather than command + args, which keeps shell: true
// from tripping DEP0190.
const child = spawn("pnpm dev", { stdio: "inherit", env, shell: true });

child.on("error", (error) => {
  console.error(`[dev-launch] could not start "pnpm dev": ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
