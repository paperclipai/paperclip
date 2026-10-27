import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { emptyFeedbackSummary } from "./feedback.js";
import { buildRunnerCampaign } from "./history.js";
import { regenerateRunnerDashboard } from "./dashboard-regenerate.js";
import { campaignFeedbackEvidence, campaignFeedbackReviewText, feedbackReviewTemplate, validateCampaignFeedbackReview, type CampaignFeedbackReview } from "./feedback-dispositions.js";
import type { RunnerE2EResult } from "./types.js";

function fixture() {
  const cell = runnerMatrix[0]!;
  const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: cell.id, suiteId: cell.suite.id,
    suiteDefinitionHash: cell.suiteDefinitionHash, attempt: 1, status: "failed", profileId: cell.profile.id,
    environmentId: cell.environment.id, caseId: cell.task.id, provider: cell.profile.provider, model: cell.profile.model, runtimeMode: cell.profile.expectedRuntimeMode,
    runIds: [], startedAt: "2026-10-20T00:00:00Z", finishedAt: "2026-10-20T00:00:01Z", durationMs: 1000, cleanup: "passed",
    feedback: { ...emptyFeedbackSummary(), collection: "partial", invocationCollection: "complete", complaints: 2, suggestions: 1, bodiesCollected: 3,
      review: ["a", "b", "c"].map(value => ({ fingerprint: value.repeat(64), kind: value === "c" ? "suggestion" : "complaint", occurrences: 1, disposition: "needs_investigation" })) } };
  return buildRunnerCampaign({ campaignId: "feedback-campaign", generatedAt: result.finishedAt, expected: [cell.id], results: [result] });
}
function reviewed(campaign = fixture()): CampaignFeedbackReview {
  return { ...feedbackReviewTemplate(campaign), version: 1, reviewedAt: "2026-10-20T01:00:00Z", reviewedBy: "agent",
    decisions: [
      { fingerprint: "a".repeat(64), disposition: "actionable", issueNumber: 123 },
      { fingerprint: "b".repeat(64), disposition: "duplicate", duplicateOf: "a".repeat(64) },
      { fingerprint: "c".repeat(64), disposition: "unsupported" },
    ] };
}

it("keeps an unreviewed template invalid until a reviewer records the decision metadata", () => {
  const campaign = fixture();
  expect(() => validateCampaignFeedbackReview(campaign, feedbackReviewTemplate(campaign) as never)).toThrow("Invalid or stale");
  expect(campaignFeedbackReviewText(campaign)).toContain("3 distinct feedback items await review");
  validateCampaignFeedbackReview(campaign, reviewed(campaign));
});

it("preserves dispositions on regeneration without changing failed grades or incomplete collection", async () => {
  const campaign = fixture(); campaign.feedbackReview = reviewed(campaign);
  const root = await mkdtemp(path.join(tmpdir(), "feedback-review-"));
  try {
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify({ ...campaign, feedbackReview: undefined }));
    const retainedHeader = "# Existing campaign\n\nProvider-reported LLM cost: $0.123456\n\n";
    await writeFile(path.join(root, "summary.md"), `${retainedHeader}${campaignFeedbackReviewText({ ...campaign, feedbackReview: undefined })}\n`);
    const feedbackReviewFile = path.join(root, "review.json");
    await writeFile(feedbackReviewFile, JSON.stringify(campaign.feedbackReview));
    await regenerateRunnerDashboard({ bundle: root, historyFile: null, feedbackReviewFile });
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    const retained = JSON.parse(await readFile(path.join(root, "normalized-results.json"), "utf8"));
    expect(retained.feedbackReview).toEqual(campaign.feedbackReview);
    expect(retained.results[0].status).toBe("failed");
    expect(retained.accounting.attempts[0].feedback.collection).toBe("partial");
    const html = await readFile(path.join(root, "dashboard.html"), "utf8");
    expect(html).toContain("1 actionable; 1 duplicate; 0 already fixed; 1 unsupported; 0 needs investigation");
    expect(html).toContain("1 attempts have incomplete collection");
    expect(html).toContain("https://github.com/paperclipai/paperclip/issues/123");
    const summary = await readFile(path.join(root, "summary.md"), "utf8");
    expect(summary).toBe(`${retainedHeader}${campaignFeedbackReviewText(campaign)}\n`);
    expect(summary).not.toContain("await review");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects stale reviews when attempts or collection evidence change, but permits a render refresh", () => {
  const campaign = fixture(), review = reviewed(campaign);
  campaign.generatedAt = "2026-10-21T00:00:00Z";
  validateCampaignFeedbackReview(campaign, review);
  const changed = structuredClone(campaign);
  changed.accounting!.attempts[0]!.feedback!.collection = "complete";
  expect(() => validateCampaignFeedbackReview(changed, review)).toThrow("Invalid or stale");
  changed.accounting = structuredClone(campaign.accounting);
  changed.accounting!.missingAttempts++;
  expect(() => validateCampaignFeedbackReview(changed, review)).toThrow("Invalid or stale");
  expect(campaignFeedbackEvidence({ ...campaign, expected: [...campaign.expected].reverse() })).toBe(review.evidenceHash);
});

