import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";
import {
  buildHistoryPointers,
  createBundleManifest,
  isHistoricalBundlePathAllowed,
  prunePrivateHistoryEvidence,
  validateHistoryDestination,
} from "./history-publish.js";
import {
  buildRunnerCampaign,
  campaignHistoryRecord,
  canonicalExecutionId,
  emptyRunnerHistory,
  mergeRunnerHistory,
} from "./history.js";
import { renderRunnerHistoryIndex } from "./history-index.js";
import type { MatrixExecution, RunnerE2EResult } from "./types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function result(execution: MatrixExecution, status: "passed" | "failed") {
  return {
    schema: "paperclip.runner-e2e.result/v2",
    executionId: execution.id,
    suiteId: execution.suite.id,
    suiteDefinitionHash: execution.suiteDefinitionHash,
    attempt: 1,
    status,
    profileId: execution.profile.id,
    environmentId: execution.environment.id,
    caseId: execution.task.id,
    provider: execution.profile.provider,
    model: execution.profile.model,
    runtimeMode: execution.profile.expectedRuntimeMode,
    runIds: ["run-1"],
    usage: { inputTokens: 100, outputTokens: 25, costUsd: 0.01 },
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1_000,
    cleanup: "passed",
  } satisfies RunnerE2EResult;
}

describe("runner E2E campaign history", () => {
  it("records the resolved paid target instead of the trusted workflow checkout", () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_SHA", "target-sha");
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_REF", "refs/heads/target");
    vi.stubEnv("GITHUB_SHA", "trusted-master-sha");
    vi.stubEnv("GITHUB_REF", "refs/heads/master");
    const execution = runnerMatrix[0]!;
    const campaign = buildRunnerCampaign({
      campaignId: "target-provenance",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [
        {
          ...result(execution, "passed"),
          source: {
            sha: "retained-result-sha",
            ref: "refs/heads/retained-result",
            workflowRunUrl: "https://example.test/actions/runs/1",
          },
        },
      ],
    });

    expect(campaign.source).toMatchObject({
      sha: "target-sha",
      ref: "refs/heads/target",
      workflowRunUrl: "https://example.test/actions/runs/1",
    });
  });

  it("migrates v1 execution IDs and keeps partial suite runs out of overall trends", () => {
    expect(canonicalExecutionId("legacy-codex.local.message-marker")).toBe(
      "core-compatibility.legacy-codex.local.message-marker",
    );
    const breadth = runnerMatrix.filter(
      (execution) => execution.suite.id === "openrouter-model-breadth",
    );
    const campaign = buildRunnerCampaign({
      campaignId: "breadth-smoke",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: breadth.map((execution) => execution.id),
      results: breadth.map((execution) => result(execution, "passed")),
    });
    expect(campaign).toMatchObject({ complete: false, passed: 10, failed: 0 });
    expect(campaign.suites[0]).toMatchObject({
      suiteId: "openrouter-model-breadth",
      complete: true,
      selected: 10,
    });
    expect(campaign.billing).toMatchObject({
      llm: { inputTokens: 1_000, outputTokens: 250 },
    });
    expect(campaign.billing.reportedLlmCostUsd).toBeCloseTo(0.1, 10);
    const history = mergeRunnerHistory(
      emptyRunnerHistory(),
      campaignHistoryRecord(campaign, "https://history.example/runner-e2e"),
    );
    expect(history.latestGreenCampaignId).toBeNull();
    expect(history.latestGreenBySuite).toEqual({
      "openrouter-model-breadth": "breadth-smoke",
    });
  });

  it("retains latest and latest-green pointers independently", () => {
    const green = buildRunnerCampaign({
      campaignId: "complete-green",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: runnerMatrix.map((execution) => execution.id),
      results: runnerMatrix.map((execution) => result(execution, "passed")),
    });
    const red = buildRunnerCampaign({
      campaignId: "complete-red",
      generatedAt: "2026-08-28T01:01:00.000Z",
      expected: runnerMatrix.map((execution) => execution.id),
      results: runnerMatrix.map((execution, index) =>
        result(execution, index === 0 ? "failed" : "passed"),
      ),
    });
    let history = mergeRunnerHistory(
      emptyRunnerHistory(),
      campaignHistoryRecord(green, "https://history.example/runner-e2e"),
    );
    history = mergeRunnerHistory(
      history,
      campaignHistoryRecord(red, "https://history.example/runner-e2e"),
    );
    const pointers = buildHistoryPointers(history);
    expect(pointers.latest.overall).toMatchObject({
      campaignId: "complete-red",
    });
    expect(pointers.latestGreen.overall).toMatchObject({
      campaignId: "complete-green",
    });
    expect(history.campaigns).toHaveLength(2);
    const dashboard = renderRunnerE2EDashboard({
      title: "Runner Full-Stack E2E",
      generatedAt: red.generatedAt,
      expected: red.expected,
      catalog: runnerMatrix,
      campaign: red,
      history,
      entries: red.results.map((campaignResult) => ({
        result: campaignResult,
        valid: campaignResult.status === "passed",
        errors: campaignResult.status === "passed" ? [] : ["failed"],
      })),
    });
    expect(dashboard).toContain("Campaign trends");
    expect(dashboard).toContain("data-history-from");
    expect(dashboard).toContain("data-history-through");
    expect(dashboard).toContain(
      'data-history-suite-trends="core-compatibility"',
    );
    expect(dashboard).toContain(
      'data-history-suite-trends="openrouter-model-breadth"',
    );
    expect(dashboard).toContain(
      'data-history-suite-trends="local-session-integrity"',
    );
    expect(dashboard).toContain("Suite pass rate");
    expect(dashboard).toContain("lines break at definition changes");
    expect(dashboard).toContain("cleanup passed");
    const index = renderRunnerHistoryIndex(history);
    expect(index).toContain("Runner E2E campaigns");
    expect(index).toContain("complete-green");
    expect(index).toContain("complete-red");
    expect(index).toContain("66/66 passed");
    expect(index).toContain("65/66 passed");
    expect(index).toContain("Open report&nbsp;→");
    expect(index).toContain(
      "Visual evidence remains in access-controlled workflow artifacts",
    );
    expect(index).toContain("Inert structured public evidence");
    expect(index).not.toContain("data-gallery-dialog");
    expect(index).not.toContain("Configuration matrix");
  });
});

