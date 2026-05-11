import { SERVICE_CATEGORY_LABELS } from "@paperclipai/govbids";
import type { ScoredOpportunity } from "@paperclipai/govbids";

/**
 * Build a Markdown description for a Paperclip issue from a scored opportunity.
 */
export function buildIssueDescription(opp: ScoredOpportunity): string {
  const parts = [
    `## ${opp.title}`,
    "",
    `**Agency:** ${opp.agency}`,
    `**State:** ${opp.state ?? "Not specified"}`,
    `**Estimated Value:** ${opp.estimatedValue ? `$${opp.estimatedValue.toLocaleString()}` : "Not specified"}`,
    `**Due Date:** ${opp.dueDate ? new Date(opp.dueDate).toLocaleDateString() : "Not specified"}`,
    `**NAICS:** ${opp.naicsCode ?? "N/A"} | **PSC:** ${opp.pscCode ?? "N/A"}`,
    `**Set-Aside:** ${opp.setAsideType ?? "None"}`,
    "",
    `### Qualification Score: ${opp.score}/100`,
    "",
    `| Dimension | Score |`,
    `|-----------|-------|`,
    `| Service Alignment | ${opp.scoreBreakdown.serviceAlignment}/40 |`,
    `| Bid Readiness | ${opp.scoreBreakdown.bidReadiness}/20 |`,
    `| Competitive Position | ${opp.scoreBreakdown.competitivePosition}/20 |`,
    `| Value Fit | ${opp.scoreBreakdown.valueFit}/20 |`,
    "",
    `**Category:** ${SERVICE_CATEGORY_LABELS[opp.serviceCategory] ?? opp.serviceCategory}`,
    `**Reasoning:** ${opp.reasoning}`,
  ];

  if (opp.disqualifiers.length > 0) {
    parts.push("", `**Flags:** ${opp.disqualifiers.join(", ")}`);
  }

  if (opp.sourceUrl) {
    parts.push("", `**[View on HigherGov](${opp.sourceUrl})**`);
  }

  parts.push(
    "",
    "---",
    "",
    "### Description",
    "",
    opp.description.slice(0, 2000),
  );

  return parts.join("\n");
}

/**
 * Map a qualification score to a Paperclip issue priority.
 */
export function scoreToPriority(
  score: number,
): "critical" | "high" | "medium" | "low" {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  return "low";
}
