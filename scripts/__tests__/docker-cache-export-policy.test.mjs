import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  BUILDCACHE_KEY_LABEL,
  CACHEABLE_INPUT_EXACT_PATHS,
  computeBuildcacheKey,
  decideDockerCacheExport,
  extractBuildcacheKeyFromInspectJson,
  isCacheableInputPath,
} from "../docker-cache-export-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_REF = "ghcr.io/paperclipai/paperclip:buildcache-amd64";
const BASE_SHA = "a".repeat(40);
const KEY_A = "1".repeat(64);
const KEY_B = "2".repeat(64);

test("isCacheableInputPath matches all Dockerfile cacheable inputs and ignores app source", () => {
  for (const exactPath of CACHEABLE_INPUT_EXACT_PATHS) {
    assert.equal(isCacheableInputPath(exactPath), true, exactPath);
    assert.equal(isCacheableInputPath(`./${exactPath}`), true, `./${exactPath}`);
  }
  for (const cacheable of [
    "server/package.json",
    "ui/package.json",
    "packages/plugins/sandbox-providers/daytona/package.json",
    "patches/some-dep@1.0.0.patch",
  ]) {
    assert.equal(isCacheableInputPath(cacheable), true, cacheable);
  }
  for (const appOnly of [
    "server/src/routes/issues.ts",
    "ui/src/pages/Dashboard.tsx",
    "packages/shared/src/types/issue.ts",
    "doc/DEVELOPING.md",
    "scripts/docker-cache-export-policy.mjs",
    "server/src/package.json.bak",
    "patches-notes.md",
    "",
  ]) {
    assert.equal(isCacheableInputPath(appOnly), false, appOnly);
  }
});

test("computeBuildcacheKey is deterministic, order-independent, and sensitive to epoch and file bytes", () => {
  const k1 = computeBuildcacheKey({
    toolsEpoch: "2026-W48",
    files: [
      { path: "pnpm-lock.yaml", content: "lock-v1" },
      { path: "Dockerfile", content: "FROM node:24" },
    ],
  });
  const k2 = computeBuildcacheKey({
    toolsEpoch: "2026-W48",
    files: [
      { path: "Dockerfile", content: "FROM node:24" },
      { path: "./pnpm-lock.yaml", content: "lock-v1" },
    ],
  });
  const kWeekRollover = computeBuildcacheKey({
    toolsEpoch: "2026-W49",
    files: [
      { path: "Dockerfile", content: "FROM node:24" },
      { path: "pnpm-lock.yaml", content: "lock-v1" },
    ],
  });
  const kContentChanged = computeBuildcacheKey({
    toolsEpoch: "2026-W48",
    files: [
      { path: "Dockerfile", content: "FROM node:24" },
      { path: "pnpm-lock.yaml", content: "lock-v2" },
    ],
  });

  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(k1, k2);
  assert.notEqual(k1, kWeekRollover);
  assert.notEqual(k1, kContentChanged);
  assert.equal(computeBuildcacheKey({ toolsEpoch: "invalid", files: [{ path: "Dockerfile", content: "x" }] }), null);
  assert.equal(computeBuildcacheKey({ toolsEpoch: "2026-W48", files: [] }), null);
});

test("extractBuildcacheKeyFromInspectJson reads multi-arch and single-arch OCI labels safely", () => {
  const multiArch = JSON.stringify({
    "linux/amd64": { config: { Labels: { [BUILDCACHE_KEY_LABEL]: KEY_A } } },
    "linux/arm64": { config: { Labels: { [BUILDCACHE_KEY_LABEL]: KEY_B } } },
  });
  assert.equal(extractBuildcacheKeyFromInspectJson(multiArch, "linux/amd64"), KEY_A);
  assert.equal(extractBuildcacheKeyFromInspectJson(multiArch, "linux/arm64"), KEY_B);

  const singleArch = JSON.stringify({ config: { Labels: { [BUILDCACHE_KEY_LABEL]: KEY_A } } });
  assert.equal(extractBuildcacheKeyFromInspectJson(singleArch, "linux/amd64"), KEY_A);

  assert.equal(extractBuildcacheKeyFromInspectJson(JSON.stringify({ "linux/amd64": { config: { Labels: {} } } }), "linux/amd64"), null);
  assert.equal(extractBuildcacheKeyFromInspectJson(JSON.stringify({ "linux/amd64": { config: { Labels: { [BUILDCACHE_KEY_LABEL]: "not-a-sha" } } } }), "linux/amd64"), null);
  assert.equal(extractBuildcacheKeyFromInspectJson("not json", "linux/amd64"), null);
  assert.equal(extractBuildcacheKeyFromInspectJson("", "linux/amd64"), null);
});

