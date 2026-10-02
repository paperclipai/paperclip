import { choice } from "@typesafe-ai/sdk";

export const JEV_ISSUE_LANE_MODEL = "jev-1.13.0";
export const JEV_ISSUE_LANE_POLICY_VERSION = "tyr-issue-lanes-v1";

export const JEV_ISSUE_LANES = {
  engineering:
    "Paperclip or TYR-X software implementation, tests, debugging, infrastructure code, or technical documentation.",
  provider:
    "External AI provider integration, model access, provider credentials, quotas, routing, or provider reliability.",
  studio:
    "Studio, visual design, brand, media, creative production, or content work.",
  needs_review:
    "Ambiguous, strategic, cross-lane, governed, or insufficiently specified work that XO should review.",
  no_match:
    "The summary does not belong to any supported issue lane.",
} as const;

export type JevIssueLane = keyof typeof JEV_ISSUE_LANES;

export const JEV_ISSUE_LANE_QUESTIONS = {
  issue_lane: choice(
    "Suggest exactly one issue lane. This is advisory shadow output only; do not infer authority or workflow actions.",
    JEV_ISSUE_LANES,
  ),
} as const;

export const JEV_ISSUE_LANE_RULES = {
  minimumConfidence: 0.6,
  lowConfidenceOutcome: "needs_review" as const,
  maximumSummaryCharacters: 800,
  timeoutMs: 1_500,
  maximumRetries: 1,
} as const;

/**
 * Only summaries in this registry may leave Paperclip. Entries must be manually
 * reviewed, contain no identifiers or restricted data, and describe only the
 * minimum facts needed for lane classification. Raw issue fields are never a
 * fallback. The initial entries are synthetic trial cases, so enabling the
 * feature does not send existing company issues to TypeSafe.
 */
export const JEV_APPROVED_ISSUE_SUMMARIES: Readonly<Record<string, string>> = {
  "JEV-TRIAL-ENGINEERING":
    "Implement a server-side retry guard and add focused unit tests for the control plane.",
  "JEV-TRIAL-PROVIDER":
    "Investigate an external model provider timeout and verify bounded retry behavior.",
  "JEV-TRIAL-STUDIO":
    "Create a visual layout and final brand assets for a Studio launch page.",
  "JEV-TRIAL-AMBIGUOUS":
    "Decide how a cross-team initiative should proceed when ownership and outcome are unclear.",
  "JEV-TRIAL-NO-MATCH":
    "Organize a voluntary team lunch for next month.",
};

export function approvedJevIssueSummary(identifier: string): string | null {
  return JEV_APPROVED_ISSUE_SUMMARIES[identifier] ?? null;
}
