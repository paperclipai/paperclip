// Makes sure packages/paperclip-runner/dist is a current build before the
// server build vendors it, rebuilding the Runner only when that is needed.
//
// The server build (and typecheck) used to run the Runner's full `build`
// unconditionally here. That is what lets a standalone
// `pnpm --filter @paperclipai/server build` produce a current vendored Runner
// on its own, which the Dockerfile relies on. But inside `pnpm -r build` the
// Runner has just been built by the same command, and repeating it cost
// 12-16s on the CI Build job's critical path (six master runs, 2026-10-11)
// and the same again in every other `pnpm build`.
//
// The Runner's `build` now records a digest of its inputs, captured before its
// first step and confirmed after its last, together with a manifest of every
// file it left under dist (packages/paperclip-runner/scripts/build-inputs.mjs).
// This step recomputes the digest and reuses the build when the stamp matches
// and every recorded output is still there at its recorded size; anything else
// runs the full Runner build exactly as before. The standalone guarantee
// therefore holds: a fresh checkout, a changed input, a deleted or truncated
// output, or an edit that landed while the build ran always rebuilds. Set
// PAPERCLIP_RUNNER_VENDOR_REBUILD=1 to rebuild regardless of the stamp.
//
// Usage: node scripts/prepare-runner-vendor.mjs [--repo-root <dir>]
// The repo root defaults to this checkout; the flag exists for tests that
// build a throwaway workspace layout.

import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assessRunnerBuild,
  removeBuildInputsStamp,
} from "../../packages/paperclip-runner/scripts/build-inputs.mjs";

/** The command the server build has always run here; the rebuild path is unchanged. */
export const RUNNER_VENDOR_BUILD_COMMAND = "pnpm --filter @paperclipai/paperclip-runner build";
export const FORCE_REBUILD_VARIABLE = "PAPERCLIP_RUNNER_VENDOR_REBUILD";
export const TIMING_SCHEMA = "paperclip.runner-vendor.timing.v1";

export function decideRunnerVendorAction({ env, assessment }) {
  if (env[FORCE_REBUILD_VARIABLE] === "1") {
    return { action: "rebuild", code: "forced", detail: `${FORCE_REBUILD_VARIABLE}=1` };
  }
  if (assessment.current) {
    return { action: "reuse", code: assessment.code, detail: assessment.detail };
  }
  return { action: "rebuild", code: assessment.code, detail: assessment.detail };
}

/**
 * The pnpm that is running this script, the same rule as the CLI's
 * resolvePnpmInstallInvocation: pnpm sets npm_execpath to its own entry, which
 * is a JavaScript file for a normal install (run through this Node) or a native
 * executable for a standalone pnpm (run directly). Outside a pnpm script,
 * `pnpm` on PATH is the only option. The pnpm entry is not always on PATH in a
 * script (corepack, for one), so this cannot just spawn `pnpm`.
 */
export function resolvePnpmInvocation(env = process.env, nodeExecPath = process.execPath) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && npmExecPath.toLowerCase().includes("pnpm")) {
    if (/\.(cjs|mjs|js)$/i.test(npmExecPath)) {
      return { command: nodeExecPath, argsPrefix: [npmExecPath] };
    }
    return { command: npmExecPath, argsPrefix: [] };
  }
  return { command: "pnpm", argsPrefix: [] };
}

export function runBuildCommand(command, { cwd, env = process.env }) {
  const [tool, ...args] = command.split(" ");
  if (tool !== "pnpm") throw new Error(`unexpected build command ${command}`);
  const pnpm = resolvePnpmInvocation(env);
  const result = spawnSync(pnpm.command, [...pnpm.argsPrefix, ...args], {
    cwd,
    env,
    stdio: "inherit",
    // A bare `pnpm` on Windows is pnpm.cmd, which needs the shell to resolve.
    shell: pnpm.command === "pnpm" && process.platform === "win32",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * Returns the exit status for the step. `run` is injectable so tests can
 * observe the command and the stamp state at the moment it runs.
 */
export function prepareRunnerVendor({
  repoRoot,
  env = process.env,
  run = runBuildCommand,
  log = console.log,
  now = () => performance.now(),
}) {
  const packageRoot = path.join(repoRoot, "packages", "paperclip-runner");
  const checkStart = now();
  const assessment = assessRunnerBuild({ repoRoot, packageRoot });
  const decision = decideRunnerVendorAction({ env, assessment });
  const checkMs = Math.round(now() - checkStart);

  if (decision.action === "reuse") {
    log(`prepare:runner-vendor: reusing the current Runner build (${decision.detail})`);
    log(`${TIMING_SCHEMA},action:reuse,reason:${decision.code},check_ms:${checkMs},build_ms:0`);
    return 0;
  }

  log(`prepare:runner-vendor: rebuilding the Runner (${decision.detail})`);
  // A build that stops partway must not leave a stamp that vouches for it. The
  // Runner's own build removes the stamp in its first step and writes a fresh
  // one in its last; removing it here as well covers a build command that
  // fails before its first step runs.
  removeBuildInputsStamp(assessment.stampPath);
  const buildStart = now();
  const status = run(RUNNER_VENDOR_BUILD_COMMAND, { cwd: path.join(repoRoot, "server"), env });
  const buildMs = Math.round(now() - buildStart);
  log(
    `${TIMING_SCHEMA},action:rebuild,reason:${decision.code},check_ms:${checkMs},build_ms:${buildMs},status:${status}`,
  );
  return status;
}

export function parseArguments(argv) {
  let repoRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      repoRoot = argv[index + 1];
      if (!repoRoot) throw new Error("--repo-root needs a directory");
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return { repoRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { repoRoot: requested } = parseArguments(process.argv.slice(2));
  const repoRoot = requested
    ? path.resolve(requested)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.exitCode = prepareRunnerVendor({ repoRoot });
}