test("non-master refs (release tags) never overwrite shared master buildcache", () => {
  for (const ref of ["refs/tags/v2026.1125.0", "refs/tags/nightly/v2026.1125.0", "refs/tags/beta/v2026.1125.0", "refs/heads/release"]) {
    const decision = decideDockerCacheExport({
      eventName: "push",
      ref,
      cacheRef: CACHE_REF,
      runnerImageMode: "published",
      lockfileRefreshed: false,
      remoteCacheExists: true,
      currentKey: KEY_A,
      baseSha: BASE_SHA,
      lastExportedKey: KEY_B,
      interveningChangedFiles: ["Dockerfile"],
    });
    assert.deepEqual(decision, {
      shouldExport: false,
      cacheTo: "",
      cacheLabel: "",
      reason: "non-master-ref-read-only",
    }, ref);
  }
});

test("decideDockerCacheExport skips export on master when content-addressed cache key and history are clean", () => {
  const decision = decideDockerCacheExport({
    eventName: "push",
    ref: "refs/heads/master",
    cacheRef: CACHE_REF,
    runnerImageMode: "published",
    lockfileRefreshed: false,
    remoteCacheExists: true,
    currentKey: KEY_A,
    baseSha: BASE_SHA,
    lastExportedKey: KEY_A,
    interveningChangedFiles: [
      "server/src/services/heartbeat.ts",
      "ui/src/pages/Agents.tsx",
      "packages/db/src/schema/issues.ts",
    ],
  });

  assert.deepEqual(decision, {
    shouldExport: false,
    cacheTo: "",
    cacheLabel: `${BUILDCACHE_KEY_LABEL}=${KEY_A}`,
    reason: "cache-key-unchanged",
  });
});

test("decideDockerCacheExport fails open to mode=max export on master whenever cache may be stale or missing", () => {
  const baseInput = {
    eventName: "push",
    ref: "refs/heads/master",
    cacheRef: CACHE_REF,
    runnerImageMode: "published",
    lockfileRefreshed: false,
    remoteCacheExists: true,
    currentKey: KEY_A,
    baseSha: BASE_SHA,
    lastExportedKey: KEY_A,
    interveningChangedFiles: ["server/src/index.ts"],
  };
  const expectedCacheTo = `type=registry,ref=${CACHE_REF},mode=max`;
  const expectedLabel = `${BUILDCACHE_KEY_LABEL}=${KEY_A}`;

  const cases = [
    ["manual master dispatch", { ...baseInput, eventName: "workflow_dispatch" }, "manual-master-refresh", expectedLabel],
    ["inline runner build", { ...baseInput, runnerImageMode: "inline" }, "runner-image-not-published", expectedLabel],
    ["refreshed lockfile", { ...baseInput, lockfileRefreshed: true }, "lockfile-refreshed", ""],
    ["missing current key", { ...baseInput, currentKey: null }, "cache-key-unavailable", ""],
    ["missing remote cache", { ...baseInput, remoteCacheExists: false }, "remote-cache-missing", expectedLabel],
    ["no published ancestor", { ...baseInput, baseSha: null }, "no-published-ancestor", expectedLabel],
    ["ancestor missing cache key (e.g. merge-queue promotion)", { ...baseInput, lastExportedKey: null }, "ancestor-missing-cache-key", expectedLabel],
    ["cache key changed (input edit or week rollover)", { ...baseInput, lastExportedKey: KEY_B }, "cache-key-changed", expectedLabel],
    ["intervening history unavailable", { ...baseInput, interveningChangedFiles: null }, "intervening-history-unavailable", expectedLabel],
    ["reverted cacheable edit in intervening commit", { ...baseInput, interveningChangedFiles: ["server/src/index.ts", "pnpm-lock.yaml"] }, "intervening-cacheable-edit:pnpm-lock.yaml", expectedLabel],
  ];

  for (const [label, input, expectedReason, expectedCacheLabel] of cases) {
    const decision = decideDockerCacheExport(input);
    assert.equal(decision.shouldExport, true, label);
    assert.equal(decision.cacheTo, expectedCacheTo, label);
    assert.equal(decision.cacheLabel, expectedCacheLabel, label);
    assert.equal(decision.reason, expectedReason, label);
  }
});

