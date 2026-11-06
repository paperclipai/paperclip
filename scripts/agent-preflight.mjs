#!/usr/bin/env node
// One-command preflight for an agent worktree: install, the Runner build and
// the Runner's debug binaries, skipping work whose inputs are unchanged and
// reusing other worktrees' results through the content-addressed cache in
// scripts/agent-build-cache.mjs.
//
// It replaces this sequence, with the same results:
//   pnpm install --frozen-lockfile
//   pnpm --filter @paperclipai/paperclip-runner run ensure:eval-build-deps
//   pnpm --filter @paperclipai/paperclip-runner run build:rust
//   pnpm --filter @paperclipai/paperclip-runner build
//   pnpm --filter @paperclipai/paperclip-runner run build:runner-binaries
//
// Steps:
//   install       skipped when the lockfile, manifests, patches and toolchain
//                 match the last successful install in this worktree
//   runner build  skipped when the Runner's own build stamp is current;
//                 restored from the cache when another worktree built the same
//                 inputs; otherwise built, then published
//   debug bins    the same, keyed by every file the Rust build reads
// A fresh worktree's cargo target directory starts as a clone of the shared
// third-party seed, so cargo compiles only the Runner crate.
//
// A restored Runner build skips the build's lint checks (protocol coverage,
// traceability and similar). They depend only on the same inputs, and CI runs
// them; run `pnpm --filter @paperclipai/paperclip-runner build` for them locally.
//
// Usage: node scripts/agent-preflight.mjs [--no-cache] [--force-install] [--skip-rust-debug] [--explain]

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cacheRoot, cloneInto, EVAL_KERNEL_PACKAGE, globFiles, hashFiles, makeKey, publishEntry, readEntry, removeTree,
  RUNNER_PACKAGE, scrubSeed, seedIsScrubbed, toolchainIdentity,
} from "./agent-build-cache.mjs";
import { DEBUG_INPUTS, debugContract } from "./runner-debug-crate-cache.mjs";
import {
  assessRunnerBuild, buildInputsStampPath, collectBuildOutputFiles, computeBuildInputsDigest, expectedBuildOutputs,
  findChangedBuildOutput, writeBuildInputsStamp,
} from "../packages/paperclip-runner/scripts/build-inputs.mjs";

const PREFLIGHT_SCRIPTS = ["scripts/agent-preflight.mjs", "scripts/agent-build-cache.mjs"];
const SEED_INPUTS = [`${RUNNER_PACKAGE}/runner/Cargo.lock`, `${RUNNER_PACKAGE}/runner/Cargo.toml`,
  `${RUNNER_PACKAGE}/runner/crates/runner-core/Cargo.toml`, `${RUNNER_PACKAGE}/rust-toolchain.toml`];

function log(message) {
  console.log(`[agent:preflight] ${message}`);
}

