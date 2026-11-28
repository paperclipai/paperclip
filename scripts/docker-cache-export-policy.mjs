#!/usr/bin/env node
// Decides whether `.github/workflows/docker.yml` should export its BuildKit
// registry cache (`cache-to: ...,mode=max`) for this build, and computes the
// content-addressed cache key stamped onto published `master` images.
//
// `mode=max` exports every intermediate stage, including the per-commit `build`
// stage (~4 GB), which adds ~2.5-3 minutes *after* the production image has
// already been pushed.
//
// Ownership and freshness invariants:
// 1. Only `refs/heads/master` writes `:buildcache-<arch>`. Tag builds
//    (`refs/tags/*`) still read `cache-from: ...:buildcache-<arch>` for speed
//    but never overwrite it, preventing older release branches from clobbering
//    `master`'s shared cache.
// 2. Every `Build and push by digest` on `refs/heads/master` (with a clean
//    lockfile) stamps `io.github.paperclipai.buildcache.key=<sha256>` on the
//    published per-arch image config, where `<sha256>` hashes
//    `CLI_TOOLS_CACHE_EPOCH` plus the exact bytes of every cross-commit
//    cacheable Dockerfile input.
// 3. A `push` to `refs/heads/master` skips `cache-to` ONLY when:
//    - the Runner image is published (not inline),
//    - `pnpm-lock.yaml` was not mutated in the checkout,
//    - `:buildcache-<arch>` currently exists in the registry,
//    - the most recent published `master` ancestor (in the last 10 commits)
//      carries a matching `io.github.paperclipai.buildcache.key` for this
//      platform (automatically failing open if that ancestor was promoted from
//      the merge queue without writing cache, or if any input or ISO week
//      changed), AND
//    - no commit in `baseSha..HEAD` touched a cacheable input (protecting
//      against an unpublished failed-and-reverted intermediate commit that may
//      have overwritten `:buildcache-<arch>`).
//
// Any uncertainty fails open to exporting `mode=max` on `refs/heads/master`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LOOKBACK_COMMITS = 10;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const ISO_WEEK_EPOCH_RE = /^\d{4}-W\d{2}$/;

export const BUILDCACHE_KEY_LABEL = "io.github.paperclipai.buildcache.key";

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
 * Computes a deterministic 64-char SHA-256 fingerprint for `CLI_TOOLS_CACHE_EPOCH`
 * and every cross-commit cacheable input file.
 *
 * @param {{ toolsEpoch: string, files: Array<{ path: string, content: Buffer | string }> }} input
 * @returns {string | null}
 */
