import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  publicScreenshotPaths,
  stageTrustedHistoryAssets,
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
import { renderPublicCampaignSummary } from "./public-summary-image.js";
import { isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";
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
  it("does not let empty legacy provenance hide a later measured source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-legacy-source-"));
    temporaryDirectories.push(root);
    const source = {
      sha: "measured-source-sha", ref: "refs/heads/measured-source",
      workflowRunUrl: "https://example.test/actions/runs/1",
    };
    const results = [
      { ...result(runnerMatrix[0]!, "passed"), schema: "paperclip.runner-e2e.result/v1" },
      { ...result(runnerMatrix[1]!, "passed"), source },
    ];
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify({
      campaignId: "legacy-source", generatedAt: results[0]!.finishedAt,
      expected: results.map((entry) => entry.executionId), results,
    }));
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_SHA", "renderer-sha");
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    await regenerateRunnerDashboard({ bundle: root });
    const regenerated = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(regenerated.source).toEqual({ ...source, eventName: null });
    expect(regenerated.results[0].source).toEqual({ sha: null, ref: null, workflowRunUrl: null });
    expect(regenerated.passed).toBe(2);
  });

  it.each(["workflow_dispatch", null, undefined])("preserves retained source during regeneration (event %s)", async (eventName) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-retained-source-"));
    temporaryDirectories.push(root);
    const execution = runnerMatrix[0]!;
    const source = {
      sha: "measured-source-sha", ref: "refs/heads/measured-source",
      workflowRunUrl: "https://example.test/actions/runs/1",
    };
    const retainedResult = { ...result(execution, "passed"), source };
    const campaign = buildRunnerCampaign({
      campaignId: "retained-source", generatedAt: retainedResult.finishedAt,
      expected: [execution.id], results: [retainedResult],
    });
    const published = { ...campaign, source: eventName === undefined ? undefined : { ...source, eventName } };
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(published));
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_SHA", "renderer-sha");
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_SOURCE_REF", "refs/heads/renderer");
    vi.stubEnv("GITHUB_EVENT_NAME", "push");
    await regenerateRunnerDashboard({ bundle: root });
    const regenerated = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(regenerated.source).toEqual({ ...source, eventName: eventName ?? null });
    expect(regenerated.results).toEqual(campaign.results.map((entry) => ({ ...entry, evidenceValid: true, evidenceErrors: [] })));
    expect(regenerated.generatedAt).toBe(campaign.generatedAt);
  });

  it("retains incomplete journeys in campaign, suite and history without marking them green", () => {
    const execution = runnerMatrix.find(e => e.suite.id === "first-task")!;
    const incomplete: RunnerE2EResult = {
      ...result(execution, "failed"), failureClass: "candidate_failure",
      firstTask: {
        caseId: execution.task.id, nonce: "fixture", onboardingIssueId: "issue", agentId: "agent",
        initialTaskIds: ["issue"], instructions: [], configuredModel: null, observedModels: [], checkpoints: [],
        checks: [{ id: "acceptance-recorded", passed: false, detail: "Acceptance", evidence: [], notReached: "Recording stopped" }],
      },
    };
    const campaign = buildRunnerCampaign({ campaignId: "incomplete", generatedAt: incomplete.finishedAt, expected: [execution.id], results: [incomplete] });
    expect(campaign).toMatchObject({ passed: 0, failed: 0, incomplete: 1 });
    expect(campaign.suites[0]).toMatchObject({ passed: 0, failed: 0, incomplete: 1 });
    const record = campaignHistoryRecord(campaign, "https://example.test");
    expect(record.executions[0].status).toBe("incomplete");
    const history = mergeRunnerHistory(null, { ...record, complete: true, suites: record.suites.map(s => ({ ...s, complete: true })) });
    expect(history.latestGreenCampaignId).toBeNull();
    expect(history.latestGreenBySuite["first-task"]).toBeUndefined();
    expect(renderRunnerHistoryIndex(history)).toContain("1 incomplete");
    expect(renderRunnerE2EDashboard({ title: "History", generatedAt: incomplete.finishedAt, expected: [], catalog: [], entries: [], history })).toContain('data-history-status="incomplete"');
  });

  it("shows unknown campaign costs without plotting zero dollars", () => {
    const execution = runnerMatrix[0];
    const campaign = buildRunnerCampaign({ campaignId: "unknown-cost", generatedAt: "2026-09-15T00:00:00Z", expected: [execution.id], results: [result(execution, "passed")] });
    campaign.billing.observedAndEstimatedCostUsd = null;
    const record = { ...campaignHistoryRecord(campaign, "https://example.test"), complete: true };
    const history = mergeRunnerHistory(null, record);
    expect(renderRunnerHistoryIndex(history)).toContain("Unknown");
    const dashboard = renderRunnerE2EDashboard({ title: "History", generatedAt: campaign.generatedAt, expected: [], catalog: [], entries: [], history });
    expect(dashboard).toContain("Unknown measurements are not plotted");
    expect(dashboard).not.toContain("NaN");
  });

  it("does not turn a clean-evidence behavior failure into a pass when regenerating", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-failed-evidence-"));
    temporaryDirectories.push(root);
    const execution = runnerMatrix[0];
    const failedResult = { ...result(execution, "failed"), failureClass: "candidate_failure" as const, error: "Behavior check failed", evidenceValid: true, evidenceErrors: [] };
    const campaign = buildRunnerCampaign({ campaignId: "failed", generatedAt: failedResult.finishedAt, expected: [execution.id], results: [failedResult] });
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify({ ...campaign, results: [failedResult] }));
    await regenerateRunnerDashboard({ bundle: root });
    const page = await readFile(path.join(root, "index.html"), "utf8");
    expect(page).toContain('class="case case-failed"');
    expect(page).not.toContain('class="case case-passed"');
  });

  it("records the resolved paid target instead of the trusted workflow checkout", () => {
    vi.stubEnv("GITHUB_SERVER_URL", "");
    vi.stubEnv("GITHUB_REPOSITORY", "");
    vi.stubEnv("GITHUB_RUN_ID", "");
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
    const index = renderRunnerHistoryIndex(history, {
      latestSummaryImageHref:
        "campaigns/complete-red/public-images/campaign-summary.png",
    });
    expect(index).toContain("Runner E2E campaigns");
    expect(index).toContain("complete-green");
    expect(index).toContain("complete-red");
    expect(index).toContain(`${runnerMatrix.length}/${runnerMatrix.length} passed`);
    expect(index).toContain(`${runnerMatrix.length - 1}/${runnerMatrix.length} passed`);
    expect(index).toContain("Open report&nbsp;→");
    expect(index).toContain(
      "campaigns/complete-red/public-images/campaign-summary.png",
    );
    expect(index).toContain(
      "declared screenshots, and normalized results",
    );
    expect(index).toContain(
      "Declared screenshots and normalized results",
    );
    expect(index).not.toContain("data-gallery-dialog");
    expect(index).not.toContain("Configuration matrix");
  });
});

