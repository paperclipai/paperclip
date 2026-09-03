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
      runIds: ["run-2"],
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
    expect(dashboard).toContain("data-gallery-previous");
    expect(dashboard).toContain("data-gallery-next");
    expect(dashboard).toContain("View gallery · 1");
    expect(dashboard).toContain(
      "Visual evidence is retained in the access-controlled workflow artifact",
    );
    expect(dashboard).toContain("Public history excludes visual evidence");
    expect(dashboard).toContain("message_contains");
    expect(dashboard).toContain("Matchers and test context");
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
    expect(dashboard).toContain('aria-label="Previous"');
    expect(dashboard).toContain('aria-label="Next"');
    expect(dashboard).not.toContain("overflow: auto; max-height: calc(100vh");
    expect(dashboard).toContain("@media (max-width: 1180px)");
    expect(
      await readFile(path.join(output, "assets", "favicon.svg"), "utf8"),
    ).toContain("<svg");
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
