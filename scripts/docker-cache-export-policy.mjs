#!/usr/bin/env node
// Decides whether `.github/workflows/docker.yml` should export its BuildKit
// registry cache (`cache-to: ...,mode=max`) for this build.
//
// `mode=max` exports every intermediate stage, including the per-commit `build`
// stage (~4 GB), which adds ~2.5-3 minutes *after* the production image has
// already been pushed. On a normal master commit that only touches application
// source (server, ui, packages, docs, tests), every cross-commit cacheable
// layer (`base`, `tailscale-client`, `runner-lockfile`, `deps`, and the weekly
// CLI-tools + entrypoint layers in `production`) is already warm in
// `:buildcache-<arch>` and the per-commit `build` layers are never reused by
// future commits.
//
// Policy is strictly fail-open: whenever anything is uncertain (non-master
// push, inline Runner build, refreshed lockfile, missing remote cache, no
// published master ancestor in the lookback window, git diff error, or ISO
// week rollover for `CLI_TOOLS_CACHE_EPOCH`), we export `mode=max`.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_LOOKBACK_COMMITS = 10;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const ISO_WEEK_EPOCH_RE = /^\d{4}-W\d{2}$/;

/**
 * Exact repository-relative paths read by Dockerfile stages whose layers are
 * meant to stay cached across master commits (`base`, `tailscale-client`,
 * `runner-lockfile`, `deps`, and pre-app layers of `production`).
 *
 * Workspace `package.json` files and `patches/**` are matched separately in
 * `isCacheableInputPath`.
 */
export const CACHEABLE_INPUT_EXACT_PATHS = Object.freeze(new Set([
  "Dockerfile",
  ".dockerignore",
  ".npmrc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "docker/tailscale.LICENSE",
  "scripts/docker-entrypoint.sh",
  "scripts/link-plugin-dev-sdk.mjs",
  "packages/paperclip-runner/scripts/install-copilot-assets.mjs",
  "packages/paperclip-runner/scripts/materialize-copilot-binary.mjs",
  "packages/paperclip-runner/scripts/copilot-inner-distribution.mjs",
  "packages/paperclip-runner/src/drivers/acpx/copilot-installation.ts",
  "server/scripts/install-copilot-assets.mjs",
  "server/src/services/copilot-connection-probe.ts",
]));

export function isCacheableInputPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (CACHEABLE_INPUT_EXACT_PATHS.has(normalized)) return true;
  if (normalized === "package.json" || normalized.endsWith("/package.json")) return true;
  if (normalized === "patches" || normalized.startsWith("patches/")) return true;
  return false;
}

/**
 * Formats an ISO-8601 timestamp into the UTC ISO week string (`YYYY-Www`)
 * matching `date -u +%G-W%V` used by `CLI_TOOLS_CACHE_EPOCH`.
 */
