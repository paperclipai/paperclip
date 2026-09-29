import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunnerE2EResult } from "./types.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const cleanupDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("runner E2E report aggregation", () => {
  it.each([
    { name: "missing", usage: null, runIds: ["run-1"], tokens: "Unavailable", cost: "Unavailable", htmlTokens: "Unavailable" },
    { name: "partial", usage: { runs: [{ usage: { inputTokens: 1250, outputTokens: 75, cachedInputTokens: 500, costUsd: 0.0125 } }, { usage: null }] }, runIds: ["run-1", "run-2"], tokens: "1250 input / 75 output / 500 cached (partial: 1/2 runs)", cost: "$0.012500 (partial: 1/2 runs)", htmlTokens: "1,250 (partial: 1/2 runs)" },
    { name: "reported", usage: { inputTokens: 1250, outputTokens: 75, cachedInputTokens: 500, costUsd: 0.0125 }, runIds: ["run-1"], tokens: "1250 input / 75 output / 500 cached", cost: "$0.012500", htmlTokens: "1,250" },
    { name: "reported zero cost", usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 }, runIds: ["run-1"], tokens: "1 input / 0 output / 0 cached", cost: "$0.000000", htmlTokens: "1" },
  ])("renders $name usage with its actual coverage", async ({ usage, runIds, tokens, cost, htmlTokens }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-billing-report-"));
    cleanupDirectories.push(root);
    const executionId = "core-compatibility.runner-codex.local.message-marker";
    const directory = path.join(root, "attempt-1");
    await mkdir(directory);
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility",
      attempt: 1, status: "passed", profileId: "runner-codex", environmentId: "local",
      caseId: "message-marker", provider: "codex", model: "fixture-model", runtimeMode: "native",
      startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T00:00:01Z", durationMs: 1000,
      cleanup: "passed", runIds, usage,
    };
    const raw = JSON.stringify(result);
    await writeFile(path.join(directory, "result.json"), raw);
    await writeFile(path.join(directory, "final-state.png"), "fake-png");
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const output = path.join(root, "merged");
    await execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot,
      env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]) },
    });
    const markdown = await readFile(path.join(output, "summary.md"), "utf8");
    expect(markdown.split("\n").find((line) => line.startsWith("Tokens: "))).toBe(`Tokens: ${tokens}`);
    expect(markdown.split("\n").find((line) => line.startsWith("Provider-reported LLM cost: "))).toBe(`Provider-reported LLM cost: ${cost}`);
    const dashboard = await readFile(path.join(output, "index.html"), "utf8");
    expect(dashboard).toContain(`<strong>${htmlTokens}</strong><span>Input tokens</span>`);
    if (usage === null) {
      expect(markdown).not.toContain("0/0 | $0.000000");
      expect(dashboard).toContain("<strong>Unavailable</strong><span>LLM reported subtotal</span>");
      expect(dashboard).toContain("<span>Known spend</span><strong>Unavailable</strong>");
    }
    expect(await readFile(path.join(directory, "result.json"), "utf8")).toBe(raw);
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized.passed).toBe(1);
    expect(normalized.results[0].usage).toEqual(usage);
  });

  it("keeps interrupted journeys incomplete unless their evidence is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-incomplete-report-"));
    cleanupDirectories.push(root);
    const ids: string[] = [];
    for (const [caseId, validEvidence] of [["task-card-accept", true], ["task-reply-accept", false]] as const) {
      const executionId = `first-task.runner-codex.local.${caseId}`;
      ids.push(executionId);
      const directory = path.join(root, caseId);
      await mkdir(directory);
      await writeFile(path.join(directory, "result.json"), JSON.stringify({
        schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "first-task",
        attempt: 1, status: "failed", failureClass: "candidate_failure", error: "Recording stopped before acceptance",
        profileId: "runner-codex", environmentId: "local", caseId, provider: "codex", model: "fixture-model", runtimeMode: "native",
        startedAt: "2026-09-15T00:00:00Z", finishedAt: "2026-09-15T00:01:00Z", durationMs: 60_000, cleanup: "passed",
        firstTask: { caseId, nonce: "fixture", onboardingIssueId: "task", agentId: "agent", initialTaskIds: ["task"], instructions: [], configuredModel: null, observedModels: [], checkpoints: [],
          checks: [{ id: "acceptance-recorded", passed: false, notReached: "No acceptance checkpoint", detail: "Acceptance recorded", evidence: [] }] },
      } satisfies RunnerE2EResult));
      if (validEvidence) await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: [], leaks: [], missing: [] }));
    }
    const output = path.join(root, "merged");
    await expect(execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify(ids) },
    })).rejects.toBeDefined();
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized).toMatchObject({ passed: 0, failed: 1, incomplete: 1 });
    expect(normalized.results[0]).toMatchObject({ evidenceValid: true, evidenceErrors: [] });
    expect(normalized.results[1]).toMatchObject({ evidenceValid: false, failureClass: "permanent_infrastructure" });
    const page = await readFile(path.join(output, "index.html"), "utf8");
    expect(page).toContain("Incomplete journey");
    expect(page).toContain("evidence manifest missing");
  });

  it("selects the latest retry and enforces cleanup and pass evidence", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-report-test-"),
    );
    cleanupDirectories.push(root);
    const executionId = "legacy-codex.local.message-marker";
    const base: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v1",
      executionId,
      attempt: 2,
      status: "passed",
      profileId: "legacy-codex",
      environmentId: "local",
      caseId: "message-marker",
      provider: "codex",
      model: "fixture-model",
      runtimeMode: "legacy",
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:00:01.000Z",
      durationMs: 1_000,
      source: {
        sha: "forged-result-sha",
        ref: "refs/heads/forged-result",
        workflowRunUrl: "https://example.test/actions/runs/forged",
      },
      runIds: ["run-2"],
      turnTimings: [
        {
          turn: 1,
          submittedAt: "2026-08-26T00:00:00.000Z",
          runStartedAt: "2026-08-26T00:00:00.100Z",
          runFinishedAt: "2026-08-26T00:00:01.000Z",
          schedulerLatencyMs: 100,
          runDurationMs: 900,
          responseLatencyMs: 1_000,
          runId: "run-2",
          leaseAcquisitionOutcome: "created",
        },
      ],
      usage: {
        inputTokens: 1_250,
        outputTokens: 75,
        cachedInputTokens: 500,
        costUsd: 0.0125,
      },
      cleanup: "passed",
    };
    for (const attempt of [1, 2]) {
      const directory = path.join(root, `attempt-${attempt}`);
      await mkdir(directory, { recursive: true });
      const result =
        attempt === 1
          ? {
              ...base,
              attempt,
              status: "failed" as const,
              failureClass: "transient_infrastructure" as const,
            }
          : {
              ...base,
              matcherResults: [
                {
                  matcher: {
                    kind: "message_contains" as const,
                    expected: "PAPERCLIP_E2E_OK",
                  },
                  passed: true,
                  detail: "matched",
                },
              ],
              screenshots: [
                {
                  id: "final-state",
                  label: "Final visible task state",
                  file: "final-state.png",
                },
              ],
            };
      await writeFile(
        path.join(directory, "result.json"),
        JSON.stringify(result),
      );
      if (attempt === 2) {
        await writeFile(path.join(directory, "final-state.png"), "fake-png");
      }
      await writeFile(
        path.join(directory, "evidence-manifest.json"),
        JSON.stringify({
          files: attempt === 2 ? ["final-state.png"] : [],
          leaks: [],
          missing: [],
        }),
      );
    }
    const staleDuplicate = path.join(root, "attempt-2-stale-duplicate");
    await mkdir(staleDuplicate, { recursive: true });
    await writeFile(
      path.join(staleDuplicate, "result.json"),
      JSON.stringify({
        ...base,
        status: "failed",
        failureClass: "candidate_failure",
        finishedAt: "2026-08-26T00:00:00.500Z",
      }),
    );
    await writeFile(
      path.join(staleDuplicate, "evidence-manifest.json"),
      JSON.stringify({ files: [], leaks: [], missing: [] }),
    );
    const output = path.join(root, "merged");
    await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        path.join(repositoryRoot, "tests/runner-e2e/report.ts"),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
          PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
          PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]),
          PAPERCLIP_RUNNER_E2E_SOURCE_SHA:
            "0123456789abcdef0123456789abcdef01234567",
          PAPERCLIP_RUNNER_E2E_SOURCE_REF:
            "refs/heads/fix/runner-paid-source-attribution",
          GITHUB_SHA: "trusted-default-workflow-sha",
          GITHUB_REF: "refs/heads/master",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "paperclipai/paperclip",
          GITHUB_RUN_ID: "123456",
          PAPERCLIP_RUNNER_E2E_HISTORY_PUBLIC_BASE_URL:
            "https://reports.example.test/",
          PAPERCLIP_RUNNER_E2E_HISTORY_PREFIX: "/runner-e2e/",
        },
      },
    );
    const normalized = JSON.parse(
      await readFile(path.join(output, "normalized-results.json"), "utf8"),
    );
    expect(normalized).toMatchObject({
      schema: "paperclip.runner-e2e.campaign/v2",
      selected: 1,
      executed: 1,
      passed: 1,
      failed: 0,
      retries: 1,
      cleanupPassed: true,
      source: {
        sha: "0123456789abcdef0123456789abcdef01234567",
        ref: "refs/heads/fix/runner-paid-source-attribution",
        workflowRunUrl:
          "https://github.com/paperclipai/paperclip/actions/runs/123456",
      },
    });
    expect(normalized.billing).toMatchObject({
      reportedLlmCostUsd: 0.0125,
      llm: {
        inputTokens: 1_250,
        outputTokens: 75,
        runsWithReportedCost: 1,
      },
    });
    expect(normalized.results[0]).toMatchObject({
      attempt: 2,
      evidenceValid: true,
      source: {
        sha: "0123456789abcdef0123456789abcdef01234567",
        ref: "refs/heads/fix/runner-paid-source-attribution",
        workflowRunUrl:
          "https://github.com/paperclipai/paperclip/actions/runs/123456",
      },
    });
    const dashboard = await readFile(
      path.join(output, "dashboard.html"),
      "utf8",
    );
    expect(dashboard).toContain("Runner Full-Stack E2E");
    expect(dashboard).toContain(executionId);
    expect(dashboard).toContain("case-passed");
    expect(dashboard).toContain(
      "core-compatibility.runner-acpx-codex.daytona.message-marker",
    );
    expect(dashboard).toContain("case-not-selected");
    expect(dashboard).toContain("<img");
    expect(dashboard).toContain('class="brand-lockup"');
    expect(dashboard).toContain("data-gallery-dialog");
    expect(dashboard).toContain(
      `id="execution-core-compatibility.${executionId}"`,
    );
    expect(dashboard).toContain("data-gallery-previous");
    expect(dashboard).toContain("data-gallery-next");
    expect(dashboard).toContain("View gallery · 1");
    expect(dashboard).toContain(
      "Declared PNG screenshots and normalized results are retained with every published campaign",
    );
    expect(dashboard).toContain(
      "Declared screenshots and normalized results published",
    );
    expect(dashboard).toContain("message_contains");
    expect(dashboard).toContain("Matchers and test context");
    expect(dashboard).toContain("Scheduler");
    expect(dashboard).toContain("Run duration");
    expect(dashboard).toContain("100ms");
    expect(dashboard).toContain("Campaign billing summary");
    expect(dashboard).toContain("LLM reported subtotal");
    expect(dashboard).toContain("Agent execution time");
    expect(dashboard).toContain("Daytona lease time");
    expect(dashboard).toContain("1,250 in · 75 out");
    expect(dashboard).toContain("$0.0125");
    expect(dashboard).toContain("unpriced or unavailable runs are excluded");
    expect(dashboard).toContain('class="profile-sticky"');
    expect(dashboard).toContain('class="mobile-environment-header"');
    expect(dashboard).toContain("data-gallery-profile=");
    expect(dashboard).toContain("data-gallery-environment=");
    expect(dashboard).toContain("data-gallery-duration=");
    expect(dashboard).toContain("data-gallery-tokens=");
    expect(dashboard).toContain("data-gallery-matchers=");
    expect(dashboard).toContain("data-report-query");
    expect(dashboard).toContain("data-report-profile");
    expect(dashboard).toContain("data-report-environment");
    expect(dashboard).toContain("data-report-status");
    expect(dashboard.indexOf('class="report-filters"')).toBeGreaterThan(
      dashboard.indexOf('class="suite-nav"'),
    );
    expect(dashboard).not.toContain(".report-filters { position: sticky");
    expect(dashboard).toContain("table-layout: fixed");
    expect(dashboard).toContain('class="profile-column"');
    expect(dashboard).toContain('aria-label="Previous"');
    expect(dashboard).toContain('aria-label="Next"');
    expect(dashboard).not.toContain("overflow: auto; max-height: calc(100vh");
    expect(dashboard).toContain("@media (max-width: 1180px)");
    expect(
      await readFile(path.join(output, "assets", "favicon-32x32.png")),
    ).not.toHaveLength(0);
    expect(
      await readFile(path.join(output, "assets", "InterVariable.woff2")),
    ).not.toHaveLength(0);
    expect(
      await readFile(
        path.join(
          output,
          "evidence",
          `core-compatibility.${executionId}`,
          "attempt-2",
          "final-state.png",
        ),
        "utf8",
      ),
    ).toBe("fake-png");
    expect(await readFile(path.join(output, "index.html"), "utf8")).toBe(
      dashboard,
    );
    const summary = await readFile(path.join(output, "summary.md"), "utf8");
    expect(summary).toContain("## View results");
    expect(summary).toContain(
      "[Open the exact interactive campaign report](https://reports.example.test/runner-e2e/campaigns/gha-123456-1/index.html)",
    );
    expect(summary).toContain(
      "[Open the workflow run and per-cell job logs](https://github.com/paperclipai/paperclip/actions/runs/123456)",
    );
    expect(summary).toContain(
      "[Download the merged report and per-cell evidence](https://github.com/paperclipai/paperclip/actions/runs/123456#artifacts)",
    );
    expect(summary).toContain(
      `[core-compatibility.${executionId}](https://reports.example.test/runner-e2e/campaigns/gha-123456-1/index.html#execution-core-compatibility.${executionId})`,
    );
  });

  it("prefers a valid rerun over a higher attempt number from an older campaign", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-report-rerun-test-"),
    );
    cleanupDirectories.push(root);
    const executionId = "runner-opencode.local.ask-question";
    const common: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v1",
      executionId,
      attempt: 2,
      status: "failed",
      failureClass: "candidate_failure",
      profileId: "runner-opencode",
      environmentId: "local",
      caseId: "ask-question",
      provider: "opencode",
      model: "fixture-model",
      runtimeMode: "native",
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:00:01.000Z",
      durationMs: 1_000,
      cleanup: "not_started",
    };
    const failedDirectory = path.join(root, "old-campaign", "attempt-2");
    const passedDirectory = path.join(root, "new-campaign", "attempt-1");
    await mkdir(failedDirectory, { recursive: true });
    await mkdir(passedDirectory, { recursive: true });
    await writeFile(
      path.join(failedDirectory, "result.json"),
      JSON.stringify(common),
    );
    await writeFile(
      path.join(failedDirectory, "evidence-manifest.json"),
      JSON.stringify({ files: [], leaks: [], missing: [] }),
    );
    await writeFile(
      path.join(passedDirectory, "result.json"),
      JSON.stringify({
        ...common,
        attempt: 1,
        status: "passed",
        failureClass: undefined,
        finishedAt: "2026-08-26T00:00:02.000Z",
        cleanup: "passed",
      }),
    );
    await writeFile(
      path.join(passedDirectory, "evidence-manifest.json"),
      JSON.stringify({
        files: ["final-state.png"],
        leaks: [],
        missing: [],
      }),
    );
    await writeFile(path.join(passedDirectory, "final-state.png"), "fake-png");
    const output = path.join(root, "merged");
    await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        path.join(repositoryRoot, "tests/runner-e2e/report.ts"),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
          PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
          PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]),
        },
      },
    );
    const normalized = JSON.parse(
      await readFile(path.join(output, "normalized-results.json"), "utf8"),
    );
    expect(normalized).toMatchObject({ passed: 1, failed: 0 });
    expect(normalized.results[0]).toMatchObject({
      attempt: 1,
      status: "passed",
      evidenceValid: true,
    });
  });

  it("materializes declared screenshots from hashed Playwright attachments", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-report-screenshot-alias-")
    );
    cleanupDirectories.push(root);
    const executionId = "daytona-warm-continuity.legacy-codex.daytona.warm-three-turn";
    const directory = path.join(root, "attempt-1");
    const attachment =
      "playwright-output/warm-turn/attachments/warm-turn-1-deadbeef.png";
    await mkdir(path.join(directory, path.dirname(attachment)), {
      recursive: true,
    });
    await writeFile(path.join(directory, "final-state.png"), "final-png");
    await writeFile(path.join(directory, attachment), "warm-turn-png");
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify({
        schema: "paperclip.runner-e2e.result/v1",
        executionId,
        attempt: 1,
        status: "passed",
        profileId: "legacy-codex",
        environmentId: "daytona",
        caseId: "warm-three-turn",
        provider: "codex",
        model: "fixture-model",
        runtimeMode: "legacy",
        startedAt: "2026-08-26T00:00:00.000Z",
        finishedAt: "2026-08-26T00:00:01.000Z",
        durationMs: 1_000,
        cleanup: "passed",
        screenshots: [
          {
            id: "warm-turn-1",
            label: "Warm Daytona turn 1 awaiting review",
            file: "warm-turn-1.png",
          },
          {
            id: "final-state",
            label: "Final visible task state",
            file: "final-state.png",
          },
        ],
      } satisfies RunnerE2EResult),
    );
    await writeFile(
      path.join(directory, "evidence-manifest.json"),
      JSON.stringify({
        files: ["final-state.png", attachment],
        leaks: [],
        missing: [],
      }),
    );

    const output = path.join(root, "merged");
    await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"),
        path.join(repositoryRoot, "tests/runner-e2e/report.ts"),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
          PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
          PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]),
        },
      },
    );
    expect(
      await readFile(
        path.join(output, "evidence", executionId, "attempt-1", "warm-turn-1.png"),
        "utf8",
      ),
    ).toBe("warm-turn-png");
  });

  it("constructs the public root JUnit from fixed markup and escaped fields", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "runner-e2e-report-junit-test-"),
    );
    cleanupDirectories.push(root);
    const executionId = "legacy-codex.local.message-marker";
    const directory = path.join(root, "attempt-1");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify({
        schema: "paperclip.runner-e2e.result/v1",
        executionId,
        attempt: 1,
        status: "failed",
        failureClass: "candidate_failure",
        error: `provider said \"><script>alert(1)</script>&`,
        profileId: "legacy-codex",
        environmentId: "local",
        caseId: "message-marker",
        provider: "codex",
        model: "fixture-model",
        runtimeMode: "legacy",
        startedAt: "2026-08-26T00:00:00.000Z",
        finishedAt: "2026-08-26T00:00:01.000Z",
        durationMs: 1_000,
        cleanup: "passed",
      } satisfies RunnerE2EResult),
    );
    await writeFile(
      path.join(directory, "evidence-manifest.json"),
      JSON.stringify({ files: [], leaks: [], missing: [] }),
    );
    const output = path.join(root, "merged");

    await expect(
      execFileAsync(
        process.execPath,
        [
          path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"),
          path.join(repositoryRoot, "tests/runner-e2e/report.ts"),
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root,
            PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
            PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]),
          },
        },
      ),
    ).rejects.toBeDefined();

    const junit = await readFile(path.join(output, "junit.xml"), "utf8");
    expect(junit).toContain(
      `message="provider said &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;"`,
    );
    expect(junit).not.toContain("<script>");
    expect(junit).not.toContain("<?xml-stylesheet");
  });
});
