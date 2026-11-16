import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { writeAntigravityJourneyReport } from "./antigravity-journey-report.js";
import { antigravityEvidenceFixture } from "./antigravity-journey-test-fixtures.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import { assertPublicCampaign } from "./history-publish.js";
import { summarizeExecutionBilling } from "./billing.js";
import type { RunnerE2EResult } from "./types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
// Synthetic report calibration image; never a screenshot of a product attempt.
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=", "base64");
function fixture(passed = true): RunnerE2EResult {
  const cell = runnerMatrix.find(row => row.id === "antigravity-agent-journey.runner-antigravity.local.saved-subscription-two-turn")!;
  const evidence = antigravityEvidenceFixture();
  if (!passed) { evidence.outcome = "failed"; evidence.checkpoints.persisted = false; }
  return { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id, suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    profileId: cell.profile.id, environmentId: "local", caseId: cell.task.id, provider: "acpx", model: "gemini-3.8-flash-low", runtimeMode: "native",
    attempt: 1, status: passed ? "passed" : "failed", ...(!passed ? { error: "antigravity_evidence_exact_download" } : {}), cleanup: "passed", durationMs: 1000,
    startedAt: "2026-10-29T00:00:00Z", finishedAt: "2026-10-29T00:00:01Z", issueId: "task", runIds: ["run-first", "run-second"], antigravityJourney: evidence,
    screenshots: [{ id: passed ? "persisted" : "failure", label: "Synthetic calibration only", file: "calibration.png", sha256: createHash("sha256").update(pixel).digest("hex") }] };
}

it.each([true, false])("roundtrips %s through ordinary packaging, validation and campaign dashboard", async passed => {
  const output = await mkdtemp(path.join(os.tmpdir(), "antigravity-report-calibration-")); temporary.push(output);
  await writeFile(path.join(output, "calibration.png"), pixel);
  await writeFile(path.join(output, "private-auth.png"), pixel);
  const result = await writeAntigravityJourneyReport({ output, campaignId: "calibration", result: fixture(passed), resources: { runIds: ["run-first", "run-second"] }, catalog: runnerMatrix, secrets: [] });
  expect(() => validateRetainedRunnerResult(result)).not.toThrow();
  expect(result.status).toBe(passed ? "passed" : "failed");
  const manifest = JSON.parse(await readFile(path.join(output, "evidence/evidence-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ leaks: [], missing: [] });
  expect(manifest.files).toContain(`snapshots/${passed ? "persisted" : "failure"}.png`);
  await expect(stat(path.join(output, "evidence/private-auth.png"))).rejects.toThrow();
  const campaign = JSON.parse(await readFile(path.join(output, "campaign.json"), "utf8"));
  expect(campaign).toMatchObject({ passed: passed ? 1 : 0, failed: passed ? 0 : 1 });
  expect(() => assertPublicCampaign(campaign)).toThrow("Private Product E2E");
  expect(await readFile(path.join(output, "dashboard.html"), "utf8")).toContain(`evidence/snapshots/${passed ? "persisted" : "failure"}.png`);
});

it("rejects a missing or changed required screenshot before a passing report", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "antigravity-report-calibration-")); temporary.push(output);
  const input = fixture();
  input.screenshots = [];
  await expect(writeAntigravityJourneyReport({ output, campaignId: "missing", result: input, resources: {}, catalog: runnerMatrix, secrets: [] })).rejects.toThrow();
  await writeFile(path.join(output, "calibration.png"), "altered");
  await expect(writeAntigravityJourneyReport({ output, campaignId: "changed", result: fixture(), resources: {}, catalog: runnerMatrix, secrets: [] })).rejects.toThrow("journey_screenshot_digest_mismatch");
});

it("does not permit a green normalized receipt with incomplete owned cleanup", () => {
  const input = fixture(); input.antigravityJourney!.cleanup.connectionPreserved = false;
  expect(() => validateRetainedRunnerResult(input)).toThrow("result.antigravityJourney");
});

it("preserves measured tokens, duration and unknown subscription prices through packaging", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "antigravity-report-calibration-")); temporary.push(output);
  await writeFile(path.join(output, "calibration.png"), pixel);
  const input = fixture();
  input.usage = { runs: [{ usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, costUsd: 0, costStatus: "unpriced" } },
    { usage: { inputTokens: 200, outputTokens: 30, cachedInputTokens: 40, costUsd: 0, costStatus: "unpriced" } }] };
  input.billing = summarizeExecutionBilling(input);
  const result = await writeAntigravityJourneyReport({ output, campaignId: "unpriced", result: input, resources: {}, catalog: runnerMatrix, secrets: [] });
  const retained = JSON.parse(await readFile(path.join(output, "evidence/result.json"), "utf8"));
  expect(retained.durationMs).toBe(1000);
  expect(retained.billing).toEqual(result.billing);
  expect(summarizeExecutionBilling(retained)).toEqual(input.billing);
  expect(retained.billing).toMatchObject({ complete: false, llm: { runCount: 2, inputTokens: 300, outputTokens: 50, cachedInputTokens: 50,
    runsWithReportedCost: 0, costStatus: "unpriced" } });
});

it.each([true, false])("imports a synthetic %s receipt through the ordinary report CLI without changing its verdict or unknown prices", async passed => {
  const output = await mkdtemp(path.join(os.tmpdir(), "antigravity-report-cli-calibration-")); temporary.push(output);
  await writeFile(path.join(output, "calibration.png"), pixel);
  const input = fixture(passed);
  input.usage = { runs: [
    { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, costUsd: 0, costStatus: "unpriced" } },
    { usage: { inputTokens: 200, outputTokens: 30, cachedInputTokens: 40, costUsd: 0, costStatus: "unpriced" } },
  ] };
  input.billing = summarizeExecutionBilling(input);
  await writeAntigravityJourneyReport({ output, campaignId: "cli-calibration", result: input, resources: {}, catalog: runnerMatrix, secrets: [] });
  const repositoryRoot = path.resolve(import.meta.dirname, "../.."), rebuilt = path.join(output, "rebuilt");
  let exitCode = 0;
  try {
    await promisify(execFile)(process.execPath, ["--import", path.join(repositoryRoot, "cli/node_modules/tsx/dist/loader.mjs"), path.join(repositoryRoot, "tests/runner-e2e/report.ts")], {
      cwd: repositoryRoot, env: { ...process.env, PAPERCLIP_RUNNER_E2E_REPORT_ROOT: output, PAPERCLIP_RUNNER_E2E_REPORT_OUT: rebuilt,
        PAPERCLIP_RUNNER_E2E_EXPECTED_IDS: JSON.stringify([input.executionId]) }, timeout: 30_000, maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (typeof (error as { code?: unknown }).code !== "number") throw error;
    exitCode = (error as { code: number }).code;
  }
  expect(exitCode).toBe(passed ? 0 : 1);
  const normalized = JSON.parse(await readFile(path.join(rebuilt, "normalized-results.json"), "utf8"));
  expect(normalized.results).toHaveLength(1);
  expect(normalized.results[0]).toMatchObject({ status: input.status, durationMs: 1000, evidenceValid: true, antigravityJourney: { privacy: "private", outcome: input.status } });
  expect(normalized.results[0].billing).toEqual(input.billing);
  expect(normalized.results[0].antigravityJourney.turnEvidence).toHaveLength(2);
  expect(await readFile(path.join(rebuilt, "dashboard.html"), "utf8")).toContain("antigravity-agent-journey");
});
