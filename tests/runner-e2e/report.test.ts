import { createWorkerTiming } from "./worker-timing.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STARTUP_REUSE_LAYERS, STARTUP_REUSE_SCHEMA, summarizeStartupReuse } from "../../packages/adapter-utils/src/startup-reuse.js";
import type { RunnerE2EResult } from "./types.js";
import { classifyLatency, observationTiming } from "./latency-timing.js";
import { projectTaskChatThread } from "./task-chat.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";

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
  it("retains task conversations through aggregation and public dashboard regeneration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-task-chat-report-"));
    cleanupDirectories.push(root);
    const directory = path.join(root, "attempt-1");
    await mkdir(directory);
    const executionId = "core-compatibility.runner-codex.local.message-marker";
    const at = "2026-10-28T12:00:00Z";
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility", attempt: 1,
      status: "passed", profileId: "runner-codex", environmentId: "local", caseId: "message-marker",
      provider: "codex", model: "fixture", runtimeMode: "native", startedAt: at, finishedAt: at,
      durationMs: 0, cleanup: "passed", taskChat: {
        schema: "paperclip.runner-e2e.task-chat/v1", capturedAt: at, status: "complete", missing: [],
        threads: [projectTaskChatThread({ id: "task", title: "Saved task conversation", description: "Original user request", createdAt: at },
          [{ id: "reply", authorAgentId: "agent", createdAt: at, body: "Entire persisted response <script>unsafe()</script>" }], [], new Map([["agent", "Morgan"]]))],
      },
    };
    await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
    await writeFile(path.join(directory, "final-state.png"), "fixture-png");
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const output = path.join(root, "merged");
    await execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
        PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]) },
    });
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized.results[0].taskChat).toEqual(result.taskChat);
    const regenerated = path.join(root, "regenerated");
    await regenerateRunnerDashboard({ bundle: output, outputDirectory: regenerated, historyFile: null });
    for (const folder of [output, regenerated]) {
      const page = await readFile(path.join(folder, "index.html"), "utf8");
      expect(page).toContain('aria-label="Task chat"');
      expect(page).toContain("Original user request");
      expect(page).toContain("Entire persisted response &lt;script&gt;unsafe()&lt;/script&gt;");
      expect(page).not.toContain("<script>unsafe()</script>");
    }
  });

  it("publishes retained passing results but exits unsuccessfully when the request journal is damaged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-damaged-ledger-report-"));
    cleanupDirectories.push(root);
    const executionId = "core-compatibility.runner-codex.local.message-marker";
    const directory = path.join(root, "attempt-1");
    await mkdir(directory);
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility",
      attempt: 1, status: "passed", profileId: "runner-codex", environmentId: "local",
      caseId: "message-marker", provider: "codex", model: "fixture-model", runtimeMode: "native",
      startedAt: "2026-10-20T00:00:00Z", finishedAt: "2026-10-20T00:00:01Z", durationMs: 1000, cleanup: "passed",
    };
    const phaseStart = Date.parse(result.startedAt);
    const timing = await createWorkerTiming(path.join(directory, "worker-timing.json"), result, phaseStart);
    await timing.enter("execution", phaseStart + 200);
    await timing.enter("cleanup", phaseStart + 800);
    await timing.enter("finalization", phaseStart + 900);
    result.workerTiming = await timing.finish(phaseStart + 1000);
    const original = JSON.stringify(result);
    await writeFile(path.join(directory, "result.json"), original);
    await writeFile(path.join(directory, "final-state.png"), "fake-png");
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const journal = path.join(root, "journal.jsonl"), output = path.join(root, "merged");
    await writeFile(journal, '{"damaged-journal":');
    await expect(execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output,
        PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]), PAPERCLIP_E2E_OPERATIONS_LEDGER: journal },
    })).rejects.toMatchObject({ code: 1 });
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized).toMatchObject({ passed: 1, failed: 0, operations: { status: "unavailable" } });
    expect(normalized.results[0]).toMatchObject({ executionId, status: "passed" });
    expect(normalized.accounting.attempts[0].workerTiming).toEqual(result.workerTiming);
    expect(await readFile(path.join(output, "summary.md"), "utf8")).toContain("Worker setup time: 200ms.");
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain("<strong>200ms</strong><span>Worker setup time</span>");
    expect(await readFile(path.join(output, "index.html"), "utf8")).toContain("Worker phase timing: complete.");
    expect(normalized.billing.agentRunDurationMs).toBeNull();
    expect(await readFile(path.join(output, "index.html"), "utf8"))
      .toContain("<strong>Unknown</strong><span>Agent execution time</span>");
    for (const file of ["index.html", "summary.md"]) {
      expect(await readFile(path.join(output, file), "utf8")).toContain("Request ledger accounting unavailable");
    }
    expect(await readFile(path.join(directory, "result.json"), "utf8")).toBe(original);
  });

  it("corrects overconfident timing verdicts without changing retained bounds or original files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-latency-report-"));
    cleanupDirectories.push(root);
    const executionId = "core-compatibility.runner-codex.local.message-marker";
    const directory = path.join(root, "attempt-1");
    await mkdir(directory);
    const acknowledgement = classifyLatency(observationTiming({ event: "acknowledgement", lastAbsentMs: 1_901, firstPresentMs: 2_427, resolutionMs: 0 }), { operator: "<=", ms: 2_000 });
    const response = classifyLatency(observationTiming({ event: "first_visible_response", lastAbsentMs: 52_965, firstPresentMs: 53_334, resolutionMs: 0 }), { operator: "<=", ms: 30_000 });
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility", attempt: 1, status: "passed",
      profileId: "runner-codex", environmentId: "local", caseId: "message-marker", provider: "codex", model: "fixture-model", runtimeMode: "native",
      startedAt: "2026-10-18T00:00:00Z", finishedAt: "2026-10-18T00:01:00Z", durationMs: 60_000, cleanup: "passed",
      // An old report called the crossing interval a failure (or a pass).
      latencyProbes: [{ ...acknowledgement, verdict: "fail", reason: "outside_target", observationTimeouts: 1 }, { ...acknowledgement, verdict: "pass", reason: "within_target" }, response],
    };
    const raw = JSON.stringify(result);
    await writeFile(path.join(directory, "result.json"), raw);
    await writeFile(path.join(directory, "final-state.png"), "fixture-png");
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const output = path.join(root, "merged");
    await execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]) },
    });
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized.results[0].latencyProbes).toEqual([
      { ...acknowledgement, recordedVerdict: "fail", observationTimeouts: 1 }, { ...acknowledgement, recordedVerdict: "pass" }, response,
    ]);
    expect(normalized.passed).toBe(1);
    expect(await readFile(path.join(directory, "result.json"), "utf8")).toBe(raw);
    const dashboard = await readFile(path.join(output, "index.html"), "utf8");
    expect(dashboard).toContain("inconclusive");
    expect(dashboard).toContain("(1901, 2427] ms");
    expect(dashboard).toContain("(52965, 53334] ms");
    expect(dashboard).toContain("first_visible_response");
  });
  it("retains full reuse and a workspace-only invalidation in the generated report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "runner-reuse-report-"));
    cleanupDirectories.push(root);
    const executionId = "core-compatibility.runner-codex.local.message-marker";
    const directory = path.join(root, "attempt-1");
    await mkdir(directory);
    const startupReuse = [false, true].map(invalidate => ({
      runId: invalidate ? "workspace-invalidated" : "fully-reused",
      ...summarizeStartupReuse(STARTUP_REUSE_LAYERS.map(layer => ({
        eventType: "run.startup.reuse",
        payload: { schema: STARTUP_REUSE_SCHEMA, layer,
          state: invalidate && layer === "workspace" ? "fresh" : "reused",
          reason: invalidate && layer === "workspace" ? "workspace_changed" : "verified_reuse",
          ...(layer === "provider_process" ? { providerLaunchCount: 0 } : {}) },
      }))),
    }));
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility",
      attempt: 1, status: "passed", profileId: "runner-codex", environmentId: "local",
      caseId: "message-marker", provider: "codex", model: "fixture-model", runtimeMode: "native",
      startedAt: "2026-09-23T00:00:00Z", finishedAt: "2026-09-23T00:00:01Z", durationMs: 1000,
      cleanup: "passed", runIds: startupReuse.map(reuse => reuse.runId), startupReuse,
    };
    await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
    await writeFile(path.join(directory, "final-state.png"), "fake-png");
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    const output = path.join(root, "merged");
    await execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot,
      env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: root, PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([executionId]) },
    });
    const normalized = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
    expect(normalized.results[0].startupReuse).toEqual(startupReuse);
    expect(startupReuse.map(reuse => reuse.warmth)).toEqual(["warm", "partial_reuse"]);
    const dashboard = await readFile(path.join(output, "index.html"), "utf8");
    expect(dashboard).toContain("<td>warm</td>");
    expect(dashboard).toContain("<td>partial_reuse</td>");
    expect(dashboard).toContain("fresh (workspace_changed)");
  });

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
    expect(normalized.results[0].startupReuse).toHaveLength(runIds.length);
    expect(normalized.results[0].startupReuse.every((reuse: { warmth: string; providerLaunchCount: number | null }) =>
      reuse.warmth === "unknown" && reuse.providerLaunchCount === null)).toBe(true);
    expect(dashboard).not.toContain("<caption>Startup reuse evidence</caption>");
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
      reportedLlmCostUsd: 0.025,
      llm: {
        inputTokens: 2_500,
        outputTokens: 150,
        runsWithReportedCost: 2,
      },
    });
    expect(normalized.accounting.attempts).toHaveLength(2);
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
    expect(dashboard).toContain("E2E tests");
    expect(dashboard).toMatch(/\$0\.0250*<\/strong><span>LLM reported subtotal/);
    expect(dashboard).toContain("<strong>2s</strong><span>Summed attempt time</span>");
    expect(dashboard).toContain("Carried-forward evidence can span older runs");
    expect(await readFile(path.join(output, "summary.md"), "utf8")).toContain("Summed attempt time: 2s; 2 retained attempts; 0 missing attempts.");
    expect(dashboard).toContain(executionId);
    expect(dashboard).toContain("case-passed");
    expect(dashboard).not.toContain(
      "core-compatibility.runner-acpx-codex.daytona.message-marker",
    );
    expect(dashboard).not.toContain('class="case case-not-selected"');
    expect(dashboard).toContain("<img");
    expect(dashboard).toContain('class="brand-lockup report-brand"');
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
    expect(dashboard).toContain("Test details");
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
    expect(dashboard).toContain('class="execution-preview-label"');
    expect(dashboard).toContain('aria-label="Campaign suites"');
    expect(dashboard).toContain("data-gallery-profile=");
    expect(dashboard).toContain("data-gallery-environment=");
    expect(dashboard).toContain("data-gallery-duration=");
    expect(dashboard).toContain("data-gallery-tokens=");
    expect(dashboard).toContain("data-gallery-matchers=");
    expect(dashboard).toContain("data-report-query");
    expect(dashboard).toContain("data-report-profile");
    expect(dashboard).toContain("data-report-environment");
    expect(dashboard).toContain("data-report-status");
    expect(dashboard).not.toContain('class="suite-nav"');
    expect(dashboard).toContain("data-report-feature");
    expect(dashboard).toContain("Feature coverage");
    expect(dashboard).not.toContain(".report-filters { position: sticky");
    expect(dashboard).toContain("table-layout: fixed");
    expect(dashboard).toContain('class="execution-previews"');
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

