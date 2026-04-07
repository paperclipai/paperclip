/**
 * REQ-02: COO Quality Gate
 * REQ-03: Quality Examples Library
 *
 * Creates quality-gate approvals for agent outputs and records quality
 * examples in agent memory for future reference.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { approvals, agentMemoryEntries, issues } from "@ironworksai/db";
import { validateConfidenceTags } from "./confidence-tags.js";
import { recordCompletion } from "./workflow-maturity.js";
import { logger } from "../middleware/logger.js";

export interface QualityGateScore {
  qualityScore: number;
  verdict: "pass" | "fail" | "pass_with_notes";
  specMatch: number;
  confidenceTagScore: number;
  actionabilityScore: number;
  notes: string[];
}

/**
 * Creates a quality_gate approval record for a given issue.
 */
export async function createQualityGateReview(
  db: Db,
  companyId: string,
  issueId: string,
  producingAgentId: string,
): Promise<{ approvalId: string }> {
  const [row] = await db
    .insert(approvals)
    .values({
      companyId,
      type: "quality_gate",
      requestedByAgentId: producingAgentId,
      status: "pending",
      payload: { issueId, producingAgentId } as Record<string, unknown>,
    })
    .returning({ id: approvals.id });

  return { approvalId: row.id };
}

/**
 * Evaluates a quality gate approval. Computes a quality score 1-10.
 *
 * Scoring:
 *   - specMatch (0-4): Does the output meet the spec? Based on whether issue has a spec template.
 *   - confidenceTagScore (0-3): Are confidence tags present and well-distributed?
 *   - actionabilityScore (0-3): Is the output actionable (has clear next steps, deliverables)?
 */
export async function evaluateQualityGate(
  db: Db,
  approvalId: string,
): Promise<QualityGateScore> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));

  if (!approval) {
    throw new Error(`Approval ${approvalId} not found`);
  }

  const payload = approval.payload as Record<string, unknown>;
  const issueId = payload.issueId as string;
  const notes: string[] = [];

  // Fetch the issue for context
  const [issue] = await db
    .select()
    .from(issues)
    .where(eq(issues.id, issueId));

  // 1. Spec match (0-4)
  let specMatch = 2; // Default: neutral if no spec
  if (issue?.specTemplate) {
    const spec = issue.specTemplate as Record<string, unknown>;
    const hasGoal = !!spec.goal;
    const hasCriteria = !!spec.acceptance_criteria;
    const hasFormat = !!spec.output_format;
    specMatch = (hasGoal ? 1 : 0) + (hasCriteria ? 2 : 0) + (hasFormat ? 1 : 0);
    if (specMatch < 3) notes.push("Spec template is incomplete");
  } else {
    notes.push("No spec template provided - spec match scored neutrally");
  }

  // 2. Confidence tag score (0-3)
  // Check the issue description and any recent comments for tags
  let confidenceTagScore = 1; // Default baseline
  const textToCheck = issue?.description ?? "";
  if (textToCheck.length > 0) {
    const tagResult = validateConfidenceTags(textToCheck);
    if (tagResult.valid && tagResult.totalAssertions > 0) {
      confidenceTagScore = 3;
    } else if (tagResult.totalAssertions > 0 && tagResult.untaggedAssertions < tagResult.totalAssertions) {
      confidenceTagScore = 2;
      notes.push(`${tagResult.untaggedAssertions} of ${tagResult.totalAssertions} assertions lack confidence tags`);
    } else if (tagResult.totalAssertions > 0) {
      confidenceTagScore = 0;
      notes.push("No confidence tags found in output");
    }
  }

  // 3. Actionability score (0-3)
  let actionabilityScore = 2; // Assume reasonable by default
  if (issue?.description) {
    const desc = issue.description.toLowerCase();
    const hasNextSteps = /next steps?|action items?|deliverables?|follow[- ]up/i.test(desc);
    const hasConclusion = /conclusion|summary|recommendation/i.test(desc);
    actionabilityScore = hasNextSteps ? 3 : hasConclusion ? 2 : 1;
    if (actionabilityScore < 2) notes.push("Output lacks clear next steps or deliverables");
  }

  const qualityScore = specMatch + confidenceTagScore + actionabilityScore;
  const verdict: "pass" | "fail" | "pass_with_notes" =
    qualityScore >= 8 ? "pass" :
    qualityScore >= 5 ? "pass_with_notes" :
    "fail";

  return {
    qualityScore,
    verdict,
    specMatch,
    confidenceTagScore,
    actionabilityScore,
    notes,
  };
}

