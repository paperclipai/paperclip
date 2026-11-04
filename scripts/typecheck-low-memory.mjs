#!/usr/bin/env node
// Runs the workspace typecheck with less memory, but more slowly. It checks one
// package at a time, and scripts/run-tsc.mjs uses one thread for the largest
// programs. See "Typecheck memory" in doc/DEVELOPING.md.
//
// Usage: node scripts/typecheck-low-memory.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOW_MEMORY_VARIABLE } from "./run-tsc.mjs";

export const STEPS = [
  ["run", "preflight:workspace-links"],
  ["-r", "--workspace-concurrency=1", "typecheck"],
];

export function runPnpm(args, options) {
  const result = spawnSync("pnpm", args, {
    ...options,
    stdio: "inherit",
    // A bare `pnpm` on Windows is pnpm.cmd, which needs the shell to resolve.
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function typecheckLowMemory({ cwd, env = process.env, run = runPnpm }) {
  for (const args of STEPS) {
    const status = run(args, { cwd, env: { ...env, [LOW_MEMORY_VARIABLE]: "1" } });
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = typecheckLowMemory({
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  });
}
