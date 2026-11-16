#!/usr/bin/env node
// Runs the calling package's tsc, honoring the repository's low-memory mode.
//
// TypeScript 7 is a native binary, so Node heap flags do not limit it. Each
// checker keeps its own copy of the types, which makes the checker count the
// most useful control a package has over its peak memory.
// scripts/typecheck-low-memory.mjs sets PAPERCLIP_TYPECHECK_LOW_MEMORY=1 so the
// largest programs check on a single thread.
//
// A build that only needs JavaScript sets PAPERCLIP_TSC_EMIT_ONLY=1. That build
// skips type checks and declarations, which use most of the memory of an emit.
// The Docker image uses this mode.
//
// Usage: node ../scripts/run-tsc.mjs [tsc arguments]

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOW_MEMORY_VARIABLE = "PAPERCLIP_TYPECHECK_LOW_MEMORY";
export const EMIT_ONLY_VARIABLE = "PAPERCLIP_TSC_EMIT_ONLY";

export function lowMemoryTscArgs(env = process.env) {
  return env[LOW_MEMORY_VARIABLE] === "1" ? ["--singleThreaded"] : [];
}

export function emitOnlyTscArgs(env = process.env) {
  return env[EMIT_ONLY_VARIABLE] === "1"
    ? ["--noCheck", "--declaration", "false", "--declarationMap", "false"]
    : [];
}

export function runTsc(args, { cwd = process.cwd(), env = process.env } = {}) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  // tsc only accepts -b as its first argument, so the caller's arguments go first.
  const result = spawnSync(process.execPath, [tsc, ...args, ...lowMemoryTscArgs(env), ...emitOnlyTscArgs(env)], {
    cwd,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, signal: result.signal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runTsc(process.argv.slice(2)).status;
}
