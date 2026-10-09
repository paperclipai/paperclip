import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import type { MatrixExecution } from "./types.js";
import { resolveRunnerE2ESource } from "./source.js";

/** The checked-out controller is authoritative, independently of workflow context. */
export function prepareHermesQualificationSource(
  executions: readonly MatrixExecution[],
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
) {
  if (!executions.some(execution => execution.profile.qualificationCandidate === "hermes")) return null;
  const gitEnvironment: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    ...Object.fromEntries(["PATH", "SYSTEMROOT", "LANG"].flatMap(name =>
      environment[name] === undefined ? [] : [[name, environment[name]]])),
  };
  const git = (args: string[]) => {
    try {
      return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd: repositoryRoot, env: gitEnvironment, encoding: "utf8",
        timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("Hermes qualification needs readable Git source before credentials; use a clean checkout.");
    }
  };
  const sha = git(["rev-parse", "HEAD"]).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Hermes qualification source SHA is invalid.");
  // Check every tracked source change, including anything tracked in an asset
  // directory. Only untracked files in these generated runtime roots are omitted;
  // their manifests and bytes are verified separately before credentials arrive.
  const generatedRuntimeRoots = [
    "packages/paperclip-runner/provider-assets/hermes/linux-x64",
    "packages/paperclip-runner/provider-assets/hermes/darwin-arm64",
    "packages/paperclip-runner/provider-pack",
  ];
  const trackedChanges = git(["status", "--porcelain", "-z", "--untracked-files=no"]).split("\0").filter(Boolean);
  const untrackedSource = git(["ls-files", "--others", "--exclude-standard", "-z", "--", ".",
    ...generatedRuntimeRoots.map(root => `:(exclude)${root}/**`),
  ]).split("\0").filter(Boolean);
  const changes = [...trackedChanges, ...untrackedSource.map(file => `?? ${file}`)];
  const approvedLock = environment.PAPERCLIP_RUNNER_E2E_LOCK_SHA256?.trim();
  if (approvedLock && !/^[a-f0-9]{64}$/.test(approvedLock)) throw new Error("Hermes qualification approved lock digest is invalid.");
  if (changes.some(change => change !== " M pnpm-lock.yaml" || !approvedLock)) {
    throw new Error("Hermes qualification needs a clean checkout before credentials; commit or remove source changes.");
  }
  if (approvedLock) {
    let fd: number | undefined;
    try {
      fd = openSync(join(repositoryRoot, "pnpm-lock.yaml"), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024
        || createHash("sha256").update(readFileSync(fd)).digest("hex") !== approvedLock) throw new Error();
    } catch {
      throw new Error("Hermes qualification lockfile differs from the approved digest before credentials.");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const requestedSha = environment.PAPERCLIP_RUNNER_E2E_SOURCE_SHA?.trim();
  if (requestedSha && requestedSha !== sha) {
    throw new Error("Hermes qualification source SHA differs from the checked-out controller before credentials.");
  }
  const ref = git(["rev-parse", "--symbolic-full-name", "HEAD"]).trim();
  if (git(["rev-parse", "HEAD"]).trim() !== sha) throw new Error("Hermes qualification source changed during admission.");
  // These explicit values survive local-env loading and reach every child and
  // synthetic failure. A workflow's own GITHUB_SHA may identify another commit.
  environment.PAPERCLIP_RUNNER_E2E_SOURCE_SHA = sha;
  environment.PAPERCLIP_RUNNER_E2E_SOURCE_REF =
    (requestedSha && environment.PAPERCLIP_RUNNER_E2E_SOURCE_REF?.trim()) || ref;
  return { schema: "paperclip.hermes.e2e-source/v1", workingTreeClean: changes.length === 0,
    ...(approvedLock ? { approvedLockSha256: approvedLock } : {}),
    ...resolveRunnerE2ESource(null, environment) };
}
