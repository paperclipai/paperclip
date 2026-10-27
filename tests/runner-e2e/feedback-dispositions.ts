import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { summarizeCampaignFeedback } from "./feedback.js";
import { html, isPublicReportTimestamp } from "./report-format.js";
import type { RunnerE2ECampaign } from "./types.js";

const dispositions = ["actionable", "duplicate", "already_fixed", "unsupported", "needs_investigation"] as const;
export interface CampaignFeedbackReview {
  version: 1;
  campaignId: string;
  evidenceHash: string;
  reviewedAt: string;
  reviewedBy: "human" | "agent";
  decisions: Array<{
    fingerprint: string;
    disposition: typeof dispositions[number];
    duplicateOf?: string;
    issueNumber?: number;
  }>;
}

export function campaignFeedbackEvidence(campaign: RunnerE2ECampaign) {
  if (!campaign.accounting) throw new Error("Feedback review requires retained attempt accounting");
  const attempts = campaign.accounting.attempts.map(attempt => ({
    id: attempt.id, executionId: attempt.executionId, attempt: attempt.attempt,
    feedback: attempt.feedback ? {
      ...attempt.feedback,
      review: [...attempt.feedback.review].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
    } : null,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const evidence = { campaignId: campaign.campaignId, expected: [...campaign.expected].sort(),
    scope: campaign.accounting.scope, missingAttempts: campaign.accounting.missingAttempts, attempts };
  const canonical = (_key: string, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
  return createHash("sha256").update(JSON.stringify(evidence, canonical)).digest("hex");
}

export function feedbackReviewTemplate(campaign: RunnerE2ECampaign) {
  const feedback = summarizeCampaignFeedback(campaign.accounting?.attempts ?? campaign.results);
  return { version: 1, campaignId: campaign.campaignId, evidenceHash: campaignFeedbackEvidence(campaign),
    reviewedAt: null, reviewedBy: null,
    decisions: feedback.review.map(({ fingerprint }) => ({ fingerprint, disposition: "needs_investigation" })) };
}

export function validateCampaignFeedbackReview(campaign: RunnerE2ECampaign, review: CampaignFeedbackReview): void {
  const fail = (): never => { throw new Error("Invalid or stale campaign feedback review"); };
  const fields = (value: unknown, allowed: string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
  };
  fields(review, ["version", "campaignId", "evidenceHash", "reviewedAt", "reviewedBy", "decisions"]);
  if (review.version !== 1 || review.campaignId !== campaign.campaignId || review.evidenceHash !== campaignFeedbackEvidence(campaign)
      || !isPublicReportTimestamp(review.reviewedAt)
      || !["human", "agent"].includes(review.reviewedBy) || !Array.isArray(review.decisions)) fail();
  const groups = summarizeCampaignFeedback(campaign.accounting?.attempts ?? campaign.results).review;
  const expected = new Set(groups.map(group => group.fingerprint)), seen = new Set<string>();
  for (const decision of review.decisions) {
    fields(decision, ["fingerprint", "disposition", "duplicateOf", "issueNumber"]);
    if (!expected.has(decision.fingerprint) || seen.has(decision.fingerprint) || !dispositions.includes(decision.disposition)) fail();
    seen.add(decision.fingerprint);
    if (decision.issueNumber !== undefined && (!Number.isSafeInteger(decision.issueNumber) || decision.issueNumber < 1)) fail();
    if (decision.disposition === "duplicate") {
      if (!decision.duplicateOf || decision.duplicateOf === decision.fingerprint || !expected.has(decision.duplicateOf)
          || review.decisions.find(item => item.fingerprint === decision.duplicateOf)?.disposition === "duplicate") fail();
    } else if (decision.duplicateOf !== undefined) fail();
  }
  if (seen.size !== expected.size) fail();
}

export function campaignFeedbackReviewText(campaign: RunnerE2ECampaign): string {
  const feedback = summarizeCampaignFeedback(campaign.accounting?.attempts ?? campaign.results);
  const review = campaign.feedbackReview;
  if (!review) return `${feedback.review.length} distinct feedback items await review. Collection gaps and failed submissions remain separate findings.`;
  validateCampaignFeedbackReview(campaign, review);
  const count = (disposition: typeof dispositions[number]) => review.decisions.filter(item => item.disposition === disposition).length;
  return `Feedback reviewed by ${review.reviewedBy} at ${review.reviewedAt}: ${dispositions.map(value => `${count(value)} ${value.replaceAll("_", " ")}`).join("; ")}. ${feedback.incomplete} attempts have incomplete collection; review does not close these gaps or change product grades.`;
}

export function renderCampaignFeedbackReview(campaign: RunnerE2ECampaign): string {
  const summary = campaignFeedbackReviewText(campaign);
  const feedback = summarizeCampaignFeedback(campaign.accounting?.attempts ?? campaign.results);
  const rows = feedback.review.map(group => {
    const decision = campaign.feedbackReview?.decisions.find(item => item.fingerprint === group.fingerprint);
    return `<tr><td>${html(group.kind)}</td><td><code>${html(group.fingerprint)}</code></td><td>${group.occurrences}</td><td>${html(decision?.disposition ?? "unreviewed")}</td><td>${decision?.duplicateOf ? html(decision.duplicateOf) : ""}${decision?.issueNumber ? `<a href="https://github.com/paperclipai/paperclip/issues/${decision.issueNumber}">#${decision.issueNumber}</a>` : ""}</td></tr>`;
  }).join("");
  return `<section aria-label="Campaign feedback review"><h2>Campaign feedback review</h2><p>${html(summary)}</p><p>Full bodies and review rationale stay in private evidence. Exact duplicate bodies are grouped once; related causes can be linked by a reviewed duplicate disposition.</p>${rows ? `<div class="matcher-wrap" tabindex="0" role="region" aria-label="Feedback review decisions"><table><thead><tr><th>Kind</th><th>Fingerprint</th><th>Occurrences</th><th>Disposition</th><th>Follow-up</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}</section>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [campaignFile, outputFile] = process.argv.slice(2);
  if (!campaignFile || !outputFile) throw new Error("Usage: feedback-dispositions.ts <normalized-results.json> <private-review.json>");
  const campaign = JSON.parse(await readFile(campaignFile, "utf8")) as RunnerE2ECampaign;
  await writeFile(outputFile, `${JSON.stringify(feedbackReviewTemplate(campaign), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  console.log("Created an unreviewed template. Inspect private feedback bodies, fill dispositions and review metadata, then import with PAPERCLIP_E2E_FEEDBACK_REVIEW.");
}
