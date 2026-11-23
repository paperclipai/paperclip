#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNNER_IMAGE_CONTEXT_INPUTS } from "./runner-image-identity.mjs";
import { runnerLockState } from "./runner-image-publish.mjs";

export const LOCKFILE_REFRESH_COMMAND = "pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile";

export function runnerLockStateAtCommit({ repoRoot, commit = "HEAD", run = spawnSync, lockState = runnerLockState }) {
  const scratch = mkdtempSync(path.join(tmpdir(), "paperclip-release-runner-lockfile-"));
  try {
    const archive = path.join(scratch, "context.tar");
    const context = path.join(scratch, "context");
    mkdirSync(context);
    const steps = [
      ["export", "git", ["-C", repoRoot, "archive", "--format=tar", "--output", archive, commit, "--", ...RUNNER_IMAGE_CONTEXT_INPUTS]],
      ["unpack", "tar", ["-xf", archive, "-C", context]],
    ];
    for (const [step, command, args] of steps) {
      const result = run(command, args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Could not ${step} the Runner's inputs at ${commit} (${command} exit ${result.status}): ${(result.stderr ?? "").trim().slice(-1000)}`);
      }
    }
    return lockState(context);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runReleaseRunnerLockfileCheck(argv, {
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  check = runnerLockStateAtCommit,
  log = console.error,
} = {}) {
  if (argv.length > 2 || (argv.length > 0 && (argv[0] !== "--commit" || !argv[1]))) {
    log("Usage: check-release-runner-lockfile.mjs [--commit <commit>]");
    return 2;
  }
  const commit = argv[1] ?? "HEAD";
  const result = check({ repoRoot, commit });
  if (result.state === "current") {
    log(`pnpm-lock.yaml at ${commit} matches the Runner's manifests.`);
    return 0;
  }
  log(`pnpm-lock.yaml at ${commit} is behind the Runner's manifests (${result.detail}). `
    + "An image build from this commit installs the Runner with a frozen lockfile and fails. "
    + `Release a commit that includes the lockfile refresh, which is the result of: ${LOCKFILE_REFRESH_COMMAND}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = runReleaseRunnerLockfileCheck(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
