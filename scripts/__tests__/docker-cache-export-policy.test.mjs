import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CACHEABLE_INPUT_EXACT_PATHS,
  decideDockerCacheExport,
  isCacheableInputPath,
  isoWeekEpoch,
} from "../docker-cache-export-policy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_REF = "ghcr.io/paperclipai/paperclip:buildcache-amd64";
const BASE_SHA = "a".repeat(40);

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

test("isoWeekEpoch matches UTC ISO-8601 week numbering across year boundaries", () => {
  assert.equal(isoWeekEpoch("2025-12-29T00:00:00Z"), "2026-W01");
  assert.equal(isoWeekEpoch("2026-01-04T23:59:59Z"), "2026-W01");
  assert.equal(isoWeekEpoch("2026-01-05T00:00:00Z"), "2026-W02");
  assert.equal(isoWeekEpoch("2021-01-01T00:00:00Z"), "2020-W53");
  assert.equal(isoWeekEpoch("2026-11-25T18:00:00-06:00"), "2026-W48");
  assert.equal(isoWeekEpoch(""), null);
  assert.equal(isoWeekEpoch("not-a-date"), null);
  assert.equal(isoWeekEpoch(null), null);
});

test("decideDockerCacheExport skips export on master when cacheable inputs and week epoch are unchanged", () => {
  const decision = decideDockerCacheExport({
    eventName: "push",
    ref: "refs/heads/master",
    cacheRef: CACHE_REF,
    runnerImageMode: "published",
    lockfileRefreshed: false,
    remoteCacheExists: true,
    baseSha: BASE_SHA,
    changedFiles: [
      "server/src/services/heartbeat.ts",
      "ui/src/pages/Agents.tsx",
      "packages/db/src/schema/issues.ts",
    ],
    baseCommitIsoDate: "2026-11-25T12:00:00Z",
    toolsEpoch: "2026-W48",
  });

  assert.deepEqual(decision, {
    shouldExport: false,
    cacheTo: "",
    reason: "cacheable-inputs-unchanged",
  });
});

test("decideDockerCacheExport fails open to mode=max export whenever cache may be stale or missing", () => {
  const baseInput = {
    eventName: "push",
    ref: "refs/heads/master",
    cacheRef: CACHE_REF,
    runnerImageMode: "published",
    lockfileRefreshed: false,
    remoteCacheExists: true,
    baseSha: BASE_SHA,
    changedFiles: ["server/src/index.ts"],
    baseCommitIsoDate: "2026-11-25T12:00:00Z",
    toolsEpoch: "2026-W48",
  };
  const expectedCacheTo = `type=registry,ref=${CACHE_REF},mode=max`;

  const cases = [
    ["tag push", { ...baseInput, ref: "refs/tags/v2026.1125.0" }, "non-master-push"],
    ["workflow_dispatch", { ...baseInput, eventName: "workflow_dispatch" }, "non-master-push"],
    ["inline runner build", { ...baseInput, runnerImageMode: "inline" }, "runner-image-not-published"],
    ["refreshed lockfile", { ...baseInput, lockfileRefreshed: true }, "lockfile-refreshed"],
    ["missing remote cache", { ...baseInput, remoteCacheExists: false }, "remote-cache-missing"],
    ["no published ancestor", { ...baseInput, baseSha: null }, "no-published-ancestor"],
    ["invalid ancestor sha", { ...baseInput, baseSha: "abc123" }, "no-published-ancestor"],
    ["diff unavailable", { ...baseInput, changedFiles: null }, "diff-unavailable"],
    ["unknown tools epoch", { ...baseInput, toolsEpoch: "" }, "tools-epoch-unknown"],
    ["missing base date", { ...baseInput, baseCommitIsoDate: null }, "tools-epoch-rollover"],
    ["week rollover", { ...baseInput, baseCommitIsoDate: "2026-11-22T23:59:59Z", toolsEpoch: "2026-W48" }, "tools-epoch-rollover"],
    ["lockfile changed", { ...baseInput, changedFiles: ["server/src/index.ts", "pnpm-lock.yaml"] }, "cacheable-inputs-changed:pnpm-lock.yaml"],
    ["Dockerfile changed", { ...baseInput, changedFiles: ["Dockerfile"] }, "cacheable-inputs-changed:Dockerfile"],
    ["workspace package.json changed", { ...baseInput, changedFiles: ["packages/db/package.json"] }, "cacheable-inputs-changed:packages/db/package.json"],
    ["entrypoint changed", { ...baseInput, changedFiles: ["scripts/docker-entrypoint.sh"] }, "cacheable-inputs-changed:scripts/docker-entrypoint.sh"],
    ["patch changed", { ...baseInput, changedFiles: ["patches/foo@1.0.0.patch"] }, "cacheable-inputs-changed:patches/foo@1.0.0.patch"],
  ];

  for (const [label, input, expectedReason] of cases) {
    const decision = decideDockerCacheExport(input);
    assert.equal(decision.shouldExport, true, label);
    assert.equal(decision.cacheTo, expectedCacheTo, label);
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

test("docker.yml wires cache export policy into Build and push by digest without breaking cache-from", () => {
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
  assert.match(policyStep, /RUNNER_IMAGE_MODE: \$\{\{ needs\.runner_image\.outputs\.mode \}\}/);
  assert.match(policyStep, /TOOLS_EPOCH: \$\{\{ steps\.tools-epoch\.outputs\.epoch \}\}/);
  const runBlock = policyStep.slice(policyStep.indexOf("run:"));
  assert.doesNotMatch(runBlock, /\$\{\{/, "pass workflow expressions via env, not inline in run");

  const buildStep = steps[buildIdx];
  assert.match(buildStep, /cache-from: type=registry,ref=ghcr\.io\/\$\{\{ github\.repository \}\}:buildcache-\$\{\{ matrix\.arch \}\}/);
  assert.match(buildStep, /cache-to: \$\{\{ steps\.cache-policy\.outputs\.cache_to \}\}/);
});
