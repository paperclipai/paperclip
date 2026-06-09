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
    outputs: [
      path.join(rootDir, "packages/shared/dist/index.js"),
      path.join(rootDir, "packages/shared/dist/index.d.ts"),
      path.join(rootDir, "packages/shared/dist/telemetry/index.js"),
      path.join(rootDir, "packages/shared/dist/telemetry/index.d.ts"),
    ],
    sourceDir: path.join(rootDir, "packages/shared/src"),
    tsconfig: path.join(rootDir, "packages/shared/tsconfig.json"),
    buildInfo: path.join(rootDir, "packages/shared/tsconfig.tsbuildinfo"),
  },
  {
    name: "@paperclipai/plugin-sdk",
    outputs: [
      path.join(rootDir, "packages/plugins/sdk/dist/index.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/index.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/protocol.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/protocol.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/types.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/types.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/index.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/index.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/hooks.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/hooks.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/types.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/ui/types.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/testing.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/testing.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/bundlers.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/bundlers.d.ts"),
      path.join(rootDir, "packages/plugins/sdk/dist/dev-server.js"),
      path.join(rootDir, "packages/plugins/sdk/dist/dev-server.d.ts"),
    ],
    sourceDir: path.join(rootDir, "packages/plugins/sdk/src"),
    tsconfig: path.join(rootDir, "packages/plugins/sdk/tsconfig.json"),
    buildInfo: path.join(rootDir, "packages/plugins/sdk/tsconfig.tsbuildinfo"),
  },
];

if (!fs.existsSync(tscCliPath)) {
  throw new Error(`TypeScript CLI not found at ${tscCliPath}`);
}

// Walk a directory and return the newest .ts/.tsx mtime found. Symlinked
// subdirs are followed (statSync resolves) so workspace setups that
// symlink shared sources are scanned. Per-entry stat errors (e.g., a file
// is deleted mid-walk, EACCES, a dangling symlink) log + skip rather than
// crashing the whole pre-build, but the path is still reported so a real
// breakage doesn't go silent.
function newestMtimeInDir(dir) {
  let newest = 0;
  if (!fs.existsSync(dir)) return newest;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      console.warn(`[ensure-plugin-build-deps] readdir failed at ${current}: ${err.message}`);
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Resolve symlinks so symlink-to-directory entries are followed.
      // entry.isDirectory() returns false for symlinks-to-dir; statSync
      // follows the link and tells us the real kind.
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (err) {
        console.warn(`[ensure-plugin-build-deps] stat failed at ${full}: ${err.message}`);
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    }
  }
  return newest;
}

// Existence alone is not enough: a stale or partially emitted dist (e.g.,
// predating recent src edits, or missing a subpath export while another
// process is still building) silently produces wrong type-check errors in
// downstream plugins. Treat the outputs as up-to-date only if every generated
// entrypoint we depend on exists and the oldest output mtime is at least as
// recent as the newest .ts/.tsx in src/ and the tsconfig itself.
//
// Assumes each buildTarget's sources live under `<tsconfig dir>/src` — keep
// `buildTargets` aligned with this convention. If a future target uses a
// different rootDir, missing src/ would otherwise silently let stale dist
// pass freshness (the whole bug this script exists to prevent). We return
// false in that case to force a rebuild and log loudly.
function isFresh(target) {
  const outputMtimes = [];
  for (const output of target.outputs) {
    if (!fs.existsSync(output)) return false;
    outputMtimes.push(fs.statSync(output).mtimeMs);
  }
  const outputMtime = Math.min(...outputMtimes);
  const srcDir = path.join(path.dirname(target.tsconfig), "src");
  if (!fs.existsSync(srcDir)) {
    console.warn(
      `[ensure-plugin-build-deps] expected src dir missing at ${srcDir} ` +
        `for target ${target.name} — forcing rebuild instead of accepting ` +
        `potentially stale output. If this target uses a non-"src" rootDir, ` +
        `update buildTargets to encode the source path explicitly.`,
    );
    return false;
  }
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

    // If `tsc --noEmit` or a previous interrupted build left incremental
    // metadata behind while required dist files are absent/stale, a normal
    // emitting build can incorrectly consider the project up to date.
    fs.rmSync(target.buildInfo, { force: true });

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
