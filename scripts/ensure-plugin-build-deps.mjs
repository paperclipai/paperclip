#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

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
    completion: path.join(rootDir, "packages/shared/dist/.paperclip-build-complete"),
    sourceDir: path.join(rootDir, "packages/shared/src"),
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    output: path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
    completion: path.join(rootDir, "packages/plugins/sdk/dist/.paperclip-build-complete"),
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
  if (!fs.existsSync(target.output) || !fs.existsSync(target.completion)) return true;
  const outputMtime = fs.statSync(target.output).mtimeMs;
  // Direct tsc invocations cannot certify completion. Rebuild their output
  // once through this helper; subsequent startups reuse the refreshed marker.
  if (outputMtime > fs.statSync(target.completion).mtimeMs) return true;
  return newestSourceMtimeMs(target.sourceDir) > outputMtime;
}

function allOutputsCurrent() {
  return buildTargets.every((target) => !needsBuild(target));
}

// Publish an already-populated directory so another contender never mistakes a
// newly acquired lock for an abandoned, ownerless lock. Never recursively remove
// the shared path: another process may have acquired it since we last read it.
const ownerFile = `owner-${process.pid}-${randomUUID()}.json`;
let child = null;
let stoppingSignal = null;
let holdsLock = false;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function removeOwner(file) {
  try {
    fs.unlinkSync(path.join(lockDir, file));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    fs.rmdirSync(lockDir);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function releaseLock() {
  if (!holdsLock) return;
  removeOwner(ownerFile);
  holdsLock = false;
}

function recoverAbandonedLock() {
  try {
    const entries = fs.readdirSync(lockDir);
    if (entries.length === 0) {
      // Older versions wrote no owner. Allow their bounded CLI build to finish
      // before reclaiming an empty directory left by interruption or timeout.
      if (Date.now() - fs.statSync(lockDir).mtimeMs < 120_000) return;
      fs.rmdirSync(lockDir);
    } else if (entries.length === 1 && /^owner-.*\.json$/.test(entries[0])) {
      const owner = JSON.parse(fs.readFileSync(path.join(lockDir, entries[0]), "utf8"));
      if (processAlive(owner.pid) || (owner.childPid && processAlive(owner.childPid))) return;
      removeOwner(entries[0]);
    } else {
      return;
    }
    console.log("[paperclip] Recovered abandoned workspace build lock.");
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code) || error instanceof SyntaxError) return;
    throw error;
  }
}

async function acquireLock() {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const candidate = fs.mkdtempSync(`${lockDir}.candidate-`);
  fs.writeFileSync(path.join(candidate, ownerFile), JSON.stringify({ pid: process.pid }));
  const startedAt = Date.now();
  let reportedWait = false;
  try {
    while (!stoppingSignal) {
      // Do not replace a fresh empty lock held by an older script.
      recoverAbandonedLock();
      if (!fs.existsSync(lockDir)) {
        try {
          fs.renameSync(candidate, lockDir);
          holdsLock = true;
          return;
        } catch (error) {
          if (!["ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code)) throw error;
        }
      }
      if (!reportedWait) {
        console.log(`[paperclip] Waiting for another workspace build (${lockDir})...`);
        reportedWait = true;
      }
      if (Date.now() - startedAt >= lockTimeoutMs) {
        throw new Error(`Timed out waiting for workspace build lock at ${lockDir}. Another build may still be running.`);
      }
      await sleep(lockPollMs);
    }
  } finally {
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

async function build(target) {
  console.log(`[paperclip] Building ${target.name}...`);
  // A hard kill bypasses cleanup. Only a completed compile may restore this
  // marker, so recovery never trusts index.js emitted partway through a build.
  fs.rmSync(target.completion, { force: true });
  const code = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [tscCliPath, "-p", target.tsconfig], {
      cwd: rootDir,
      stdio: "inherit",
    });
    // A hard-killed parent must not let a successor race its surviving compiler.
    fs.writeFileSync(path.join(lockDir, ownerFile), JSON.stringify({ pid: process.pid, childPid: child.pid }));
    child.once("error", (error) => {
      fs.rmSync(target.output, { force: true });
      reject(error);
    });
    child.once("close", (code) => {
      child = null;
      resolve(code ?? 1);
    });
  });
  // tsc emits index.js before it finishes the package. A failed or interrupted
  // compile must not make the next startup accept that partial build as current.
  if (code !== 0) fs.rmSync(target.output, { force: true });
  else fs.writeFileSync(target.completion, "complete\n");
  return code;
}

if (allOutputsCurrent() && !fs.existsSync(lockDir)) {
  process.exit(0);
}

// Keep the lock until the compiler has stopped, including when the foreground
// CLI's build timeout terminates this helper.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stoppingSignal = signal;
    child?.kill(signal);
  });
}
process.once("exit", releaseLock);

let exitCode = 0;
try {
  await acquireLock();
  if (holdsLock) {
    for (const target of buildTargets) {
      if (stoppingSignal) break;
      if (!needsBuild(target)) continue;
      exitCode = await build(target);
      if (exitCode !== 0) break;
    }
  }
} finally {
  releaseLock();
}
process.exitCode = stoppingSignal === "SIGINT" ? 130 : stoppingSignal ? 143 : exitCode;
