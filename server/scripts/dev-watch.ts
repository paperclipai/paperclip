import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveServerDevWatchIgnorePaths } from "../src/dev-watch-ignore.ts";

const require = createRequire(import.meta.url);
const gracefulShutdownTimeoutMs = 10_000;

let tsxCliPath: string;
try {
  tsxCliPath = require.resolve("tsx/cli");
} catch {
  // Older installs may not expose tsx/cli; fall back to the package root lookup.
  const tsxRoot = path.dirname(require.resolve("tsx/package.json"));
  const tsxCliCandidates = [
    path.resolve(tsxRoot, "dist", "cli.mjs"),
    path.resolve(tsxRoot, "dist", "cli.js"),
  ];
  const fallbackTsxCliPath = tsxCliCandidates.find((candidate) => existsSync(candidate));
  if (!fallbackTsxCliPath) {
    throw new Error(`Failed to locate tsx CLI entrypoint under ${tsxRoot}`);
  }
  tsxCliPath = fallbackTsxCliPath;
}
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoreArgs = resolveServerDevWatchIgnorePaths(serverRoot).flatMap((ignorePath) => ["--exclude", ignorePath]);

const child = spawn(
  process.execPath,
  [tsxCliPath, "watch", ...ignoreArgs, "src/index.ts"],
  {
    cwd: serverRoot,
    env: process.env,
    stdio: "inherit",
  },
);

let shuttingDown = false;
let childExitWasExpected = false;
let childExited = false;

function exitForSignal(signal: NodeJS.Signals): never {
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(1);
}

const childExitPromise = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) => {
  child.on("exit", (code, signal) => {
    childExited = true;
    resolve({ code: code ?? 0, signal });
  });
});

child.on("exit", (code, signal) => {
  const expected = childExitWasExpected;
  childExitWasExpected = false;

  if (shuttingDown || expected) {
    return;
  }
  if (signal) {
    exitForSignal(signal);
  }
  process.exit(code ?? 0);
});

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  childExitWasExpected = true;
  child.kill(signal);
  const killTimer = setTimeout(() => {
    if (!childExited) {
      child.kill("SIGKILL");
    }
  }, gracefulShutdownTimeoutMs);

  try {
    const exit = await childExitPromise;
    if (exit.signal) {
      exitForSignal(exit.signal);
    }
    process.exit(exit.code);
  } finally {
    clearTimeout(killTimer);
  }
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
