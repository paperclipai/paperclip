#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */

/**
 * PM2 PTY runner.
 *
 * PM2's default child stdio is file-based pipes, which means the
 * spawned Claude CLI sees stdin/stdout as non-TTY and auto-falls
 * back to --print mode (then errors out because no prompt was
 * provided). Claude channel mode requires a real terminal.
 *
 * This runner is what PM2 actually spawns. It uses node-pty to
 * allocate a pseudo-terminal and spawns the target binary in it.
 * The pty output is written to this runner's stdout, which PM2
 * captures to log files.
 *
 * Usage (set by ProcessBackend.spawn):
 *   script: /path/to/pty-runner.cjs
 *   args:   [<claude-binary>, <claude-arg-1>, <claude-arg-2>, ...]
 *
 * CommonJS (.cjs) — no TS/ESM loader magic, works under any Node.
 */

const pty = require("node-pty");

const [, , script, ...args] = process.argv;

if (!script) {
  console.error("[pty-runner] Usage: pty-runner.cjs <script> [args...]");
  process.exit(2);
}

const child = pty.spawn(script, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: {
    ...process.env,
    TERM: "xterm-256color",
    FORCE_COLOR: "1",
  },
});

child.onData((data) => {
  try {
    process.stdout.write(data);
  } catch {
    /* stdout closed */
  }
});

child.onExit(({ exitCode, signal }) => {
  console.error(
    `[pty-runner] child exited code=${exitCode} signal=${signal ?? "null"}`,
  );
  process.exit(exitCode ?? 0);
});

process.stdin.on("data", (data) => {
  try {
    child.write(data.toString());
  } catch {
    /* child closed */
  }
});

process.on("SIGTERM", () => {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
});
process.on("SIGINT", () => {
  try {
    child.kill("SIGINT");
  } catch {
    /* ignore */
  }
});

console.error(`[pty-runner] spawned ${script} with ${args.length} arg(s)`);

/*
 * Auto-accept Claude Code's startup prompts:
 *
 *   1. Workspace trust prompt ("Is this a project you trust?") —
 *      fires a few seconds after start, Enter selects the default
 *      highlighted option "Yes, I trust this folder".
 *   2. Development channels consent — may show after trust.
 *
 * We mimic the company-os v1 behavior: send CR at ~2s / ~6s / ~10s.
 * Later Enters are no-ops if the CLI has already reached its idle
 * waiting state.
 */
const AUTO_ENTER_DELAYS_MS = [2000, 6000, 10000];
for (const delay of AUTO_ENTER_DELAYS_MS) {
  setTimeout(() => {
    try {
      child.write("\r");
    } catch {
      /* child gone — noop */
    }
  }, delay);
}
