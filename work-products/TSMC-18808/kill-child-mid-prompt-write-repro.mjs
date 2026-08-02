#!/usr/bin/env node
/**
 * Standalone deliberate repro for TSMC-18806 / TSMC-18808.
 *
 * Spawns children via runChildProcess, kills each mid deferred-stdin write window,
 * and asserts THIS parent process survives (exit 0). Pre-fix this killed the
 * control plane on unhandled EPIPE on child.stdin.
 *
 * Usage (from repo root, with workspace deps):
 *   node --import tsx/esm work-products/TSMC-18808/kill-child-mid-prompt-write-repro.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const require = createRequire(path.join(repoRoot, "package.json"));

// Prefer source via package exports (dev tree).
const { runChildProcess } = await import(
  path.join(repoRoot, "packages/adapter-utils/src/server-utils.ts")
).catch(async () => {
  // Fallback: resolve package name if tsx/path import unavailable.
  return import("@paperclipai/adapter-utils/server-utils");
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tsmc-18808-repro-"));
const childPath = path.join(tmp, "die.mjs");
fs.writeFileSync(childPath, "process.exit(42);\n");
fs.chmodSync(childPath, 0o755);

const prompt = "z".repeat(256 * 1024);
const uncaught = [];
process.on("uncaughtException", (err) => {
  uncaught.push(err);
  console.error("UNCAUGHT", err);
});

const parentPid = process.pid;
const started = Date.now();
const N = 20;
console.log(
  JSON.stringify({
    phase: "start",
    parentPid,
    n: N,
    promptBytes: prompt.length,
    childPath,
  }),
);

const results = [];
for (let i = 0; i < N; i++) {
  const result = await runChildProcess(`tsmc-18808-repro-${i}`, process.execPath, [childPath], {
    cwd: tmp,
    env: process.env,
    stdin: prompt,
    timeoutSec: 15,
    graceSec: 1,
    onLog: async () => {},
    onSpawn: async ({ pid }) => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already exited
      }
      await new Promise((r) => setTimeout(r, 50));
    },
  });
  results.push({
    i,
    exitCode: result.exitCode,
    signal: result.signal,
  });
}

fs.rmSync(tmp, { recursive: true, force: true });

const epipeUncaught = uncaught.filter((e) => e && (e.code === "EPIPE" || /EPIPE/.test(String(e))));
const out = {
  phase: "done",
  parentPid,
  stillAlive: true,
  elapsedMs: Date.now() - started,
  runs: results.length,
  epipeUncaught: epipeUncaught.length,
  sample: results.slice(0, 3),
  ok: epipeUncaught.length === 0 && results.length === N,
};
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 2);
