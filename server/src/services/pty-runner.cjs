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

// Env allowlist — do NOT spread process.env. PM2's daemon inherits
// the full env from whatever process first called pm2.connect()
// (our COS v2 server), so `process.env` inside this runner contains
// every server secret (DB url, JWT secrets, etc.). The claude child
// should only see the minimum set it needs to boot and locate its
// own project history.
const ALLOW_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "CLAUDE_PROJECT_DIR",
  "COS_API_URL",
  "COS_COMPANY_ID",
  "COS_AGENT_ID",
  "COS_SESSION_ID",
];
const childEnv = {
  TERM: "xterm-256color",
  FORCE_COLOR: "1",
};
for (const key of ALLOW_ENV) {
  if (process.env[key]) childEnv[key] = process.env[key];
}
// Ensure the target binary's directory is in PATH so posix_spawnp
// can find it. PM2 daemon inherits a limited PATH from pnpm dev
// which may not include /opt/homebrew/bin or ~/.local/bin.
const scriptDir = require("node:path").dirname(script);
if (childEnv.PATH && !childEnv.PATH.split(":").includes(scriptDir)) {
  childEnv.PATH = `${scriptDir}:${childEnv.PATH}`;
}

// Log what we're about to spawn BEFORE attempting, so errors are diagnosable.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

console.error(`[pty-runner] binary: ${script}`);
console.error(`[pty-runner] args: ${JSON.stringify(args)}`);
console.error(`[pty-runner] cwd: ${process.cwd()}`);
console.error(`[pty-runner] PATH: ${childEnv.PATH ?? "(none)"}`);

// Verify binary exists before spawning — posix_spawnp gives no detail.
let resolvedScript = script;
try {
  fs.accessSync(script, fs.constants.X_OK);
} catch {
  console.error(`[pty-runner] binary not found at ${script}, trying which...`);
  try {
    resolvedScript = execFileSync("which", [script], { encoding: "utf8" }).trim();
    console.error(`[pty-runner] which resolved to: ${resolvedScript}`);
  } catch {
    console.error(`[pty-runner] FATAL: cannot find executable '${script}' anywhere`);
    process.exit(127);
  }
}

const child = pty.spawn(resolvedScript, args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: process.cwd(),
  env: childEnv,
});

// The primary child.onData handler is installed below (after the
// auto-accept state is declared) so it can inspect output AND forward
// it to stdout in a single pass.

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
 * Auto-accept Claude Code startup prompts — but ONLY when we detect
 * the specific prompt text in the pty output. Blind timer-based Enter
 * presses could dismiss dialogs that should require explicit operator
 * action, or inject stray input into the interactive session once
 * Claude reaches its ready state.
 *
 * Prompts we auto-accept (default option highlighted is always
 * "Yes, I trust" / "I am using this for local development"):
 *   1. Workspace trust — "Is this a project you trust?"
 *   2. Development channels consent — "WARNING: Loading development channels"
 *
 * Once we detect "Listening for channel messages" the session has
 * reached its ready state and we stop sending synthetic input — any
 * further injection would interfere with Claude's running session.
 */
let sessionReady = false;
const acceptedPrompts = new Set();
const PROMPT_PATTERNS = [
  {
    // Claude's workspace trust prompt. Historically: "Is this a project you
    // trust?". As of 2026-04 it's "Is this a project you created or one
    // you trust?". Match both with a non-greedy wildcard + anchor on the
    // unique "Quick safety check" header that precedes the question.
    key: "workspace-trust",
    needle: /Quick safety check|Is this a project you .*?trust/is,
  },
  {
    key: "dev-channels",
    needle: /WARNING:\s*Loading development channels/i,
  },
];

// Strip ANSI escape sequences for reliable pattern matching.
//
// IMPORTANT: Claude renders its TUI by emitting `ESC [ <N> C` (Cursor
// Forward) between words instead of literal spaces. Naively stripping
// all CSI sequences deletes those separators and collapses "Is this a
// project you trust" into "Isthisaprojectyoutrust", breaking every
// word-boundary-sensitive needle above. So we do a two-pass strip:
//   1. Replace cursor-forward with the equivalent number of spaces.
//   2. Remove remaining CSI sequences as before.
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  const withSpaces = s.replace(/\u001B\[(\d*)C/g, (_m, n) => {
    const count = n ? Math.max(1, parseInt(n, 10)) : 1;
    // Cap replacement to keep buffer size sane even if Claude emits
    // something like ESC[999C on resize. 64 is >> any real word gap.
    return " ".repeat(Math.min(count, 64));
  });
  // eslint-disable-next-line no-control-regex
  return withSpaces.replace(/\u001B\[[0-9;?>]*[a-zA-Z]/g, "");
}

let outputBuffer = "";
const BUFFER_CAP = 32 * 1024;

child.onData((data) => {
  try {
    process.stdout.write(data);
  } catch {
    /* stdout closed */
  }

  // Detection runs on a rolling tail of stripped output
  outputBuffer += stripAnsi(data);
  if (outputBuffer.length > BUFFER_CAP) {
    outputBuffer = outputBuffer.slice(outputBuffer.length - BUFFER_CAP);
  }

  if (!sessionReady && /Listening for channel messages/i.test(outputBuffer)) {
    sessionReady = true;
    acceptedPrompts.clear();
    return;
  }

  if (sessionReady) return;

  for (const { key, needle } of PROMPT_PATTERNS) {
    if (acceptedPrompts.has(key)) continue;
    if (needle.test(outputBuffer)) {
      acceptedPrompts.add(key);
      // Small delay so the full prompt is rendered before we dismiss
      setTimeout(() => {
        try {
          child.write("\r");
        } catch {
          /* child gone */
        }
      }, 150);
    }
  }
});