describe("historical publication security", () => {
  it("keeps visual and active evidence private when building the public dashboard", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-landing-test-"));
    const output = path.join(root, "landing");
    temporaryDirectories.push(root);
    const execution = runnerMatrix[0]!;
    const campaignResult = {
      ...result(execution, "passed"),
      screenshots: [
        {
          id: "final-state",
          label: "Final state",
          file: "final-state.png",
        },
      ],
    } satisfies RunnerE2EResult;
    const campaign = buildRunnerCampaign({
      campaignId: "campaign-1",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [campaignResult],
    });
    const evidenceDirectory = path.join(
      root,
      "evidence",
      execution.id,
      "attempt-1",
    );
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(
      path.join(root, "normalized-results.json"),
      JSON.stringify(campaign),
    );
    await writeFile(path.join(evidenceDirectory, "final-state.png"), "png");
    await writeFile(path.join(evidenceDirectory, "failure.webm"), "webm");
    await writeFile(path.join(evidenceDirectory, "unsafe.svg"), "<svg />");
    await writeFile(
      path.join(evidenceDirectory, "junit.xml"),
      "<?xml-stylesheet href='https://example.test/private.xsl'?>",
    );
    await writeFile(path.join(evidenceDirectory, "result.json"), "{}\n");
    await mkdir(path.join(evidenceDirectory, "snapshots"));
    await writeFile(
      path.join(evidenceDirectory, "snapshots", "api-state.json"),
      "{}\n",
    );
    await mkdir(path.join(evidenceDirectory, "html-report"));
    await writeFile(
      path.join(evidenceDirectory, "html-report", "index.html"),
      "<img src='data:image/png;base64,cHJpdmF0ZQ==' />",
    );
    await mkdir(path.join(evidenceDirectory, "blob-report"));
    await writeFile(
      path.join(evidenceDirectory, "blob-report", "report.zip"),
      "private archive",
    );

    await prunePrivateHistoryEvidence(root);
    await regenerateRunnerDashboard({
      bundle: root,
      outputDirectory: output,
      evidenceHrefPrefix: "campaigns/campaign-1",
    });
    const dashboard = await readFile(path.join(output, "index.html"), "utf8");
    expect(dashboard).not.toContain(
      `campaigns/campaign-1/evidence/${execution.id}/attempt-1/final-state.png`,
    );
    expect(dashboard).toContain("Visual evidence · workflow artifact only");
    expect(dashboard).toContain(
      "public history contains inert structured evidence only",
    );
    expect(dashboard).toContain("Public history excludes visual evidence");
    await expect(
      readFile(path.join(evidenceDirectory, "final-state.png")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "failure.webm")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "unsafe.svg")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "junit.xml")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "html-report", "index.html")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "blob-report", "report.zip")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(evidenceDirectory, "result.json"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      readFile(
        path.join(evidenceDirectory, "snapshots", "api-state.json"),
        "utf8",
      ),
    ).resolves.toBe("{}\n");
    expect(
      JSON.parse(
        await readFile(path.join(output, "normalized-results.json"), "utf8"),
      ).schema,
    ).toBe("paperclip.runner-e2e.campaign/v2");
    await expect(
      regenerateRunnerDashboard({
        bundle: root,
        outputDirectory: output,
        evidenceHrefPrefix: "../unsafe",
      }),
    ).rejects.toThrow("safe relative URL path");
  });

  it("requires a private-origin-compatible destination shape", () => {
    expect(
      validateHistoryDestination({
        bucket: "paperclip-runner-e2e-history",
        prefix: "/runner-e2e/",
        publicBaseUrl: "https://history.paperclip.ai/",
      }),
    ).toEqual({
      prefix: "runner-e2e",
      publicBaseUrl: "https://history.paperclip.ai",
    });
    expect(() =>
      validateHistoryDestination({
        bucket: "paperclip-runner-e2e-history",
        prefix: "../unsafe",
        publicBaseUrl: "https://history.paperclip.ai/",
      }),
    ).toThrow("safe non-empty key prefix");
    expect(() =>
      validateHistoryDestination({
        bucket: "paperclip-runner-e2e-history",
        prefix: "runner-e2e",
        publicBaseUrl: "http://history.paperclip.ai/",
      }),
    ).toThrow("credential-free HTTPS");
  });

  it("rejects non-allowlisted files and fingerprints an immutable bundle", async () => {
    expect(isHistoricalBundlePathAllowed("normalized-results.json")).toBe(true);
    expect(isHistoricalBundlePathAllowed("junit.xml")).toBe(true);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/final-state.png",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/failure.webm",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/unsafe.svg",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/junit.xml",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/blob-report/report.zip",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/html-report/index.html",
      ),
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/result.json",
      ),
    ).toBe(true);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/snapshots/api-state.json",
      ),
    ).toBe(true);
    expect(isHistoricalBundlePathAllowed("paperclip-home/database")).toBe(
      false,
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "runner-history-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "safe");
    await writeFile(path.join(root, "assets", "favicon.svg"), "safe");
    const first = await createBundleManifest(root, "campaign-1");
    const second = await createBundleManifest(root, "campaign-1");
    expect(first.bundleDigest).toBe(second.bundleDigest);
    await writeFile(path.join(root, "database.sqlite"), "unsafe");
    await expect(createBundleManifest(root, "campaign-1")).rejects.toThrow(
      "non-allowlisted",
    );
  });
});
