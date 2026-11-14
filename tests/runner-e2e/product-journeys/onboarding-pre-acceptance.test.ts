import { describe, expect, it } from "vitest";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { renderCaseOutcome } from "../case-outcome.js";
import type { RunnerE2EResult } from "../types.js";
import type { OnboardingPreAcceptanceEvidence } from "./onboarding-pre-acceptance.js";

function result(): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "test",
    executionId: "product-journeys.qa.runner-codex.local.cloud-onboarding", profileId: "runner-codex", environmentId: "local", caseId: "cloud-onboarding",
    provider: "codex", model: "synthetic-model", runtimeMode: "native", status: "failed", error: "onboarding_work_before_acceptance", cleanup: "passed", attempt: 1,
    startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000,
    productJourney: { outcome: "failed", startingState: "onboarding", phases: [{ phase: "journey", outcome: "failed", code: "onboarding_work_before_acceptance" }],
      checks: [], privacy: "private", resourceDisposition: "retained" } };
}
function preAcceptanceReceipt(): OnboardingPreAcceptanceEvidence {
  return { version: 1, checkpoint: "awaiting-proposal", violations: ["attachment_present"],
    taskCount: 1, attachmentCount: 1, documentCount: 0, nonPlanningDocumentCount: 0,
    firstTaskMatchesCanonicalParent: true, firstTaskStatus: "in_review", canonicalParentStatus: "in_review" };
}
function passedResult(): RunnerE2EResult {
  const retained = result();
  retained.status = "passed";
  delete retained.error;
  retained.runIds = ["run-1"];
  Object.assign(retained.productJourney!, { outcome: "passed", campaignId: "campaign", attemptId: "attempt",
    phases: [{ phase: "journey", outcome: "passed" }], resourceDisposition: "released",
    checks: ["fresh-workspace", "ui-connection-and-native-agent", "first-task-complete", "downloadable-artifact-verified", "native-trace-verified"].map(id => ({ id, passed: true })),
    deployment: { kind: "cloud", targetId: "qa", origin: "https://qa.example.test", commit: "a".repeat(40), cloudRelease: "release", runtimeImage: "image", configurationHash: "config" },
    operations: { campaignId: "campaign", attemptId: "attempt", modelCostUsd: null, setupCostUsd: null, requestCount: 1,
      feedback: { collection: "complete", complaints: 0, suggestions: 0 }, traceIds: ["trace-1"] } });
  return retained;
}
describe("onboarding pre-acceptance retained evidence", () => {
  it("accepts historical results without pre-acceptance evidence and preserves optional receipts in reports", () => {
    const retained = result();
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    expect(renderCaseOutcome(retained, true, [])).not.toContain("Onboarding pre-acceptance evidence");
    Object.assign(retained.productJourney!, { onboardingPreAcceptance: preAcceptanceReceipt() });
    const roundTrip = JSON.parse(JSON.stringify(retained));
    expect(() => validateRetainedRunnerResult(roundTrip)).not.toThrow();
    const output = renderCaseOutcome(roundTrip, true, []);
    for (const text of ["Onboarding pre-acceptance evidence", "awaiting-proposal", "attachment_present", "First task status", "Canonical parent status", "in_review", "Attachments", "Non-planning documents", "onboarding_work_before_acceptance"]) expect(output).toContain(text);
    expect(roundTrip.status).toBe("failed");
    expect(roundTrip.productJourney.outcome).toBe("failed");
  });
  it.each([
    ["a passed result", passedResult],
    ["another case", (): RunnerE2EResult => ({ ...result(), caseId: "task-properties",
      executionId: "product-journeys.qa.browser.local.task-properties", profileId: "browser", provider: null, model: null, runtimeMode: "none" })],
    ["another suite", (): RunnerE2EResult => ({ ...result(), suiteId: "first-task", executionId: "first-task.runner-codex.local.cloud-onboarding" })],
  ] as const)("rejects a valid receipt on %s after accepting the same result without it", (_label, makeResult) => {
    const retained = makeResult();
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    retained.productJourney!.onboardingPreAcceptance = preAcceptanceReceipt();
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.onboardingPreAcceptance");
  });
  it.each(["passed", "blocked", "unsupported"] as const)("rejects a valid receipt on a %s journey outcome after accepting the same result without it", outcome => {
    const retained = result();
    retained.productJourney!.outcome = outcome;
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    retained.productJourney!.onboardingPreAcceptance = preAcceptanceReceipt();
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.onboardingPreAcceptance");
  });
  it.each(["onboarding_artifact_evidence_missing", undefined])("rejects a valid receipt for an unrelated or absent failure code (%s)", error => {
    const retained = result();
    retained.error = error;
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    retained.productJourney!.onboardingPreAcceptance = preAcceptanceReceipt();
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.onboardingPreAcceptance");
  });
  it.each([
    ["raw bodies", (): unknown => ({ ...preAcceptanceReceipt(), body: "private-body-must-not-render" })],
    ["task identifiers", (): unknown => ({ ...preAcceptanceReceipt(), taskIds: ["private-task"] })],
    ["document keys", (): unknown => ({ ...preAcceptanceReceipt(), documentKeys: ["private-key"] })],
    ["unknown version", (): unknown => ({ ...preAcceptanceReceipt(), version: 2 })],
    ["unknown checkpoint", (): unknown => ({ ...preAcceptanceReceipt(), checkpoint: "private text" })],
    ["unknown violation", (): unknown => ({ ...preAcceptanceReceipt(), violations: ["private text"] })],
    ["duplicate violations", (): unknown => ({ ...preAcceptanceReceipt(), violations: ["attachment_present", "attachment_present"] })],
    ["empty violations", (): unknown => ({ ...preAcceptanceReceipt(), violations: [] })],
    ["inconsistent violations", (): unknown => ({ ...preAcceptanceReceipt(), violations: ["first_task_done"] })],
    ["negative counts", (): unknown => ({ ...preAcceptanceReceipt(), attachmentCount: -1 })],
    ["fractional counts", (): unknown => ({ ...preAcceptanceReceipt(), taskCount: 1.5 })],
    ["unsafe counts", (): unknown => ({ ...preAcceptanceReceipt(), documentCount: Number.MAX_SAFE_INTEGER + 1 })],
    ["invalid document counts", (): unknown => ({ ...preAcceptanceReceipt(), nonPlanningDocumentCount: 1 })],
    ["raw task status", (): unknown => ({ ...preAcceptanceReceipt(), firstTaskStatus: "private status" })],
    ["raw parent status", (): unknown => ({ ...preAcceptanceReceipt(), canonicalParentStatus: "private status" })],
    ["nonboolean match", (): unknown => ({ ...preAcceptanceReceipt(), firstTaskMatchesCanonicalParent: "true" })],
    ["inconsistent task match", (): unknown => ({ ...preAcceptanceReceipt(), firstTaskMatchesCanonicalParent: false })],
    ["inconsistent matched statuses", (): unknown => ({ ...preAcceptanceReceipt(), canonicalParentStatus: "done" })],
    ["missing fields", (): unknown => ({ version: 1 })],
    ["null", (): unknown => null],
  ] as const)("rejects pre-acceptance evidence containing %s", (_label, makeReceipt) => {
    const retained = result();
    Object.assign(retained.productJourney!, { onboardingPreAcceptance: makeReceipt() });
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.onboardingPreAcceptance");
  });
  it("renders a fixed fallback for malformed pre-acceptance evidence without exposing its fields", () => {
    const retained = result();
    Object.assign(retained.productJourney!, { onboardingPreAcceptance: { ...preAcceptanceReceipt(), body: "private-body-must-not-render" } });
    const output = renderCaseOutcome(retained, false, []);
    expect(output).toContain("Onboarding pre-acceptance evidence unavailable: invalid receipt");
    expect(output).not.toContain("private-body-must-not-render");
    expect(output).not.toContain("attachment_present");
  });
});