it("requires exactly one closed decision per group and refuses raw notes and duplicate cycles", () => {
  const campaign = fixture(), review = reviewed(campaign);
  for (const changed of [
    { ...review, rationale: "private notes" },
    { ...review, decisions: review.decisions.slice(1) },
    { ...review, decisions: [...review.decisions, review.decisions[0]!] },
    { ...review, decisions: review.decisions.map(item => ({ ...item, rawBody: "private body" })) },
    { ...review, decisions: review.decisions.map(item => item.fingerprint === "a".repeat(64) ? { ...item, disposition: "duplicate", duplicateOf: "b".repeat(64) } : item) },
  ]) expect(() => validateCampaignFeedbackReview(campaign, changed as never)).toThrow("Invalid or stale");
});

it.each(["2026-10-20T01:00:00Z", "2026-10-20T01:00:00.936739+00:00", "2026-10-19T20:00:00-05:00"])("accepts explicit ISO review timestamps: %s", reviewedAt => {
  const campaign = fixture();
  validateCampaignFeedbackReview(campaign, { ...reviewed(campaign), reviewedAt });
});

it("rejects private timestamp notes before a review can alter the public report", async () => {
  const campaign = fixture();
  const reviewedAt = "Tue, 20 Oct 2026 01:00:00 GMT (Private rationale: customer account was suspended)";
  expect(Number.isFinite(Date.parse(reviewedAt))).toBe(true);
  const root = await mkdtemp(path.join(tmpdir(), "feedback-private-timestamp-"));
  try {
    const original = JSON.stringify(campaign);
    await writeFile(path.join(root, "normalized-results.json"), original);
    const feedbackReviewFile = path.join(root, "review.json");
    await writeFile(feedbackReviewFile, JSON.stringify({ ...reviewed(campaign), reviewedAt }));
    await expect(regenerateRunnerDashboard({ bundle: root, historyFile: null, feedbackReviewFile })).rejects.toThrow("Invalid or stale");
    expect(await readFile(path.join(root, "normalized-results.json"), "utf8")).toBe(original);
    for (const invalid of ["2026-10-20T01:00:00Z\n", "2026-10-20", "2026-10-20T24:00:00Z"]) {
      expect(() => validateCampaignFeedbackReview(campaign, { ...reviewed(campaign), reviewedAt: invalid })).toThrow("Invalid or stale");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("records an explicit empty review without implying that uncaptured feedback was absent", () => {
  const campaign = fixture(); campaign.accounting!.attempts[0]!.feedback = emptyFeedbackSummary();
  campaign.feedbackReview = { ...feedbackReviewTemplate(campaign), version: 1, reviewedAt: "2026-10-20T01:00:00Z", reviewedBy: "human", decisions: [] };
  validateCampaignFeedbackReview(campaign, campaign.feedbackReview);
  expect(campaignFeedbackReviewText(campaign)).toContain("1 attempts have incomplete collection");
});

it("refreshes an older summary that kept the awaiting-review count inline", async () => {
  const campaign = fixture(); campaign.feedbackReview = reviewed(campaign);
  const root = await mkdtemp(path.join(tmpdir(), "feedback-legacy-summary-"));
  try {
    await writeFile(path.join(root, "normalized-results.json"), JSON.stringify(campaign));
    await writeFile(path.join(root, "summary.md"), "# Existing campaign\n\nFeedback across retained attempts: 2 complaints; 1 suggestions; 3 distinct items awaiting review; 1 attempts with incomplete collection.\n");
    await regenerateRunnerDashboard({ bundle: root, historyFile: null });
    const summary = await readFile(path.join(root, "summary.md"), "utf8");
    expect(summary).toContain("2 complaints; 1 suggestions; 1 attempts with incomplete collection.");
    expect(summary).toContain(campaignFeedbackReviewText(campaign));
    expect(summary).not.toContain("awaiting review");
  } finally { await rm(root, { recursive: true, force: true }); }
});