/**
 * REQ-03: Record a quality example in agent memory after quality gate decision.
 *
 * Good examples (score >= 8) are stored as positive references.
 * Bad examples (rejected) are stored as negative references with feedback.
 */
export async function recordQualityExample(
  db: Db,
  companyId: string,
  agentId: string,
  issueId: string,
  qualityScore: number,
  verdict: "pass" | "fail" | "pass_with_notes",
  feedback?: string,
): Promise<void> {
  try {
    if (verdict === "pass" && qualityScore >= 8) {
      await db.insert(agentMemoryEntries).values({
        agentId,
        companyId,
        memoryType: "quality_example",
        category: "good",
        content: JSON.stringify({
          type: "good",
          issueId,
          qualityScore,
          why: `Quality score ${qualityScore}/10 - passed quality gate`,
        }),
        sourceIssueId: issueId,
        confidence: 90,
      });
    } else if (verdict === "fail") {
      await db.insert(agentMemoryEntries).values({
        agentId,
        companyId,
        memoryType: "quality_example",
        category: "bad",
        content: JSON.stringify({
          type: "bad",
          issueId,
          qualityScore,
          feedback: feedback ?? "Failed quality gate review",
        }),
        sourceIssueId: issueId,
        confidence: 90,
      });
    }
  } catch (err) {
    logger.warn({ err, agentId, issueId }, "failed to record quality example in agent memory");
  }
}

/**
 * REQ-03: Retrieve recent quality examples for heartbeat context injection.
 * Returns 3 good + 3 bad examples (most recent first).
 */
export async function getQualityExamples(
  db: Db,
  agentId: string,
): Promise<{ good: string[]; bad: string[] }> {
  const goodExamples = await db
    .select({ content: agentMemoryEntries.content })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.memoryType, "quality_example"),
        eq(agentMemoryEntries.category, "good"),
      ),
    )
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(3);

  const badExamples = await db
    .select({ content: agentMemoryEntries.content })
    .from(agentMemoryEntries)
    .where(
      and(
        eq(agentMemoryEntries.agentId, agentId),
        eq(agentMemoryEntries.memoryType, "quality_example"),
        eq(agentMemoryEntries.category, "bad"),
      ),
    )
    .orderBy(desc(agentMemoryEntries.createdAt))
    .limit(3);

  return {
    good: goodExamples.map((r) => r.content),
    bad: badExamples.map((r) => r.content),
  };
}

/**
 * Full quality gate flow: evaluate, record example, update workflow maturity.
 */
export async function resolveQualityGate(
  db: Db,
  approvalId: string,
  decision: "approved" | "rejected",
  decisionNote: string | null,
  decidedByUserId: string,
): Promise<QualityGateScore> {
  const score = await evaluateQualityGate(db, approvalId);

  // Get approval details
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));

  if (!approval) throw new Error(`Approval ${approvalId} not found`);

  const payload = approval.payload as Record<string, unknown>;
  const issueId = payload.issueId as string;
  const producingAgentId = payload.producingAgentId as string;

  // Update approval status
  await db
    .update(approvals)
    .set({
      status: decision,
      decidedByUserId,
      decisionNote,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));

  // REQ-03: Record quality example
  const verdict = decision === "approved" ? score.verdict : "fail";
  await recordQualityExample(
    db,
    approval.companyId,
    producingAgentId,
    issueId,
    score.qualityScore,
    verdict,
    decisionNote ?? undefined,
  );

  // REQ-05: Update workflow maturity
  const passed = decision === "approved" && score.qualityScore >= 8;
  try {
    await recordCompletion(db, approval.companyId, "quality_gate", passed, score.qualityScore);
  } catch (err) {
    logger.warn({ err, approvalId }, "workflow maturity update failed after quality gate");
  }

  return score;
}
