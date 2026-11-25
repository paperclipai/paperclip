// Content-addressed build cache shared by the agent worktrees on one machine.
//
// Every worktree used to build the Runner from nothing: its own cargo target
// directory, its own Runner `dist`, its own debug binaries. This module keeps
// three kinds of entries under one cache directory, each written once and
// never modified afterwards:
//
//   cargo-seed/<key>         a cargo target directory with only third-party
//                            crates in it, keyed by the lockfile, manifests and
//                            compiler. A fresh worktree starts from a clone.
//   runner-dist/<key>        the Runner's and the eval kernel's `dist`, keyed by
//                            the Runner build-input digest and the toolchain
//   runner-debug-bins/<key>  the Runner's debug executables, keyed by every
//                            file the Rust build reads and the toolchain
//
// Why each entry is safe to reuse:
//
// - Seeds hold no workspace crate. The Runner crate includes files outside
//   its package root (protocol schemas, fixtures), and cargo records those as
//   absolute paths, so a unit compiled in another checkout would be judged by
//   that checkout's files. `scrubSeed` deletes every unit of the workspace
//   crate; with no fingerprint cargo always recompiles it. Registry crates are
//   immutable sources under CARGO_HOME, and cargo records paths inside the
//   target directory relative to it, so it checks them as usual.
// - Dist and binary entries are keyed by the content of their inputs, not
//   paths or mtimes. Any changed byte selects a different key. The Runner's
//   executables use CARGO_MANIFEST_DIR only in tests, so a binary built in
//   another checkout behaves the same.
// - Entries are published with one rename from a temporary sibling, and
//   restored by cloning into a temporary sibling and renaming it into place.
//   A reader never sees a partial entry or leaves a partial tree.
//
// On APFS `cp -c` clones files, so a restore costs metadata, not bytes, and
// the clones share disk blocks with the entry. Elsewhere the copy falls back
// to `cp --reflink=auto` or a plain copy.
//
// PAPERCLIP_AGENT_CACHE_DIR moves the cache; PAPERCLIP_AGENT_CACHE=0 turns it
// off. Keep the cache on the same volume as the worktrees so clones work.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, globSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync,
  utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const CACHE_SCHEMA = "paperclip.agent-build-cache.v1";
export const RUNNER_PACKAGE = "packages/paperclip-runner";
export const EVAL_KERNEL_PACKAGE = "packages/paperclip-eval-kernel";
// Entries are touched on every hit, so these keep the most recently used ones.
// A seed is about 2 GB of mostly shared clone blocks; the others are 30-100 MB.
const KEEP_ENTRIES = { "cargo-seed": 2, "runner-dist": 12, "runner-debug-bins": 12 };
// Never delete an entry used this recently: another worktree may be cloning it.
const IN_USE_MS = 30 * 60 * 1000;

export function cacheRoot(env = process.env) {
  if (env.PAPERCLIP_AGENT_CACHE === "0") return null;
  if (env.PAPERCLIP_AGENT_CACHE_DIR) return path.resolve(env.PAPERCLIP_AGENT_CACHE_DIR);
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paperclip", "agent-build");
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch {
    return "unavailable";
  }
}

/** Compiler, platform and the environment variables that change what rustc emits. */
export function toolchainIdentity(root, env = process.env) {
  const cwd = path.join(root, RUNNER_PACKAGE);
  const buildEnv = Object.entries(env).filter(([name]) =>
    /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTC_BOOTSTRAP|RUSTUP_TOOLCHAIN|RUST_TARGET_PATH|CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|MACOSX_DEPLOYMENT_TARGET)$/.test(name)
    || /^CARGO_(?:BUILD|PROFILE|TARGET|ENCODED|INCREMENTAL)/.test(name)).sort();
  const cargoHome = env.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const cargoConfig = ["config", "config.toml"].map(name => path.join(cargoHome, name))
    .map(file => existsSync(file) ? readFileSync(file, "utf8") : "missing");
  return {
    platform: process.platform, arch: process.arch, node: process.version,
    rustc: run("rustc", ["--version", "--verbose"], { cwd, env }),
    cargo: run("cargo", ["--version"], { cwd, env }),
    buildEnv, cargoConfig,
  };
}

