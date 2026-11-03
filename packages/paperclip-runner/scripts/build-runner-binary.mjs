#!/usr/bin/env node
// Runs the cargo command `build:binary` passes it, which builds the release
// `paperclip-runnerd` that stage-runner-binary.mjs copies into dist/bin.
//
// PAPERCLIP_RUNNER_RELEASE_CRATE_RESTORED=1 reuses the restored binary
// instead. Only the trusted PR Build job sets it, and only after
// scripts/runner-release-crate-cache.mjs mark-current accepted a complete
// exact-key restore of the crate's release artifacts. The master writer
// built those with this same command from inputs byte-identical to the
// checkout's: the key hashes the compiler, the checkout root and every input
// the build reads. Cargo keeps them as they are, but its freshness check
// needs the shared third-party dependency cache on disk to say so, and that
// restore unpacked ~1.1 GB for 61s of the job's 67s step in run 40326666492
// (2026-10-26) before cargo reported `Finished ... in 0.16s`. With the flag
// set the job skips that restore, so cargo must not run here: it would
// recompile every dependency.
//
// A missing binary falls back to the command, a cold build that is slow but
// correct. Without the flag, as for the cache writer and every local build,
// the command runs exactly as before.
//
// Usage: node scripts/build-runner-binary.mjs <command> [args...]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RESTORED_VARIABLE = "PAPERCLIP_RUNNER_RELEASE_CRATE_RESTORED";

export function releaseBinaryPath(packageRoot, platform = process.platform) {
  return path.join(packageRoot, "runner", "target", "release", platform === "win32" ? "paperclip-runnerd.exe" : "paperclip-runnerd");
}

export function planRunnerBinaryBuild({ packageRoot, env = process.env, exists = existsSync, platform = process.platform }) {
  if (env[RESTORED_VARIABLE] !== "1") return { action: "build" };
  const binary = releaseBinaryPath(packageRoot, platform);
  if (exists(binary)) return { action: "reuse", binary };
  return { action: "build", warning: `${RESTORED_VARIABLE}=1 but ${binary} is missing; building it` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("usage: build-runner-binary.mjs <command> [args...]");
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const plan = planRunnerBinaryBuild({ packageRoot });
  if (plan.action === "reuse") {
    console.log(`build:binary: reusing the restored release crate's ${path.relative(packageRoot, plan.binary)} (${RESTORED_VARIABLE}=1)`);
  } else {
    if (plan.warning) console.warn(`build:binary: ${plan.warning}`);
    const result = spawnSync(command, args, { cwd: packageRoot, stdio: "inherit" });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
