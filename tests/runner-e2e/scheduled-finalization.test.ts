import { expect, it } from "vitest";
import { buildRunnerCampaign } from "./history.js";
import { runnerMatrix } from "./catalog.js";
import { emptyFeedbackSummary, feedbackReview, type FeedbackEvidence } from "./feedback.js";
import { expectedFixtureFeedback } from "./feedback-persistence.js";
import { reviewScheduledFeedback, scheduledCampaignFindings } from "./scheduled-finalization.js";
import type { RunnerE2EResult } from "./types.js";

function fixture() {
  const cell = runnerMatrix.find(row => row.id === "feedback-persistence.runner-acpx-claude.local.complaint-and-suggestion")!;
  const nonce = "abcdef123-1", bodies = expectedFixtureFeedback(nonce);
  const entries = ["complaint", "suggestion"].map(kind => ({ kind, body: bodies[kind as keyof typeof bodies] })) as FeedbackEvidence["entries"];
  const feedback = { version: 1, companyId: "company", entries, invocations: [], diagnostics: [], summary: emptyFeedbackSummary() } as FeedbackEvidence;
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id,
    suiteId: cell.suite.id, suiteDefinitionHash: cell.suiteDefinitionHash,
    accountingIdentity: { campaignId: "scheduled-fixture", attemptId: "one" }, source: { sha: "a".repeat(40), ref: null, workflowRunUrl: null },
    attempt: 1, status: "passed", cleanup: "passed", profileId: cell.profile.id, caseId: cell.task.id,
    environmentId: cell.environment.id, provider: cell.profile.provider, model: cell.profile.model, runtimeMode: cell.profile.expectedRuntimeMode,
    startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z", durationMs: 1000,
    feedback: { ...emptyFeedbackSummary(), collection: "complete", invocationCollection: "complete", complaints: 1, suggestions: 1,
      bodiesCollected: 2, review: feedbackReview(entries) },
    matcherResults: [{ matcher: { kind: "message_exact", expected: `PAPERCLIP_E2E_OK_${nonce}` }, passed: true, detail: "matched" },
      ...["complete-retained-evidence", "one-of-each", "complaint-body-and-attribution", "complaint-completed-tool",
        "suggestion-body-and-attribution", "suggestion-completed-tool", "only-expected-submissions"].map(id => ({
        matcher: { kind: "json_path" as const, path: `feedbackPersistence.${id}`, expected: true }, passed: true, detail: "matched" }))] };
  const campaign = buildRunnerCampaign({ campaignId: "scheduled-fixture", generatedAt: result.finishedAt,
    expected: [cell.id], results: [result], attempts: [result] });
  return { result, feedback, campaign };
}

it("reviews independently retained exact synthetic bodies without a model call", () => {
  const { result, feedback, campaign } = fixture();
  const review = reviewScheduledFeedback(campaign, [{ result, feedback }], result.finishedAt);
  expect(review.decisions.map(row => row.disposition)).toEqual(["unsupported", "unsupported"]);
  expect(JSON.stringify(review)).not.toContain("Synthetic eval");
});

it.each(["body-changed", "wrong-suite", "missing-evidence", "failed-grade", "partial-collection"])("leaves %s feedback for investigation", reason => {
  const { result, feedback, campaign } = fixture();
  if (reason === "body-changed") feedback.entries[0]!.body = "A real product problem";
  if (reason === "wrong-suite") result.suiteId = "core-compatibility";
  if (reason === "failed-grade") result.matcherResults![2]!.passed = false;
  if (reason === "partial-collection") result.feedback!.collection = "partial";
  const review = reviewScheduledFeedback(campaign, [{ result, feedback: reason === "missing-evidence" ? null : feedback }], result.finishedAt);
  expect(review.decisions.every(row => row.disposition === "needs_investigation")).toBe(true);
});

it("keeps incomplete accounting and trace export visible independently of a passing product grade", () => {
  const { result, feedback, campaign } = fixture();
  campaign.feedbackReview = reviewScheduledFeedback(campaign, [{ result, feedback }], result.finishedAt);
  expect(scheduledCampaignFindings(campaign)).toEqual(["accounting_unavailable", "trace_export_incomplete"]);
  campaign.feedbackReview.decisions[0]!.disposition = "needs_investigation";
  expect(scheduledCampaignFindings(campaign)).toContain("feedback_needs_review");
});
