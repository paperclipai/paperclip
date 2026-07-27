import { z } from "zod";
import type { JudgeInput, JudgeResult } from "./types.js";

export const judgeResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string().max(4000),
  criteriaResults: z.array(z.object({
    id: z.string(),
    met: z.boolean(),
    note: z.string().max(500),
  })).max(20),
  corrections: z.array(z.object({
    priority: z.enum(["must", "should"]),
    instruction: z.string().max(1000),
  })).max(10),
  hardFailure: z.boolean(),
  hardFailureReason: z.string().max(500).optional(),
});

export const JUDGE_SYSTEM_PROMPT = `You are the Paperclip Agent Manager judge. Score how well the agent's run output
meets the issue definition and acceptance criteria.

Return ONLY valid JSON matching the schema. Be strict on acceptance criteria;
lenient on style. Score 0-100 where 70+ means ship-ready for the stated scope.

Do not suggest permanent prompt changes. Suggest run-scoped corrections only.`;

export function parseJudgeResult(raw: unknown): JudgeResult | null {
  const parsed = judgeResultSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function buildJudgePrompt(input: JudgeInput): string {
  const criteria = input.acceptanceCriteria.length > 0
    ? input.acceptanceCriteria.map((entry) => `- ${entry.id}: ${entry.description}`).join("\n")
    : "(none extracted — use issue description)";

  const prior = input.priorReflections.length > 0
    ? input.priorReflections.map((entry) => `- attempt ${entry.attempt}: score ${entry.score ?? "n/a"} — ${entry.rationale ?? ""}`).join("\n")
    : "(none)";

  return `${JUDGE_SYSTEM_PROMPT}

## Issue
Title: ${input.issueTitle}
Status: ${input.issueStatus}
Description:
${input.issueDescription ?? "(empty)"}

## Acceptance criteria
${criteria}

## Run output summary
${input.runOutputSummary}

## Prior reflections
${prior}

Return JSON with keys: score, rationale, criteriaResults, corrections, hardFailure, hardFailureReason.`;
}

export function extractAcceptanceCriteriaFromFeatureSpec(body: string | null | undefined): Array<{ id: string; description: string }> {
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { acceptanceCriteria?: Array<{ id?: string; then?: string; given?: string; when?: string }> };
    if (!Array.isArray(parsed.acceptanceCriteria)) return [];
    return parsed.acceptanceCriteria
      .map((entry, index) => ({
        id: entry.id ?? `AC-${index + 1}`,
        description: [entry.given, entry.when, entry.then].filter(Boolean).join(" "),
      }))
      .filter((entry) => entry.description.length > 0);
  } catch {
    return [];
  }
}
