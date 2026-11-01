#!/usr/bin/env node
// The Runner's own crate is the one thing the shared Rust dependency cache
// leaves out: rust-cache drops workspace crates when it saves, and a fresh
// checkout would invalidate cargo's mtime fingerprints for them anyway. So
// every CI build compiled `paperclip-runner-core` in release mode from
// scratch (28-49s per run on 2026-10-11) although 221 of the 239 master
// commits of the preceding week left its inputs untouched.
//
// This script backs a second, content-addressed cache that holds only that
// crate's release artifacts (about 70 MB). The master writer saves them
// under a key made from the compiler, the checkout root and a hash of every
// input the build reads; a pull request whose merge tree carries
// byte-identical inputs restores them. Cargo judges a workspace crate fresh
// only while no source is newer than its dep-info file, and GitHub's cache
// keeps the artifacts' original mtimes, so `mark-current` touches the
// restored set after the checkout. Any input change selects a different key,
// the restore misses, and cargo compiles exactly as it did before.
//
// Subcommands:
//   paths         print the cached paths, one per line (repo-relative globs)
//   hashed-inputs print the hashFiles() patterns that make up the key
//   scope         print the compiler/checkout part of the key
//   mark-current  make a restored artifact set newer than the checkout, or
//                 discard an incomplete one so cargo rebuilds instead
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync, utimesSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_PACKAGE = "packages/paperclip-runner";
const RELEASE_DIR = `${RUNNER_PACKAGE}/runner/target/release`;

// Everything cargo writes for the crate's release lib and bin units:
// fingerprints (both units share the package-named directory prefix), the
// lib's rlib/rmeta and dep-info, the bin and its dep-info under deps, and the
// uplifted executable the staging step copies into dist/bin.
export const CACHED_PATHS = [
  `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*`,
  `${RELEASE_DIR}/deps/libpaperclip_runner_core-*`,
  `${RELEASE_DIR}/deps/paperclip_runner_core-*.d`,
  `${RELEASE_DIR}/deps/paperclip_runnerd-*`,
  `${RELEASE_DIR}/paperclip-runnerd`,
  `${RELEASE_DIR}/paperclip-runnerd.d`,
];

// Every file the release build of the crate reads, as hashFiles() patterns:
// the toolchain pin, the manifests and lockfile, the crate sources, and the
// protocol schemas and fixtures the sources include with include_str!. The
// three fixture trees are read only by test builds, but hashing them costs
// nothing and keeps the include_str! guard test simple: every include in the
// crate, whatever its form, must land under one of these patterns.
export const HASHED_INPUTS = [
  `${RUNNER_PACKAGE}/rust-toolchain.toml`,
  `${RUNNER_PACKAGE}/acpx-profiles.json`,
  `${RUNNER_PACKAGE}/antigravity-distributions.json`,
  `${RUNNER_PACKAGE}/runner/Cargo.toml`,
  `${RUNNER_PACKAGE}/runner/Cargo.lock`,
  `${RUNNER_PACKAGE}/runner/crates/**`,
  `${RUNNER_PACKAGE}/protocol/**`,
  `${RUNNER_PACKAGE}/test-fixtures/**`,
  `${RUNNER_PACKAGE}/test/fixtures/**`,
  "tests/runner-e2e/fixtures/**",
];

// A restored set is usable only when both units are complete: everything
// cargo's freshness check reads for a unit (the fingerprint hash and the
// dep-info it compares source mtimes against) and every output it checks for
// (the lib's rlib and rmeta, the bin under deps). Measured with cargo 1.97.1:
// without any one of these it recompiles the unit; without the `.json`
// fingerprint records, rustc's `.d` files or the uplifted binary and its `.d`
// it reports the crate fresh and recreates the uplifted copy from deps.
// Anything less than this set is discarded, with the missing file named in
// the job log, so cargo sees a plain miss rather than a half-restored crate.
export const REQUIRED = [
  { label: "the lib fingerprint hash", glob: `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*/lib-paperclip_runner_core` },
  { label: "the lib dep-info", glob: `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*/dep-lib-paperclip_runner_core` },
  { label: "the lib rlib", glob: `${RELEASE_DIR}/deps/libpaperclip_runner_core-*.rlib` },
  { label: "the lib rmeta", glob: `${RELEASE_DIR}/deps/libpaperclip_runner_core-*.rmeta` },
  { label: "the bin fingerprint hash", glob: `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*/bin-paperclip-runnerd` },
  { label: "the bin dep-info", glob: `${RELEASE_DIR}/.fingerprint/paperclip-runner-core-*/dep-bin-paperclip-runnerd` },
  { label: "the bin under deps", glob: `${RELEASE_DIR}/deps/paperclip_runnerd-*`, exclude: /\.d$/ },
];