/** Hashes repo-relative files by path and content, so the key is the same in every checkout. */
export function hashFiles(root, files, hash = createHash("sha256")) {
  for (const file of [...new Set(files)].sort()) {
    const absolute = path.join(root, file);
    hash.update(file).update("\0");
    if (!existsSync(absolute)) hash.update("missing");
    else if (lstatSync(absolute).isSymbolicLink()) hash.update("link\0").update(readlinkSync(absolute));
    else hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash;
}

export function globFiles(root, patterns) {
  return [...globSync(patterns, { cwd: root })]
    .filter(file => !file.split(path.sep).includes("target") && statSync(path.join(root, file)).isFile())
    .map(file => file.split(path.sep).join("/"));
}

export function makeKey(kind, parts) {
  return createHash("sha256").update(JSON.stringify({ schema: CACHE_SCHEMA, kind, parts })).digest("hex").slice(0, 40);
}

/** Copy-on-write clone of a file or directory tree, through a temporary sibling. */
export function cloneInto(source, destination) {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  mkdirSync(path.dirname(destination), { recursive: true });
  const attempts = process.platform === "darwin" ? [["-cRp"], ["-Rp"]] : [["-a", "--reflink=auto"], ["-a"]];
  let lastError;
  for (const flags of attempts) {
    try {
      execFileSync("cp", [...flags, source, temporary], { stdio: ["ignore", "ignore", "pipe"] });
      renameSync(temporary, destination);
      return;
    } catch (error) {
      lastError = error;
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  throw lastError;
}

/** Moves an existing path out of the way and deletes it, so the name can be reused at once. */
export function removeTree(target) {
  if (!existsSync(target) && !isLink(target)) return;
  // A hidden name, so pruning treats a leftover as a stale temporary.
  const doomed = path.join(path.dirname(target), `.old-${path.basename(target)}-${randomUUID()}`);
  renameSync(target, doomed);
  rmSync(doomed, { recursive: true, force: true });
}

function isLink(target) {
  try { return lstatSync(target).isSymbolicLink(); } catch { return false; }
}

export function entryPath(root, kind, key) {
  return path.join(root, kind, key);
}

/** Reads a complete entry; touches it so pruning keeps entries in use. */
export function readEntry(cache, kind, key) {
  if (!cache) return null;
  const directory = entryPath(cache, kind, key);
  try {
    const meta = JSON.parse(readFileSync(path.join(directory, "entry.json"), "utf8"));
    if (meta.schema !== CACHE_SCHEMA || meta.kind !== kind || meta.key !== key) return null;
    const now = new Date();
    try { utimesSync(directory, now, now); } catch {}
    return { directory, meta };
  } catch {
    return null;
  }
}

/**
 * Publishes an entry: `populate(directory)` fills a private temporary
 * directory, which is then renamed into place. When another process has
 * published the same key first, its entry wins unless `replace` says the new
 * one is better. Returns whether this call published.
 */
export function publishEntry(cache, kind, key, populate, { replace = () => false, meta = {} } = {}) {
  if (!cache) return false;
  // Check before copying anything, so an unchanged run does not clone a tree to discard it.
  const current = readEntry(cache, kind, key);
  if (current && !replace(current.meta)) return false;
  const kindDirectory = path.join(cache, kind);
  mkdirSync(kindDirectory, { recursive: true });
  const temporary = path.join(kindDirectory, `.tmp-${randomUUID()}`);
  mkdirSync(temporary);
  try {
    populate(temporary);
    writeFileSync(path.join(temporary, "entry.json"), `${JSON.stringify({ schema: CACHE_SCHEMA, kind, key,
      createdAt: new Date().toISOString(), ...meta }, null, 2)}\n`);
    const destination = entryPath(cache, kind, key);
    const existing = readEntry(cache, kind, key);
    if (existing && !replace(existing.meta)) return false;
    if (existing) removeTree(destination);
    try {
      renameSync(temporary, destination);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) return false;
      throw error;
    }
    pruneKind(cache, kind, key);
    return true;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Keeps the most recently used entries of a kind and anything used in the last half hour. */
export function pruneKind(cache, kind, keep, now = Date.now()) {
  const kindDirectory = path.join(cache, kind);
  let names;
  try { names = readdirSync(kindDirectory); } catch { return; }
  const entries = names.map(name => {
    const full = path.join(kindDirectory, name);
    try { return { name, full, mtime: statSync(full).mtimeMs }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
  const limit = KEEP_ENTRIES[kind] ?? 4;
  entries.filter(entry => !entry.name.startsWith(".")).forEach((entry, index) => {
    if (index >= limit && entry.mtime < now - IN_USE_MS && entry.name !== keep) {
      try { removeTree(entry.full); } catch {}
    }
  });
  // Temporary directories left by an interrupted publish.
  entries.filter(entry => entry.name.startsWith(".")).forEach(entry => {
    const stale = entry.mtime < now - 24 * 60 * 60 * 1000;
    if (stale) {
      try { removeTree(entry.full); } catch {}
    }
  });
}

/**
 * Deletes every unit of the workspace crate from a cargo target tree, so a
 * seed made from it holds third-party crates only. `bins` are the crate's
 * executable target names.
 */
export function scrubSeed(target, bins) {
  const names = ["paperclip-runner-core", "paperclip_runner_core", ...bins.flatMap(bin => [bin, bin.replaceAll("-", "_")])];
  const owned = name => names.some(prefix => name === prefix || name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}.`)
    || name.startsWith(`lib${prefix}-`));
  let removed = 0;
  for (const profile of readdirSync(target)) {
    const profileDirectory = path.join(target, profile);
    if (!statSync(profileDirectory).isDirectory()) continue;
    if (!["debug", "release"].includes(profile)) {
      rmSync(profileDirectory, { recursive: true, force: true });
      continue;
    }
    for (const name of readdirSync(profileDirectory)) {
      const full = path.join(profileDirectory, name);
      if ([".fingerprint", "deps", "incremental", "build", "examples"].includes(name)) {
        for (const unit of readdirSync(full)) {
          if (name === "incremental" || name === "examples" || owned(unit)) {
            rmSync(path.join(full, unit), { recursive: true, force: true });
            removed += 1;
          }
        }
      } else if (owned(name) || name.startsWith(".")) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return removed;
}

/** True when no fingerprint of the workspace crate is left, so cargo must compile it. */
export function seedIsScrubbed(target) {
  for (const profile of ["debug", "release"]) {
    const fingerprints = path.join(target, profile, ".fingerprint");
    if (!existsSync(fingerprints)) continue;
    if (readdirSync(fingerprints).some(name => name.startsWith("paperclip-runner-core-"))) return false;
  }
  return true;
}
