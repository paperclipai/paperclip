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
    sourceDir: path.join(rootDir, "packages/shared/src"),
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    output: path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
    sourceDir: path.join(rootDir, "packages/plugins/sdk/src"),
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

function newestSourceMtimeMs(sourceDir) {
  let newest = 0;

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!/\.(tsx?|json)$/.test(entry.name)) continue;
      newest = Math.max(newest, fs.statSync(entryPath).mtimeMs);
    }
  }

  visit(sourceDir);
  return newest;
}

function needsBuild(target) {
  if (!fs.existsSync(target.output)) return true;
  const outputMtime = fs.statSync(target.output).mtimeMs;
  return newestSourceMtimeMs(target.sourceDir) > outputMtime;
}

function allOutputsCurrent() {
  return buildTargets.every((target) => !needsBuild(target));
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
    if (allOutputsCurrent()) {
      return;
    }
    sleep(lockPollMs);
  }

  throw new Error(`Timed out waiting for plugin build dependency lock at ${lockDir}`);
}

if (allOutputsCurrent()) {
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
      if (!allOutputsCurrent()) {
        throw new Error("Plugin build dependency lock released before all outputs were created");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (!needsBuild(target)) {
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