export function computeBuildcacheKey({ toolsEpoch, files }) {
  if (typeof toolsEpoch !== "string" || !ISO_WEEK_EPOCH_RE.test(toolsEpoch)) return null;
  if (!Array.isArray(files) || files.length === 0) return null;

  const sorted = [...files]
    .map((entry) => ({
      path: String(entry.path).replaceAll("\\", "/").replace(/^\.\//, ""),
      content: entry.content,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hash = createHash("sha256");
  hash.update("paperclip-buildcache-key-v1\n");
  hash.update(`toolsEpoch=${toolsEpoch}\n`);
  for (const entry of sorted) {
    const fileDigest = createHash("sha256").update(entry.content).digest("hex");
    hash.update(`${entry.path}\0${fileDigest}\n`);
  }
  return hash.digest("hex");
}

/**
 * Extracts `io.github.paperclipai.buildcache.key` from the JSON output of
 * `docker buildx imagetools inspect <ref> --format '{{json .Image}}'`.
 */
export function extractBuildcacheKeyFromInspectJson(rawJson, platform) {
  if (typeof rawJson !== "string" || rawJson.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const entry = (platform && parsed[platform] && typeof parsed[platform] === "object")
    ? parsed[platform]
    : parsed;
  const labels = entry?.config?.Labels ?? entry?.Config?.Labels;
  const key = labels?.[BUILDCACHE_KEY_LABEL];
  return typeof key === "string" && HEX_64_RE.test(key) ? key : null;
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
 *   currentKey?: string | null,
 *   baseSha?: string | null,
 *   lastExportedKey?: string | null,
 *   interveningChangedFiles?: string[] | null,
 * }} input
 * @returns {{ shouldExport: boolean, cacheTo: string, cacheLabel: string, reason: string }}
 */
export function decideDockerCacheExport({
  eventName,
  ref,
  cacheRef,
  runnerImageMode,
  lockfileRefreshed = false,
  remoteCacheExists = false,
  currentKey = null,
  baseSha = null,
  lastExportedKey = null,
  interveningChangedFiles = null,
}) {
  if (typeof cacheRef !== "string" || cacheRef.trim() === "") {
    throw new Error("cacheRef is required");
  }
  const normalizedCacheRef = cacheRef.trim();
  const validCurrentKey = typeof currentKey === "string" && HEX_64_RE.test(currentKey) ? currentKey : null;

  // Release tags and non-master refs read the shared master cache via
  // cache-from but must never overwrite it (concurrent older release builds
  // would otherwise evict master's dependency/tool layers).
  if (ref !== "refs/heads/master") {
    return {
      shouldExport: false,
      cacheTo: "",
      cacheLabel: "",
      reason: "non-master-ref-read-only",
    };
  }

  const labelForMaster = (!lockfileRefreshed && validCurrentKey)
    ? `${BUILDCACHE_KEY_LABEL}=${validCurrentKey}`
    : "";

  const exportCache = (reason) => ({
    shouldExport: true,
    cacheTo: `type=registry,ref=${normalizedCacheRef},mode=max`,
    cacheLabel: labelForMaster,
    reason,
  });
  const skipCache = (reason) => ({
    shouldExport: false,
    cacheTo: "",
    cacheLabel: labelForMaster,
    reason,
  });

  if (eventName === "workflow_dispatch") {
    return exportCache("manual-master-refresh");
  }
  if (eventName !== "push") {
    return exportCache("non-push-master-event");
  }
  if (runnerImageMode !== "published") {
    return exportCache("runner-image-not-published");
  }
  if (lockfileRefreshed) {
    return exportCache("lockfile-refreshed");
  }
  if (!validCurrentKey) {
    return exportCache("cache-key-unavailable");
  }
  if (remoteCacheExists !== true) {
    return exportCache("remote-cache-missing");
  }
  if (typeof baseSha !== "string" || !FULL_SHA_RE.test(baseSha)) {
    return exportCache("no-published-ancestor");
  }
  if (typeof lastExportedKey !== "string" || !HEX_64_RE.test(lastExportedKey)) {
    return exportCache("ancestor-missing-cache-key");
  }
  if (lastExportedKey !== validCurrentKey) {
    return exportCache("cache-key-changed");
  }
  if (!Array.isArray(interveningChangedFiles)) {
    return exportCache("intervening-history-unavailable");
  }
  const interveningCacheable = interveningChangedFiles.filter(isCacheableInputPath);
  if (interveningCacheable.length > 0) {
    return exportCache(`intervening-cacheable-edit:${interveningCacheable.slice(0, 3).join(",")}`);
  }

  return skipCache("cache-key-unchanged");
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

function computeWorkspaceBuildcacheKey(repoRoot, toolsEpoch) {
  if (!ISO_WEEK_EPOCH_RE.test(toolsEpoch)) return null;
  const listed = runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], 15_000);
  if (listed.status !== 0) return null;
  const matchedPaths = listed.stdout
    .split("\0")
    .filter((filePath) => filePath.length > 0 && isCacheableInputPath(filePath));
  if (matchedPaths.length === 0) return null;

  const files = [];
  for (const relPath of matchedPaths) {
    try {
      files.push({ path: relPath, content: readFileSync(path.join(repoRoot, relPath)) });
    } catch {
      return null;
    }
  }
  return computeBuildcacheKey({ toolsEpoch, files });
}

function checkRemoteCacheExists(cacheRef) {
  const result = runCommand("docker", ["buildx", "imagetools", "inspect", cacheRef], 30_000);
  return result.status === 0;
}

function findRecentPublishedMasterAncestor(imageName, platform, lookbackCommits) {
  const revList = runCommand(
    "git",
    ["rev-list", "--first-parent", "-n", String(lookbackCommits + 1), "HEAD"],
    10_000,
  );
  if (revList.status !== 0) return { baseSha: null, lastExportedKey: null };
  const commits = revList.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FULL_SHA_RE.test(line))
    .slice(1); // skip HEAD itself

  for (const sha of commits) {
    const inspect = runCommand(
      "docker",
      ["buildx", "imagetools", "inspect", `${imageName}:sha-${sha}`, "--format", "{{json .Image}}"],
      20_000,
    );
    if (inspect.status === 0) {
      return {
        baseSha: sha,
        lastExportedKey: extractBuildcacheKeyFromInspectJson(inspect.stdout, platform),
      };
    }
  }
  return { baseSha: null, lastExportedKey: null };
}

function listInterveningChangedFiles(baseSha) {
  const log = runCommand("git", ["log", "--format=", "--name-only", `${baseSha}..HEAD`], 15_000);
  if (log.status !== 0) return null;
  return [...new Set(
    log.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  )];
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
  const platform = (process.env.PLATFORM ?? "").trim();
  const runnerImageMode = (process.env.RUNNER_IMAGE_MODE ?? "").trim();
  const toolsEpoch = (process.env.TOOLS_EPOCH ?? "").trim();
  const parsedLookback = Number.parseInt(process.env.MAX_ANCESTOR_LOOKBACK ?? "", 10);
  const lookbackCommits = Number.isInteger(parsedLookback) && parsedLookback > 0
    ? parsedLookback
    : DEFAULT_LOOKBACK_COMMITS;

  const isMaster = ref === "refs/heads/master";
  const lockfileRefreshed = isMaster ? isLockfileDirty() : false;
  const currentKey = isMaster ? computeWorkspaceBuildcacheKey(process.cwd(), toolsEpoch) : null;

  let remoteCacheExists = false;
  let baseSha = null;
  let lastExportedKey = null;
  let interveningChangedFiles = null;

  const canSkipCandidate =
    isMaster
    && eventName === "push"
    && runnerImageMode === "published"
    && !lockfileRefreshed
    && currentKey !== null
    && imageName.length > 0;

  if (canSkipCandidate) {
    remoteCacheExists = checkRemoteCacheExists(cacheRef);
    if (remoteCacheExists) {
      ({ baseSha, lastExportedKey } = findRecentPublishedMasterAncestor(imageName, platform, lookbackCommits));
      if (baseSha && lastExportedKey === currentKey) {
        interveningChangedFiles = listInterveningChangedFiles(baseSha);
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
    currentKey,
    baseSha,
    lastExportedKey,
    interveningChangedFiles,
  });

  const action = decision.shouldExport ? "export" : "skip";
  console.log(
    `Docker BuildKit cache export policy: ${action} (reason=${decision.reason}, base=${baseSha ? baseSha.slice(0, 12) : "none"}, key=${currentKey ? currentKey.slice(0, 12) : "none"})`,
  );

  writeGitHubOutputs(process.env.GITHUB_OUTPUT, {
    cache_to: decision.cacheTo,
    cache_label: decision.cacheLabel,
    should_export: String(decision.shouldExport),
    reason: decision.reason,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
