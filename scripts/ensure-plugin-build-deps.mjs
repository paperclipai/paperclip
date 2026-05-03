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
    inputs: [
      path.join(rootDir, "packages/shared/src"),
      path.join(rootDir, "packages/shared/package.json"),
      path.join(rootDir, "packages/shared/tsconfig.json"),
    ],
  },
  {
    name: "@paperclipai/plugin-sdk",
    output: path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
    inputs: [
      path.join(rootDir, "packages/plugins/sdk/src"),
      path.join(rootDir, "packages/plugins/sdk/package.json"),
      path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
    ],
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

function latestMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function latestInputMtimeMs(inputPath) {
  let stats;
  try {
    stats = fs.statSync(inputPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }

  if (!stats.isDirectory()) return stats.mtimeMs;

  let latest = stats.mtimeMs;
  for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    latest = Math.max(latest, latestInputMtimeMs(path.join(inputPath, entry.name)));
  }
  return latest;
}

function targetIsFresh(target) {
  if (!fs.existsSync(target.output)) return false;
  const outputMtime = latestMtimeMs(target.output);
  const inputMtime = Math.max(...target.inputs.map((input) => latestInputMtimeMs(input)));
  return outputMtime >= inputMtime;
}

function allOutputsFresh() {
  return buildTargets.every((target) => targetIsFresh(target));
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
        throw new Error("Plugin build dependency lock released before all outputs were refreshed");
      }
      process.exit(0);
    }
    throw error;
  }

  for (const target of buildTargets) {
    if (targetIsFresh(target)) {
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