export function isoWeekEpoch(isoDateString) {
  if (typeof isoDateString !== "string" || isoDateString.trim() === "") return null;
  const ms = Date.parse(isoDateString);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const isoYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNo = Math.ceil(((utc - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, "0")}`;
}

/**
 * Pure decision function for BuildKit registry cache export.
 *
 * @param {{
 *   eventName?: string,
 *   ref?: string,
 *   cacheRef: string,
 *   runnerImageMode?: string,
 *   lockfileRefreshed?: boolean,
 *   remoteCacheExists?: boolean,
 *   baseSha?: string | null,
 *   changedFiles?: string[] | null,
 *   baseCommitIsoDate?: string | null,
 *   toolsEpoch?: string | null,
 * }} input
 * @returns {{ shouldExport: boolean, cacheTo: string, reason: string }}
 */
export function decideDockerCacheExport({
  eventName,
  ref,
  cacheRef,
  runnerImageMode,
  lockfileRefreshed = false,
  remoteCacheExists = false,
  baseSha = null,
  changedFiles = null,
  baseCommitIsoDate = null,
  toolsEpoch = null,
}) {
  if (typeof cacheRef !== "string" || cacheRef.trim() === "") {
    throw new Error("cacheRef is required");
  }
  const normalizedCacheRef = cacheRef.trim();
  const exportCache = (reason) => ({
    shouldExport: true,
    cacheTo: `type=registry,ref=${normalizedCacheRef},mode=max`,
    reason,
  });
  const skipCache = (reason) => ({
    shouldExport: false,
    cacheTo: "",
    reason,
  });

  if (eventName !== "push" || ref !== "refs/heads/master") {
    return exportCache("non-master-push");
  }
  if (runnerImageMode !== "published") {
    return exportCache("runner-image-not-published");
  }
  if (lockfileRefreshed) {
    return exportCache("lockfile-refreshed");
  }
  if (remoteCacheExists !== true) {
    return exportCache("remote-cache-missing");
  }
  if (typeof baseSha !== "string" || !FULL_SHA_RE.test(baseSha)) {
    return exportCache("no-published-ancestor");
  }
  if (!Array.isArray(changedFiles)) {
    return exportCache("diff-unavailable");
  }
  if (typeof toolsEpoch !== "string" || !ISO_WEEK_EPOCH_RE.test(toolsEpoch)) {
    return exportCache("tools-epoch-unknown");
  }
  const baseEpoch = isoWeekEpoch(baseCommitIsoDate);
  if (!baseEpoch || baseEpoch !== toolsEpoch) {
    return exportCache("tools-epoch-rollover");
  }

  const changedCacheable = changedFiles.filter(isCacheableInputPath);
  if (changedCacheable.length > 0) {
    return exportCache(`cacheable-inputs-changed:${changedCacheable.slice(0, 3).join(",")}`);
  }

  return skipCache("cacheable-inputs-unchanged");
}

function runCommand(command, args, timeoutMs = 20_000) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isLockfileDirty() {
  const result = runCommand("git", ["status", "--porcelain", "--", "pnpm-lock.yaml"], 10_000);
  if (result.status !== 0) return true;
  return result.stdout.trim().length > 0;
}

function checkRemoteCacheExists(cacheRef) {
  const result = runCommand("docker", ["buildx", "imagetools", "inspect", cacheRef], 30_000);
  return result.status === 0;
}

function findRecentPublishedMasterAncestor(imageName, lookbackCommits) {
  const revList = runCommand(
    "git",
    ["rev-list", "--first-parent", "-n", String(lookbackCommits + 1), "HEAD"],
    10_000,
  );
  if (revList.status !== 0) return null;
  const commits = revList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FULL_SHA_RE.test(line))
    .slice(1); // skip HEAD itself

  for (const sha of commits) {
    const inspect = runCommand("docker", ["manifest", "inspect", `${imageName}:sha-${sha}`], 15_000);
    if (inspect.status === 0) return sha;
  }
  return null;
}

function listChangedFilesSince(baseSha) {
  const diff = runCommand("git", ["diff", "--name-only", baseSha, "HEAD"], 15_000);
  if (diff.status !== 0) return null;
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function getCommitIsoDate(sha) {
  const show = runCommand("git", ["show", "-s", "--format=%cI", sha], 10_000);
  if (show.status !== 0) return null;
  const value = show.stdout.trim();
  return value.length > 0 ? value : null;
}

function writeGitHubOutputs(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => {
    const clean = String(value).replaceAll("\r", "").replaceAll("\n", "");
    return `${key}=${clean}\n`;
  });
  appendFileSync(outputPath, lines.join(""), "utf8");
}

function main() {
  const eventName = process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "";
  const ref = process.env.REF ?? process.env.GITHUB_REF ?? "";
  const imageName = (process.env.IMAGE_NAME ?? "").trim();
  const cacheRef = (process.env.CACHE_REF ?? "").trim();
  const runnerImageMode = (process.env.RUNNER_IMAGE_MODE ?? "").trim();
  const toolsEpoch = (process.env.TOOLS_EPOCH ?? "").trim();
  const parsedLookback = Number.parseInt(process.env.MAX_ANCESTOR_LOOKBACK ?? "", 10);
  const lookbackCommits = Number.isInteger(parsedLookback) && parsedLookback > 0
    ? parsedLookback
    : DEFAULT_LOOKBACK_COMMITS;

  const lockfileRefreshed = isLockfileDirty();
  let remoteCacheExists = false;
  let baseSha = null;
  let changedFiles = null;
  let baseCommitIsoDate = null;

  const canSkipCandidate =
    eventName === "push"
    && ref === "refs/heads/master"
    && runnerImageMode === "published"
    && !lockfileRefreshed
    && imageName.length > 0;

  if (canSkipCandidate) {
    remoteCacheExists = checkRemoteCacheExists(cacheRef);
    if (remoteCacheExists) {
      baseSha = findRecentPublishedMasterAncestor(imageName, lookbackCommits);
      if (baseSha) {
        changedFiles = listChangedFilesSince(baseSha);
        baseCommitIsoDate = getCommitIsoDate(baseSha);
      }
    }
  }

  const decision = decideDockerCacheExport({
    eventName,
    ref,
    cacheRef,
    runnerImageMode,
    lockfileRefreshed,
    remoteCacheExists,
    baseSha,
    changedFiles,
    baseCommitIsoDate,
    toolsEpoch,
  });

  const action = decision.shouldExport ? "export" : "skip";
  console.log(
    `Docker BuildKit cache export policy: ${action} (reason=${decision.reason}, base=${baseSha ? baseSha.slice(0, 12) : "none"})`,
  );

  writeGitHubOutputs(process.env.GITHUB_OUTPUT, {
    cache_to: decision.cacheTo,
    should_export: String(decision.shouldExport),
    reason: decision.reason,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
