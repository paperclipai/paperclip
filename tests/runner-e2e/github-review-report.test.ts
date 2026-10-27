import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { writeGitHubReviewReport } from "./github-review-report.js";
import { githubJourneyCheckpoints } from "./github-review-evidence.js";
import { validateRetainedRunnerResult } from "./result-validation.js";
import type { RunnerE2EResult } from "./types.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=", "base64");
function fixture(): RunnerE2EResult {
  const cell = runnerMatrix.find(row => row.id === "github-review-journey.configured-agent.local.setup-and-first-review")!;
  return { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id, suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    profileId: cell.profile.id, environmentId: "local", caseId: cell.task.id, provider: "opencode", model: "configured-model", runtimeMode: "native",
    attempt: 1, status: "failed", error: "native_session_interrupted", cleanup: "passed", durationMs: 1000,
    startedAt: "2026-10-24T00:00:00Z", finishedAt: "2026-10-24T00:00:01Z",
    githubReviewJourney: { version: 1, outcome: "failed", phase: "review_execution_completion", setupId: "qa", hosting: "paperclip-cloud", targetCommit: "a".repeat(40), assisted: true,
      dependencies: [], checkpoints: { github_delivery: true }, cleanup: { endpoint: true, app: true, branch: true, pullRequest: true },
      budgetPolicyRead: "verified", budgetPolicies: [{ scopeType: "agent", amount: 100, hardStopEnabled: true, unpricedUsagePolicy: "allow" }],
      execution: { reviewId: "review", issueId: "issue", runId: "run", runStatus: "failed", runtimeMode: "native", provider: "opencode", model: "configured-model" } },
    screenshots: [{ id: "failure", label: "Failed native completion", file: "failure.png", sha256: createHash("sha256").update(pixel).digest("hex") }] };
}

it("packages an honest failed journey for the existing report pipeline without admitting other private files", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "github-report-test-")); temporary.push(output);
  await writeFile(path.join(output, "failure.png"), pixel);
  await writeFile(path.join(output, "auth.png"), pixel);
  const result = await writeGitHubReviewReport({ output, campaignId: "retained-failure", result: fixture(), resources: { branch: "owned", appName: "owned", runIds: ["run"] }, catalog: runnerMatrix, secrets: [] });
  expect(result.status).toBe("failed");
  expect(() => validateRetainedRunnerResult(result)).not.toThrow();
  const manifest = JSON.parse(await readFile(path.join(output, "evidence/evidence-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({ leaks: [], missing: [] });
  expect(manifest.files).toContain("snapshots/failure.png");
  expect(manifest.files).toContain("snapshots/journey-resources.json");
  await expect(stat(path.join(output, "evidence/auth.png"))).rejects.toThrow();
  expect(await readFile(path.join(output, "evidence/snapshots/failure.png"))).toEqual(pixel);
  const campaign = JSON.parse(await readFile(path.join(output, "campaign.json"), "utf8"));
  expect(campaign).toMatchObject({ passed: 0, failed: 1 });
  const html = await readFile(path.join(output, "dashboard.html"), "utf8");
  expect(html).toContain("evidence/snapshots/failure.png");
});

it("refuses an altered screenshot rather than retaining its claimed digest", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "github-report-test-")); temporary.push(output);
  await writeFile(path.join(output, "failure.png"), "altered");
  await expect(writeGitHubReviewReport({ output, campaignId: "altered", result: fixture(), resources: { branch: "owned", appName: "owned", runIds: [] }, catalog: runnerMatrix, secrets: [] }))
    .rejects.toThrow("journey_screenshot_digest_mismatch");
});

it("stages the verified persisted checkpoint as the standard report's final state", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "github-report-test-")); temporary.push(output);
  const input = fixture();
  input.status = "passed"; delete input.error;
  input.githubReviewJourney!.outcome = "passed";
  input.githubReviewJourney!.checkpoints = Object.fromEntries(githubJourneyCheckpoints.map(id => [id, true]));
  input.screenshots = [{ id: "persisted", label: "Persisted completion", file: "persisted.png", sha256: createHash("sha256").update(pixel).digest("hex") }];
  await writeFile(path.join(output, "persisted.png"), pixel);
  const result = await writeGitHubReviewReport({ output, campaignId: "passing-journey", result: input, resources: { branch: "owned", appName: "owned", runIds: ["run"] }, catalog: runnerMatrix, secrets: [] });
  expect(result.status).toBe("passed");
  const manifest = JSON.parse(await readFile(path.join(output, "evidence/evidence-manifest.json"), "utf8"));
  expect(manifest.files).toContain("final-state.png");
  expect(await readFile(path.join(output, "evidence/final-state.png"))).toEqual(pixel);
  expect(await readFile(path.join(output, "evidence/snapshots/persisted.png"))).toEqual(pixel);
});

it("refuses a passing report without its persisted screenshot", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "github-report-test-")); temporary.push(output);
  const input = fixture();
  input.status = "passed"; delete input.error;
  input.githubReviewJourney!.outcome = "passed";
  input.githubReviewJourney!.checkpoints = Object.fromEntries(githubJourneyCheckpoints.map(id => [id, true]));
  await writeFile(path.join(output, "failure.png"), pixel);
  await expect(writeGitHubReviewReport({ output, campaignId: "missing-final-state", result: input, resources: { branch: "owned", appName: "owned", runIds: ["run"] }, catalog: runnerMatrix, secrets: [] }))
    .rejects.toThrow("journey_final_state_missing");
});