it("retains selector-approved successes and their spending when only failed workflow jobs rerun", async () => {
  const { selectRerunArtifacts } = await import("./select-rerun-artifacts.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "runner-partial-rerun-"));
  cleanupDirectories.push(root);
  const artifactRoot = path.join(root, "downloaded"), selectedRoot = path.join(root, "selected");
  const executions = ["core-compatibility.runner-codex.local.message-marker", "core-compatibility.runner-claude.local.message-marker"];
  const source = { sha: "a".repeat(40), ref: "master", workflowRunUrl: "https://github.com/paperclipai/paperclip/actions/runs/12345" };
  for (const [index, executionId] of executions.entries()) {
    const workflowAttempt = index + 1;
    const artifactName = `runner-e2e-12345-${workflowAttempt}-${executionId}`;
    const directory = path.join(artifactRoot, artifactName, `gha-12345-${workflowAttempt}-${executionId}`, "attempt-1");
    await mkdir(directory, { recursive: true });
    const result: RunnerE2EResult = {
      schema: "paperclip.runner-e2e.result/v2", executionId, suiteId: "core-compatibility", source,
      accountingIdentity: { campaignId: `gha-12345-${workflowAttempt}`, attemptId: `attempt-${index}` },
      attempt: 1, status: "passed", profileId: index ? "runner-claude" : "runner-codex", environmentId: "local",
      caseId: "message-marker", provider: index ? "claude" : "codex", model: "fixture", runtimeMode: "native",
      startedAt: "2026-10-20T00:00:00Z", finishedAt: "2026-10-20T00:00:01Z", durationMs: 1000, cleanup: "passed",
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 * workflowAttempt },
    };
    await writeFile(path.join(directory, "result.json"), JSON.stringify(result));
    await writeFile(path.join(directory, "evidence-manifest.json"), JSON.stringify({ files: ["final-state.png"], leaks: [], missing: [] }));
    await writeFile(path.join(directory, "final-state.png"), "fixture-png");
  }
  await selectRerunArtifacts({ artifactRoot, selectedRoot, expectedExecutionIds: executions, workflowRunId: "12345", workflowRunAttempt: 2,
    sourceSha: source.sha, sourceRef: source.ref, workflowRunUrl: source.workflowRunUrl,
    jobs: { attempts: [{ run_attempt: 1, run_started_at: "2026-10-20T00:00:00Z" }, { run_attempt: 2, run_started_at: "2026-10-20T01:00:00Z" }],
      jobs: [{ name: executions[0]!, run_attempt: 1, started_at: "2026-10-20T00:01:00Z" },
        { name: executions[1]!, run_attempt: 1, started_at: "2026-10-20T00:01:00Z" },
        { name: executions[1]!, run_attempt: 2, started_at: "2026-10-20T01:01:00Z" }] },
  });
  const output = path.join(root, "report");
  await execFileAsync(process.execPath, [path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
    cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_E2E_CAMPAIGN_ID: "gha-12345-2", PAPERCLIP_RUNNER_E2E_REPORT_ROOT: selectedRoot,
      PAPERCLIP_RUNNER_E2E_REPORT_OUT: output, PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify(executions) },
  });
  const campaign = JSON.parse(await readFile(path.join(output, "normalized-results.json"), "utf8"));
  expect(campaign).toMatchObject({ passed: 2, failed: 0, billing: { reportedLlmCostUsd: 0.03 }, accounting: { excludedArtifacts: 0 } });
  expect(campaign.accounting.attempts).toHaveLength(2);
  expect(campaign.results[0].accountingIdentity.campaignId).toBe("gha-12345-1");
});