function exec(command, args, cwd, env = process.env) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status ?? result.signal}`);
  return (Date.now() - started) / 1000;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function stateDirectory(root) {
  return path.join(root, "node_modules", ".cache", "paperclip-agent-preflight");
}

// --- install ---------------------------------------------------------------

export function installKey(root, toolchain) {
  // Untracked, non-ignored manifests count too: a new workspace package needs an install.
  const tracked = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
    ":(glob)**/package.json", "patches"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) return null;
  const files = tracked.stdout.split("\0").filter(Boolean);
  const pnpm = spawnSync("pnpm", ["--version"], { cwd: root, encoding: "utf8" }).stdout?.trim();
  return hashFiles(root, files).update(JSON.stringify({ node: toolchain.node, platform: toolchain.platform,
    arch: toolchain.arch, pnpm })).digest("hex");
}

function installStep(root, options, toolchain) {
  const stampFile = path.join(stateDirectory(root), "install.json");
  const key = installKey(root, toolchain);
  const modules = path.join(root, "node_modules", ".modules.yaml");
  const stamp = readJson(stampFile);
  if (!options.forceInstall && key && existsSync(modules) && stamp?.key === key
    && stamp.modulesMtimeMs === statSync(modules).mtimeMs) {
    return { step: "install", action: "skipped", reason: "lockfile, manifests and toolchain unchanged" };
  }
  const seconds = exec("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], root);
  if (key) writeJson(stampFile, { key, modulesMtimeMs: statSync(modules).mtimeMs });
  return { step: "install", action: "ran", seconds };
}

// --- cargo seed ------------------------------------------------------------

function targetDirectory(root) {
  return path.join(root, RUNNER_PACKAGE, "runner", "target");
}

function seedKey(root, toolchain) {
  return makeKey("cargo-seed", { inputs: hashFiles(root, SEED_INPUTS).digest("hex"), toolchain });
}

function restoreSeed(root, cache, toolchain) {
  const target = targetDirectory(root);
  if (existsSync(target)) return { step: "cargo-seed", action: "kept", reason: "worktree already has a target directory" };
  const entry = readEntry(cache, "cargo-seed", seedKey(root, toolchain));
  if (!entry) return { step: "cargo-seed", action: "miss" };
  const started = Date.now();
  try {
    cloneInto(path.join(entry.directory, "target"), target);
  } catch (error) {
    return { step: "cargo-seed", action: "failed", reason: error.message.split("\n")[0] };
  }
  if (!seedIsScrubbed(target)) {
    removeTree(target);
    return { step: "cargo-seed", action: "discarded", reason: "seed held a workspace crate unit" };
  }
  return { step: "cargo-seed", action: "restored", seconds: (Date.now() - started) / 1000,
    profiles: entry.meta.profiles };
}

function publishSeed(root, cache, toolchain, bins) {
  const target = targetDirectory(root);
  const profiles = ["debug", "release"].filter(profile => existsSync(path.join(target, profile, "deps")));
  if (!cache || profiles.length === 0) return null;
  const published = publishEntry(cache, "cargo-seed", seedKey(root, toolchain), directory => {
    const copy = path.join(directory, "target");
    cloneInto(target, copy);
    scrubSeed(copy, bins);
    if (!seedIsScrubbed(copy)) throw new Error("seed still holds a workspace crate unit");
  }, { meta: { profiles }, replace: existing => profiles.some(profile => !existing.profiles?.includes(profile)) });
  return published ? { step: "cargo-seed", action: "published", profiles } : null;
}

// --- Runner build (dist) ---------------------------------------------------

const DIST_TREES = [`${RUNNER_PACKAGE}/dist`, `${EVAL_KERNEL_PACKAGE}/dist`];

function runnerDistKey(digest, toolchain) {
  return makeKey("runner-dist", { digest, toolchain });
}

// Copilot assets live outside dist, and the build installs them after compiling.
// The installer is idempotent, so a skipped or restored build runs it too.
function installCopilotAssets(packageRoot) {
  exec(process.execPath, ["scripts/install-copilot-assets.mjs"], packageRoot);
}

function stampRestoredBuild(root, packageRoot, inputs, entryKey) {
  const outputs = collectBuildOutputFiles(packageRoot);
  const recordedAt = new Date().toISOString();
  writeBuildInputsStamp(buildInputsStampPath(packageRoot), { ...inputs, platform: process.platform, arch: process.arch,
    startedAt: recordedAt, recordedAt, restoredFrom: entryKey, outputCount: outputs.length, outputs });
  return recordedAt;
}

function runnerBuildStep(root, cache, toolchain) {
  const packageRoot = path.join(root, RUNNER_PACKAGE);
  const assessment = assessRunnerBuild({ repoRoot: root, packageRoot });
  const inputs = assessment.inputs ?? computeBuildInputsDigest(root);
  const key = runnerDistKey(inputs.digest, toolchain);
  // The Runner's stamp does not record the compiler or flags, so the preflight
  // keeps its own record of the full key the current build was made with,
  // tied to that build's stamp time. Any other Runner build rewrites the stamp
  // and so breaks the tie: the next preflight rebuilds or restores.
  const keyFile = path.join(stateDirectory(root), "runner-build.json");
  const record = readJson(keyFile);
  if (assessment.current && record?.key === key && record.recordedAt === assessment.stamp.recordedAt) {
    installCopilotAssets(packageRoot);
    return { step: "runner-build", action: "skipped", reason: assessment.detail };
  }
  rmSync(keyFile, { force: true });
  const entry = readEntry(cache, "runner-dist", key);
  if (entry) {
    const started = Date.now();
    let cloned = true;
    try {
      for (const tree of DIST_TREES) {
        removeTree(path.join(root, tree));
        cloneInto(path.join(entry.directory, tree), path.join(root, tree));
      }
    } catch (error) {
      cloned = false;
      log(`could not restore the cached Runner build: ${error.message.split("\n")[0]}`);
    }
    const changed = cloned && findChangedBuildOutput(packageRoot, entry.meta.outputs ?? []);
    const missing = expectedBuildOutputs(packageRoot).filter(file => !existsSync(file));
    if (cloned && !changed && missing.length === 0 && computeBuildInputsDigest(root).digest === inputs.digest) {
      installCopilotAssets(packageRoot);
      writeJson(keyFile, { key, recordedAt: stampRestoredBuild(root, packageRoot, inputs, key) });
      return { step: "runner-build", action: "restored", seconds: (Date.now() - started) / 1000 };
    }
    for (const tree of DIST_TREES) removeTree(path.join(root, tree));
    log("cached Runner build did not match; building");
  }
  const seconds = exec("pnpm", ["--filter", "@paperclipai/paperclip-runner", "build"], root);
  const after = assessRunnerBuild({ repoRoot: root, packageRoot });
  if (!after.current || after.stamp.digest !== inputs.digest) return { step: "runner-build", action: "built", seconds };
  writeJson(keyFile, { key, recordedAt: after.stamp.recordedAt });
  const published = publishEntry(cache, "runner-dist", key, directory => {
    for (const tree of DIST_TREES) cloneInto(path.join(root, tree), path.join(directory, tree));
  }, { meta: { outputs: after.stamp.outputs } });
  return { step: "runner-build", action: "built", seconds, published };
}

// --- Runner debug binaries -------------------------------------------------

function debugBinsKey(root, toolchain) {
  const files = [...globFiles(root, DEBUG_INPUTS), ...PREFLIGHT_SCRIPTS];
  return makeKey("runner-debug-bins", { inputs: hashFiles(root, files).digest("hex"), toolchain });
}

function binaryState(file) {
  try {
    const stat = statSync(file);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch { return null; }
}

function debugBinsStep(root, cache, toolchain, bins) {
  const debug = path.join(targetDirectory(root), "debug");
  const stampFile = path.join(debug, ".paperclip-agent-debug-bins.json");
  const key = debugBinsKey(root, toolchain);
  const stamp = readJson(stampFile);
  const states = () => Object.fromEntries(bins.map(bin => [bin, binaryState(path.join(debug, bin))]));
  if (stamp?.key === key && bins.every(bin => stamp.bins?.[bin] && JSON.stringify(stamp.bins[bin])
    === JSON.stringify(binaryState(path.join(debug, bin))))) {
    return { step: "debug-bins", action: "skipped", reason: "Rust inputs unchanged since this worktree's build" };
  }
  const entry = readEntry(cache, "runner-debug-bins", key);
  if (entry && bins.every(bin => existsSync(path.join(entry.directory, bin)))) {
    const started = Date.now();
    try {
      mkdirSync(debug, { recursive: true });
      for (const bin of bins) {
        removeTree(path.join(debug, bin));
        cloneInto(path.join(entry.directory, bin), path.join(debug, bin));
      }
      writeJson(stampFile, { key, bins: states() });
      return { step: "debug-bins", action: "restored", seconds: (Date.now() - started) / 1000 };
    } catch (error) {
      // A concurrent prune can remove the entry mid-restore; build instead.
      rmSync(stampFile, { force: true });
      log(`could not restore cached debug binaries: ${error.message.split("\n")[0]}`);
    }
  }
  const seconds = exec("cargo", ["build", "--manifest-path", "runner/Cargo.toml", "--locked", "--workspace", "--bins"],
    path.join(root, RUNNER_PACKAGE));
  if (debugBinsKey(root, toolchain) !== key) return { step: "debug-bins", action: "built", seconds, published: false };
  writeJson(stampFile, { key, bins: states() });
  const published = publishEntry(cache, "runner-debug-bins", key, directory => {
    for (const bin of bins) cloneInto(path.join(debug, bin), path.join(directory, bin));
  });
  return { step: "debug-bins", action: "built", seconds, published };
}

// --- main ------------------------------------------------------------------

export function parseArguments(argv) {
  const options = { cache: true, forceInstall: false, rustDebug: true, explain: false };
  for (const argument of argv) {
    if (argument === "--no-cache") options.cache = false;
    else if (argument === "--force-install") options.forceInstall = true;
    else if (argument === "--skip-rust-debug") options.rustDebug = false;
    else if (argument === "--explain") options.explain = true;
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

export function preflight({ root, options, env = process.env }) {
  const started = Date.now();
  const results = [];
  const record = result => {
    if (result) {
      results.push(result);
      log(`${result.step}: ${result.action}${result.seconds === undefined ? "" : ` in ${result.seconds.toFixed(1)}s`}`
        + `${result.reason ? ` (${result.reason})` : ""}${result.published ? "; published to the shared cache" : ""}`);
    }
  };
  // A custom target directory breaks the per-worktree layout the seed and
  // binary steps assume; fall back to the plain build without the cache.
  const cache = options.cache && !env.CARGO_TARGET_DIR && !env.CARGO_BUILD_TARGET_DIR ? cacheRoot(env) : null;
  if (cache) mkdirSync(cache, { recursive: true });
  log(cache ? `shared cache ${cache}` : "shared cache disabled");

  const toolchain = toolchainIdentity(root, env);
  record(installStep(root, options, toolchain));
  const bins = debugContract(root).bins;
  record(restoreSeed(root, cache, toolchain));
  record(runnerBuildStep(root, cache, toolchain));
  if (options.rustDebug) record(debugBinsStep(root, cache, toolchain, bins));
  record(publishSeed(root, cache, toolchain, bins));
  const seconds = (Date.now() - started) / 1000;
  log(`done in ${seconds.toFixed(1)}s`);
  if (options.explain) console.log(JSON.stringify({ cache, toolchain: createHash("sha256")
    .update(JSON.stringify(toolchain)).digest("hex").slice(0, 12), results, seconds }, null, 2));
  return { results, seconds };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    preflight({ root, options: parseArguments(process.argv.slice(2)) });
  } catch (error) {
    console.error(`[agent:preflight] ${error.message}`);
    process.exitCode = 1;
  }
}