describe("historical publication security", () => {
  it.each([
    "snapshots/api-state.json", "server.log", "playwright.log", "result.json",
    "renamed-diagnostic.md", "nested/provider.txt", "malformed.json",
  ])("withholds raw diagnostic %s even after credential redaction", async (file) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-private-evidence-"));
    temporaryDirectories.push(root);
    const relative = `evidence/fixture.local.case/attempt-1/${file}`;
    const absolute = path.join(root, relative);
    const text = file === "malformed.json" ? "{malformed PRIVATE_REASONING" : JSON.stringify({
      apiKey: "[REDACTED]",
      runEvents: [{ payload: { prpEvent: { payload: {
        kind: "reasoning", text: "PRIVATE_REASONING", sessionId: "PRIVATE_SESSION",
      } } } }],
      runLogs: [{ log: { content: JSON.stringify({ reasoning: "PRIVATE_REASONING" }) } }],
    });
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
    expect(isHistoricalBundlePathAllowed(relative)).toBe(false);
    // A text file cannot be admitted by pretending it is a declared screenshot.
    expect(isHistoricalBundlePathAllowed(relative, false, new Set([relative]))).toBe(false);
    await expect(createBundleManifest(root, "private-diagnostics")).rejects.toThrow("non-allowlisted");
    await prunePrivateHistoryEvidence(root);
    await expect(readFile(absolute)).rejects.toThrow();
    expect((await createBundleManifest(root, "private-diagnostics")).files).toEqual([]);
  });

  it("allows public capture only on an issue task route", () => {
    const target = {
      issuePrefix: "PAP",
      issueId: "issue-id",
      issueIdentifier: "PAP-123",
    };
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3100/PAP/issues/PAP-123",
        target,
      ),
    ).toBe(true);
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3100/PAP/issues/PAP-999",
        target,
      ),
    ).toBe(false);
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3100/PAP/settings",
        target,
      ),
    ).toBe(false);
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3100/setup/secrets",
        target,
      ),
    ).toBe(false);
    expect(
      isPublicRunnerScreenshotRoute(
        "https://example.test/PAP/issues/PAP-123",
        target,
      ),
    ).toBe(false);
    expect(isPublicRunnerScreenshotRoute("not a URL", target)).toBe(false);
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3100/PAP/issues/PAP-123",
        { ...target, issueId: null },
      ),
    ).toBe(false);
  });

  it("publishes declared screenshots while keeping active evidence private", async () => {
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
          publication: "public-runner-fixture",
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
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(evidenceDirectory, "final-state.png"), png);
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

    const publicScreenshots = publicScreenshotPaths(campaign);
    await prunePrivateHistoryEvidence(root, publicScreenshots);
    await regenerateRunnerDashboard({
      bundle: root,
      outputDirectory: output,
      evidenceHrefPrefix: "campaigns/campaign-1",
    });
    const dashboard = await readFile(path.join(output, "index.html"), "utf8");
    expect(dashboard).toContain(
      `campaigns/campaign-1/evidence/${execution.id}/attempt-1/final-state.png`,
    );
    expect(dashboard).toContain("View gallery · 1");
    expect(dashboard).toContain(
      "Declared PNG screenshots and normalized results are retained with every published campaign",
    );
    expect(dashboard).toContain(
      "Declared screenshots and normalized results published",
    );
    await expect(
      readFile(path.join(evidenceDirectory, "final-state.png")),
    ).resolves.toEqual(png);
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
    ).rejects.toThrow();
    await expect(
      readFile(
        path.join(evidenceDirectory, "snapshots", "api-state.json"),
        "utf8",
      ),
    ).rejects.toThrow();
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

  it("admits declared PNG screenshots and the trusted summary only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-s3-test-"));
    temporaryDirectories.push(root);
    const execution = runnerMatrix[0]!;
    const campaign = buildRunnerCampaign({
      campaignId: "campaign-summary",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [
        {
          ...result(execution, "passed"),
          error: "PROVIDER_TEXT_MUST_NOT_RENDER",
          screenshots: [
            {
              id: "final-state",
              label: "PROVIDER_LABEL_MUST_NOT_RENDER",
              file: "final-state.png",
              publication: "public-runner-fixture",
            },
          ],
        },
      ],
    });
    const evidenceDirectory = path.join(
      root,
      "evidence",
      execution.id,
      "attempt-1",
    );
    await mkdir(evidenceDirectory, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    await Promise.all([
      writeFile(
        path.join(root, "normalized-results.json"),
        JSON.stringify(campaign),
      ),
      writeFile(path.join(evidenceDirectory, "final-state.png"), png),
      writeFile(path.join(evidenceDirectory, "undeclared.png"), png),
      writeFile(path.join(evidenceDirectory, "server.log"), "sanitized\n"),
      writeFile(path.join(evidenceDirectory, "failure.webm"), "webm"),
      writeFile(path.join(evidenceDirectory, "unsafe.svg"), "<svg />"),
      writeFile(path.join(evidenceDirectory, "result.json"), "{}\n"),
    ]);

    const publicScreenshots = publicScreenshotPaths(campaign);
    await prunePrivateHistoryEvidence(root, publicScreenshots);
    await expect(
      readFile(path.join(evidenceDirectory, "final-state.png")),
    ).resolves.toEqual(png);
    for (const removed of ["undeclared.png", "failure.webm", "unsafe.svg"]) {
      await expect(
        readFile(path.join(evidenceDirectory, removed)),
      ).rejects.toThrow();
    }
    await expect(
      readFile(path.join(evidenceDirectory, "server.log"), "utf8"),
    ).rejects.toThrow();
    const summaryHtml = renderPublicCampaignSummary(campaign);
    expect(summaryHtml).toContain(execution.suite.label);
    expect(summaryHtml).not.toContain("PROVIDER_TEXT_MUST_NOT_RENDER");
    expect(summaryHtml).not.toContain("PROVIDER_LABEL_MUST_NOT_RENDER");
    const incompleteSummaryHtml = renderPublicCampaignSummary({
      ...campaign,
      expected: [execution.id, runnerMatrix[1]!.id],
      results: [
        {
          ...campaign.results[0]!,
          cleanup: "failed",
          durationMs: Number.MAX_VALUE,
        },
        result(runnerMatrix[2]!, "passed"),
      ],
    });
    expect(incompleteSummaryHtml).toContain("0/2");
    expect(incompleteSummaryHtml).toContain(">2<");
    expect(incompleteSummaryHtml).toContain("24h 0m");
    expect(incompleteSummaryHtml).not.toContain(String(Number.MAX_VALUE));

    const summaryPath = path.join(
      root,
      "public-images",
      "campaign-summary.png",
    );
    await mkdir(path.dirname(summaryPath), { recursive: true });
    await writeFile(summaryPath, png);
    expect(
      isHistoricalBundlePathAllowed("public-images/campaign-summary.png", true),
    ).toBe(true);
    expect(
      isHistoricalBundlePathAllowed(
        `evidence/${execution.id}/attempt-1/final-state.png`,
        false,
        publicScreenshots,
      ),
    ).toBe(true);
    await regenerateRunnerDashboard({
      bundle: root,
      publicSummaryImageHref: "public-images/campaign-summary.png",
    });
    expect(await readFile(path.join(root, "index.html"), "utf8")).toContain(
      'src="public-images/campaign-summary.png"',
    );
    const manifest = await createBundleManifest(
      root,
      campaign.campaignId,
      true,
      publicScreenshots,
    );
    expect(manifest.files.map((file) => file.path)).toContain(
      "public-images/campaign-summary.png",
    );
    expect(manifest.files.map((file) => file.path)).toContain(
      `evidence/${execution.id}/attempt-1/final-state.png`,
    );
    await writeFile(summaryPath, "not a png");
    await expect(
      createBundleManifest(root, campaign.campaignId, true, publicScreenshots),
    ).rejects.toThrow("does not match its raster file type");
  });

  it("refuses a public bundle when any declared screenshot is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-missing-screenshot-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "evidence", "agent-chat.runner-codex.local.plan-handoff", "attempt-1");
    await mkdir(directory, { recursive: true });
    const base = "evidence/agent-chat.runner-codex.local.plan-handoff/attempt-1";
    const declared = new Set([`${base}/final-state.png`, `${base}/chat-plan-draft.png`]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    await writeFile(path.join(directory, "final-state.png"), png);
    await expect(createBundleManifest(root, "campaign-1", false, declared))
      .rejects.toThrow(`Declared public screenshots are missing from the historical bundle: ${base}/chat-plan-draft.png`);
    await writeFile(path.join(directory, "chat-plan-draft.png"), png);
    const manifest = await createBundleManifest(root, "campaign-1", false, declared);
    expect(new Set(manifest.files.map((file) => file.path))).toEqual(declared);
  });

  it("requires trusted-fixture opt-in and rejects unsafe screenshot paths", () => {
    const execution = runnerMatrix[0]!;
    expect(() => buildRunnerCampaign({
      campaignId: "unsafe-screenshot",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [
        {
          ...result(execution, "passed"),
          screenshots: [
            {
              id: "unsafe",
              label: "Unsafe",
              file: "../secret.png",
              publication: "public-runner-fixture",
            },
          ],
        },
      ],
    })).toThrow("Invalid retained runner result field: result.screenshots[0].file");

    const failedCampaign = buildRunnerCampaign({
      campaignId: "failed-screenshot",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [
        {
          ...result(execution, "failed"),
          screenshots: [
            {
              id: "failure",
              label: "Task state at failure",
              file: "failure.png",
              publication: "public-runner-fixture",
            },
            {
              id: "private-diagnostic",
              label: "Private diagnostic",
              file: "private-diagnostic.png",
            },
          ],
        },
      ],
    });
    expect([...publicScreenshotPaths(failedCampaign)]).toEqual([
      `evidence/${execution.id}/attempt-1/failure.png`,
    ]);

    const missingArtifactCampaign = buildRunnerCampaign({
      campaignId: "missing-artifact",
      generatedAt: "2026-08-28T00:01:00.000Z",
      expected: [execution.id],
      results: [
        {
          ...result(execution, "failed"),
          attempt: 0,
          error: "Missing matrix artifact",
          screenshots: [],
        },
      ],
    });
    expect([...publicScreenshotPaths(missingArtifactCampaign)]).toEqual([]);
  });

  it("replaces target-supplied public assets with trusted publisher assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-assets-test-"));
    const trustedRoot = await mkdtemp(
      path.join(os.tmpdir(), "runner-trusted-assets-test-"),
    );
    temporaryDirectories.push(root, trustedRoot);
    await Promise.all([
      mkdir(path.join(root, "assets"), { recursive: true }),
      mkdir(path.join(trustedRoot, "ui/public/fonts"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "assets", "favicon-32x32.png"), "target"),
      writeFile(path.join(root, "assets", "InterVariable.woff2"), "target"),
      writeFile(path.join(root, "assets", "unexpected.svg"), "target"),
      writeFile(
        path.join(trustedRoot, "ui/public/favicon-32x32.png"),
        "trusted-png",
      ),
      writeFile(
        path.join(trustedRoot, "ui/public/fonts/InterVariable.woff2"),
        "trusted-font",
      ),
    ]);

    await stageTrustedHistoryAssets(root, trustedRoot);

    await expect(
      readFile(path.join(root, "assets", "favicon-32x32.png"), "utf8"),
    ).resolves.toBe("trusted-png");
    await expect(
      readFile(path.join(root, "assets", "InterVariable.woff2"), "utf8"),
    ).resolves.toBe("trusted-font");
    await expect(
      readFile(path.join(root, "assets", "unexpected.svg"), "utf8"),
    ).rejects.toThrow();

    const outside = path.join(trustedRoot, "outside-secret");
    const trustedFavicon = path.join(
      trustedRoot,
      "ui/public/favicon-32x32.png",
    );
    await Promise.all([writeFile(outside, "secret"), rm(trustedFavicon)]);
    await symlink(outside, trustedFavicon);
    await expect(stageTrustedHistoryAssets(root, trustedRoot)).rejects.toThrow(
      "Refusing symbolic link in trusted publisher asset path",
    );
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
        prefix: "runner-e2e?other",
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
    ).toBe(false);
    expect(
      isHistoricalBundlePathAllowed(
        "evidence/core-compatibility.profile.local.case/attempt-1/snapshots/api-state.json",
      ),
    ).toBe(false);
    expect(isHistoricalBundlePathAllowed("paperclip-home/database")).toBe(
      false,
    );

    const root = await mkdtemp(path.join(os.tmpdir(), "runner-history-test-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "index.html"), "safe");
    await writeFile(path.join(root, "assets", "favicon-32x32.png"), "safe");
    const first = await createBundleManifest(root, "campaign-1");
    const second = await createBundleManifest(root, "campaign-1");
    expect(first.bundleDigest).toBe(second.bundleDigest);
    await writeFile(path.join(root, "database.sqlite"), "unsafe");
    await expect(createBundleManifest(root, "campaign-1")).rejects.toThrow(
      "non-allowlisted",
    );
  });
});