const SCHEMA = "paperclip.runner-release-crate.v1";

function keySafe(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * The compiler and checkout part of the cache key. The compiler decides the
 * artifacts' metadata hashes; the checkout root is baked into cargo's
 * dep-info for the protocol files the sources include by relative path, so an
 * entry written under one root is useless under another (the RunsOn fleets
 * check out under /home/runner/_work, GitHub-hosted runners under
 * /home/runner/work). Hashing the root into the key turns that into a plain
 * miss instead of a restore cargo then throws away.
 */
export function computeScope({ workspace = process.env.GITHUB_WORKSPACE ?? process.cwd(), rustcVersion = readRustcVersion() } = {}) {
  const root = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
  return `${keySafe(os.platform())}-${keySafe(os.arch())}-${keySafe(rustcVersion)}-${root}`;
}

function readRustcVersion(env = process.env) {
  let output;
  try {
    output = execFileSync("rustc", ["--version", "--verbose"], { encoding: "utf8", env });
  } catch {
    return "no-rustc";
  }
  const field = (name) => output.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "unknown";
  return `${field("release")}-${field("commit-hash").slice(0, 9)}-${field("host")}`;
}

function expandGlob(root, pattern) {
  // Patterns only ever use `*` inside a single path segment.
  const segments = pattern.split("/");
  let current = [root];
  for (const segment of segments) {
    const next = [];
    for (const base of current) {
      if (!segment.includes("*")) {
        const candidate = path.join(base, segment);
        if (existsSync(candidate)) next.push(candidate);
        continue;
      }
      let entries;
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      const matcher = new RegExp(`^${segment.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
      for (const entry of entries) {
        if (matcher.test(entry)) next.push(path.join(base, entry));
      }
    }
    current = next;
  }
  return current.sort();
}

function walk(target, visit) {
  const info = lstatSync(target);
  visit(target, info);
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) walk(path.join(target, entry), visit);
  }
}

/**
 * Touch every restored artifact so cargo's freshness check, which compares
 * each source's mtime against the unit's dep-info, sees the checkout as
 * older than the build. When the set is incomplete, remove whatever was
 * restored and report it: cargo then compiles the crate as on a miss.
 */
export function markCurrent({ root = process.env.GITHUB_WORKSPACE ?? process.cwd(), now = new Date() } = {}) {
  const missing = REQUIRED.find(({ glob, exclude }) => expandGlob(root, glob).filter((entry) => !exclude?.test(entry)).length === 0);
  const matched = CACHED_PATHS.flatMap((pattern) => expandGlob(root, pattern));
  if (missing) {
    for (const target of matched) rmSync(target, { recursive: true, force: true });
    return { schema: SCHEMA, action: "discarded", reason: `incomplete: ${missing.label} is missing`, removed: matched.length };
  }
  let files = 0;
  let bytes = 0;
  const seen = new Set();
  for (const target of matched) {
    walk(target, (entry, info) => {
      if (info.isSymbolicLink()) return;
      utimesSync(entry, now, now);
      if (info.isFile()) {
        files += 1;
        // The uplifted binary is a hard link to the one under deps.
        const { ino, size } = statSync(entry);
        if (!seen.has(ino)) {
          seen.add(ino);
          bytes += size;
        }
      }
    });
  }
  return { schema: SCHEMA, action: "marked", files, bytes };
}

function main(argv) {
  const [command] = argv;
  switch (command) {
    case "paths":
      process.stdout.write(`${CACHED_PATHS.join("\n")}\n`);
      return 0;
    case "hashed-inputs":
      process.stdout.write(`${HASHED_INPUTS.join("\n")}\n`);
      return 0;
    case "scope":
      process.stdout.write(`${computeScope()}\n`);
      return 0;
    case "mark-current": {
      const result = markCurrent();
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: runner-release-crate-cache.mjs <paths|hashed-inputs|scope|mark-current>\n");
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
