#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const tscCliPath = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
const lockDir = path.join(rootDir, "node_modules", ".cache", "paperclip-plugin-build-deps.lock");
const lockTimeoutMs = 60_000;
const lockPollMs = 100;

const buildTargets = [
  {
    name: "@paperclipai/shared",
    output: path.join(rootDir, "packages/shared/dist/index.js"),
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    output: path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

function newestMtimeInDir(dir) {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  }
  return newest;
}

// Existence alone is not enough: a stale dist (e.g., predating recent src
// edits) silently produces wrong type-check errors in downstream plugins.
// Treat the output as up-to-date only if its mtime is at least as recent
// as the newest .ts/.tsx in src/ and the tsconfig itself.
function isFresh(target) {
  if (!fs.existsSync(target.output)) return false;
  const outputMtime = fs.statSync(target.output).mtimeMs;
  const srcDir = path.join(path.dirname(target.tsconfig), "src");
  const inputMtime = Math.max(
    newestMtimeInDir(srcDir),
    fs.statSync(target.tsconfig).mtimeMs,
  );
  return outputMtime >= inputMtime;
}

function allOutputsFresh() {
  return buildTargets.every(isFresh);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForLockRelease() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < lockTimeoutMs) {
    if (!fs.existsSync(lockDir)) {
      return;
    }
    if (allOutputsFresh()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allOutputsFresh()) {
  process.exit(0);
}

fs.mkdirSync(path.dirname(lockDir), { recursive: true });

let holdsLock = false;
let exitCode = 0;
try {
  try {
    fs.mkdirSync(lockDir);
    holdsLock = true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      waitForLockRelease();
      if (!allOutputsFresh()) {
        throw new Error("Plugin build dependency lock released before all outputs were created");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (isFresh(target)) {
      continue;
    }

    const result = spawnSync(process.execPath, [tscCliPath, "-p", target.tsconfig], {
      cwd: rootDir,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  if (holdsLock) {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
