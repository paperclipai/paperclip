import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildProtocolEvalPointers,
  createProtocolEvalBundleManifest,
  emptyProtocolEvalHistory,
  isPublicProtocolEvalPath,
  mergeProtocolEvalHistory,
  protocolEvalHistoryRecord,
  renderProtocolEvalHistoryIndex,
  validateProtocolEvalHistoryDestination,
  validatePublicProtocolEvalReport,
} from "./publish-runner-protocol-eval-history.mjs";

const roots = [];
test.afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function campaign(overrides = {}) {
  return {
    schema: "paperclip.runner-protocol-eval.campaign/v1",
    campaignId: "gha-42-1",
    generatedAt: "2026-09-05T00:00:00.000Z",
    source: {
      paperclip: { sha: "a".repeat(40), ref: "refs/heads/master" },
      evals: { repository: "paperclipai/paperclip-evals", sha: "b".repeat(40) },
    },
    complete: true,
    allPassed: true,
    totals: {
      selected: 35,
      passed: 35,
      behaviorFailures: 0,
      infrastructureFailures: 0,
    },
    rosters: [
      {
        rosterId: "protocol-live-mini",
        model: "gpt-5.4-mini",
        provider: "codex",
        driver: "codex_app_server",
        selected: 35,
        passed: 35,
      },
    ],
    results: [],
    ...overrides,
  };
}

async function reportFixture() {
  const root = await mkdtemp(join(tmpdir(), "runner-protocol-public-"));
  roots.push(root);
  await Promise.all([
    mkdir(join(root, "tests"), { recursive: true }),
    mkdir(join(root, "attempts"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "campaign.json"), JSON.stringify(campaign())),
    writeFile(
      join(root, "index.html"),
      '<!doctype html><a href="tests/get-context.html">test</a><a href="attempts/attempt-01.html">attempt</a>',
    ),
    writeFile(
      join(root, "tests/get-context.html"),
      '<a href="../index.html">overview</a>',
    ),
    writeFile(
      join(root, "attempts/attempt-01.html"),
      '<a href="../index.html">overview</a>',
    ),
  ]);
  return root;
}

test("accepts only credential-free HTTPS destinations and the dedicated prefix", () => {
  assert.deepEqual(
    validateProtocolEvalHistoryDestination({
      bucket: "paperclip-public-reports",
      prefix: "/runner-protocol-evals/",
      publicBaseUrl: "https://reports.paperclip.ing/",
    }),
    {
      bucket: "paperclip-public-reports",
      prefix: "runner-protocol-evals",
      publicBaseUrl: "https://reports.paperclip.ing",
    },
  );
  assert.throws(
    () =>
      validateProtocolEvalHistoryDestination({
        bucket: "bad",
        prefix: "../evals",
        publicBaseUrl: "http://example.test",
      }),
    /prefix|HTTPS/,
  );
});

test("keeps publication to the canonical static Evalbook surface", () => {
  for (const file of [
    "index.html",
    "latest.html",
    "inventory.html",
    "tests/get-context.html",
    "attempts/attempt-01.html",
    "campaign.json",
  ]) {
    assert.equal(isPublicProtocolEvalPath(file), true, file);
  }
  for (const file of [
    "attempts/attempt-01/index.html",
    "runs/attempt/artifact.json",
    "provider-trace.log",
    "../secret",
    "assets/app.js",
  ]) {
    assert.equal(isPublicProtocolEvalPath(file), false, file);
  }
});

test("validates inert linked reports and creates deterministic manifests", async () => {
  const root = await reportFixture();
  const result = await validatePublicProtocolEvalReport(root);
  assert.equal(result.files.length, 4);
  const first = await createProtocolEvalBundleManifest(root, "gha-42-1");
  const second = await createProtocolEvalBundleManifest(root, "gha-42-1");
  assert.deepEqual(second, first);
  assert.match(first.bundleDigest, /^[0-9a-f]{64}$/);
});

test("rejects scripts, remote resources, raw sessions, secret-shaped values, and broken links", async () => {
  for (const bad of [
    "<script>alert(1)</script>",
    '<a href="https://attacker.example">remote</a>',
    '<pre>{"providerSessionId":"session"}</pre>',
    `<pre>${"sk-" + "a".repeat(24)}</pre>`,
    '<a href="missing.html">broken</a>',
  ]) {
    const root = await reportFixture();
    await writeFile(join(root, "index.html"), bad);
    await assert.rejects(validatePublicProtocolEvalReport(root));
  }
});

test("retains immutable history and independent latest-green pointers", () => {
  const green = protocolEvalHistoryRecord(
    campaign(),
    "https://reports.example/runner-protocol-evals",
  );
  const red = protocolEvalHistoryRecord(
    campaign({
      campaignId: "gha-43-1",
      generatedAt: "2026-09-05T01:00:00.000Z",
      allPassed: false,
      totals: {
        selected: 35,
        passed: 34,
        behaviorFailures: 1,
        infrastructureFailures: 0,
      },
      rosters: [{ ...campaign().rosters[0], passed: 34 }],
    }),
    "https://reports.example/runner-protocol-evals",
  );
  let history = mergeProtocolEvalHistory(emptyProtocolEvalHistory(), green);
  history = mergeProtocolEvalHistory(history, red);
  assert.equal(history.latestCampaignId, "gha-43-1");
  assert.equal(history.latestGreenCampaignId, "gha-42-1");
  const pointers = buildProtocolEvalPointers(history);
  assert.equal(pointers.latest.campaign.campaignId, "gha-43-1");
  assert.equal(pointers.latestGreen.campaign.campaignId, "gha-42-1");
  const index = renderProtocolEvalHistoryIndex(history);
  assert.match(index, /Runner protocol eval campaigns/);
  assert.match(index, /Open Evalbook/);
  assert.match(index, /34\/35/);
  assert.doesNotMatch(index, /private-session-id|sk-[A-Za-z0-9_-]{20,}/);
  assert.throws(
    () => mergeProtocolEvalHistory(history, { ...green, allPassed: false }),
    /Immutable campaign history changed/,
  );
});

test("retains the latest green pointer outside the 200 newest campaigns", () => {
  const green = protocolEvalHistoryRecord(
    campaign(),
    "https://reports.example/runner-protocol-evals",
  );
  let history = mergeProtocolEvalHistory(emptyProtocolEvalHistory(), green);
  for (let index = 0; index < 201; index += 1) {
    history = mergeProtocolEvalHistory(
      history,
      protocolEvalHistoryRecord(
        campaign({
          campaignId: `gha-${index + 43}-1`,
          generatedAt: new Date(
            Date.UTC(2026, 8, 5, 1, 0, index),
          ).toISOString(),
          allPassed: false,
        }),
        "https://reports.example/runner-protocol-evals",
      ),
    );
  }

  assert.equal(history.campaigns.length, 200);
  assert.equal(history.latestCampaignId, "gha-243-1");
  assert.equal(history.latestGreenCampaignId, "gha-42-1");
  assert.equal(history.campaigns.at(-1).campaignId, "gha-42-1");
  assert.equal(
    buildProtocolEvalPointers(history).latestGreen.campaign.campaignId,
    "gha-42-1",
  );
});