test("every pre-app context COPY in Dockerfile is covered by isCacheableInputPath", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const froms = [...dockerfile.matchAll(/^FROM .*$/gm)];
  const stageBody = (stageName) => {
    const idx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\s*$`).test(m[0]));
    assert.ok(idx >= 0, `missing stage ${stageName}`);
    return dockerfile.slice(froms[idx].index, froms[idx + 1]?.index ?? dockerfile.length);
  };

  const productionStage = stageBody("production");
  const appCopyIdx = productionStage.indexOf("COPY --chown=node:node --exclude=node_modules --from=build /app /app");
  assert.ok(appCopyIdx > 0, "production stage must copy app files from build");
  const preAppProduction = productionStage.slice(0, appCopyIdx);

  const stagesToAudit = [
    ["tailscale-client", stageBody("tailscale-client")],
    ["runner-lockfile", stageBody("runner-lockfile")],
    ["deps", stageBody("deps")],
    ["production (pre-app)", preAppProduction],
  ];

  for (const [stageName, body] of stagesToAudit) {
    for (const match of body.matchAll(/^COPY\s+(.+)$/gm)) {
      const tokens = match[1].trim().split(/\s+/);
      if (tokens.some((token) => token.startsWith("--from="))) continue;
      const paths = tokens.filter((token) => !token.startsWith("--")).slice(0, -1);
      for (const rawSource of paths) {
        const samplePath = rawSource
          .replace("/./", "/")
          .replaceAll("*", "example")
          .replace(/\/$/, "");
        assert.equal(
          isCacheableInputPath(samplePath),
          true,
          `Dockerfile ${stageName} COPY source '${rawSource}' (sample '${samplePath}') must be covered by isCacheableInputPath`,
        );
      }
    }
  }
});

test("docker.yml wires cache export policy and cache key label into Build and push by digest", () => {
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
  const buildJob = workflow.split("  build-and-push:\n")[1].split("\n  merge-and-push:")[0];
  const steps = buildJob.split(/\n(?=      - )/);

  const policyIdx = steps.findIndex((step) => step.includes("node scripts/docker-cache-export-policy.mjs"));
  const buildIdx = steps.findIndex((step) => step.includes("uses: docker/build-push-action@"));
  assert.ok(policyIdx >= 0, "docker.yml must invoke scripts/docker-cache-export-policy.mjs");
  assert.ok(buildIdx > policyIdx, "cache export policy must run before docker/build-push-action");

  const policyStep = steps[policyIdx];
  assert.match(policyStep, /id: cache-policy/);
  assert.match(policyStep, /CACHE_REF: ghcr\.io\/\$\{\{ github\.repository \}\}:buildcache-\$\{\{ matrix\.arch \}\}/);
  assert.match(policyStep, /PLATFORM: \$\{\{ matrix\.platform \}\}/);
  assert.match(policyStep, /RUNNER_IMAGE_MODE: \$\{\{ needs\.runner_image\.outputs\.mode \}\}/);
  assert.match(policyStep, /TOOLS_EPOCH: \$\{\{ steps\.tools-epoch\.outputs\.epoch \}\}/);
  const runBlock = policyStep.slice(policyStep.indexOf("run:"));
  assert.doesNotMatch(runBlock, /\$\{\{/, "pass workflow expressions via env, not inline in run");

  const buildStep = steps[buildIdx];
  assert.match(buildStep, /cache-from: type=registry,ref=ghcr\.io\/\$\{\{ github\.repository \}\}:buildcache-\$\{\{ matrix\.arch \}\}/);
  assert.match(buildStep, /cache-to: \$\{\{ steps\.cache-policy\.outputs\.cache_to \}\}/);
  assert.match(buildStep, /\$\{\{ steps\.cache-policy\.outputs\.cache_label \}\}/);
});
