/**
 * REQ-05: Crawl-Walk-Run Workflow Maturity
 *
 * Tracks workflow maturity levels per company and workflow type.
 * Auto-promotes crawl->walk after 5 consecutive passes with score >= 8.
 * walk->run requires explicit user approval.
 */

import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { workflowMaturity } from "@ironworksai/db";
import { logger } from "../middleware/logger.js";

export type MaturityLevel = "crawl" | "walk" | "run";

export interface ReviewRequirements {
  maturityLevel: MaturityLevel;
  /** Whether human review is required. */
  humanReviewRequired: boolean;
  /** Whether automated quality gate check is required. */
  autoQualityGateRequired: boolean;
  /** How many reviewers are needed. */
  reviewerCount: number;
  /** Description of review depth. */
  description: string;
}

/**
 * Returns review requirements based on the current maturity level
 * for a given workflow type within a company.
 */
export async function getReviewRequirements(
  db: Db,
  companyId: string,
  workflowType: string,
): Promise<ReviewRequirements> {
  const [record] = await db
    .select()
    .from(workflowMaturity)
    .where(
      and(
        eq(workflowMaturity.companyId, companyId),
        eq(workflowMaturity.workflowType, workflowType),
      ),
    );

  const level: MaturityLevel = (record?.maturityLevel as MaturityLevel) ?? "crawl";

  switch (level) {
    case "crawl":
      return {
        maturityLevel: "crawl",
        humanReviewRequired: true,
        autoQualityGateRequired: true,
        reviewerCount: 2,
        description: "Full human review required. All outputs go through COO quality gate.",
      };
    case "walk":
      return {
        maturityLevel: "walk",
        humanReviewRequired: true,
        autoQualityGateRequired: true,
        reviewerCount: 1,
        description: "Single human reviewer with automated quality gate.",
      };
    case "run":
      return {
        maturityLevel: "run",
        humanReviewRequired: false,
        autoQualityGateRequired: true,
        reviewerCount: 0,
        description: "Automated quality gate only. Human review on exception.",
      };
  }
}

/**
 * Records a workflow completion and updates stats.
 * Auto-promotes crawl->walk after 5 consecutive passes with score >= 8.
 * walk->run is NOT auto-promoted; requires explicit user approval via promoteToRun().
 */
export async function recordCompletion(
  db: Db,
  companyId: string,
  workflowType: string,
  passed: boolean,
  qualityScore?: number,
): Promise<{ promoted: boolean; newLevel: MaturityLevel }> {
  // Upsert the workflow maturity record
  const [existing] = await db
    .select()
    .from(workflowMaturity)
    .where(
      and(
        eq(workflowMaturity.companyId, companyId),
        eq(workflowMaturity.workflowType, workflowType),
      ),
    );

  const now = new Date();

  if (!existing) {
    // Create new record
    await db.insert(workflowMaturity).values({
      companyId,
      workflowType,
      maturityLevel: "crawl",
      totalCompleted: 1,
      consecutivePasses: passed && (qualityScore ?? 0) >= 8 ? 1 : 0,
      rejectionsLast20: passed ? 0 : 1,
      createdAt: now,
      updatedAt: now,
    });
    return { promoted: false, newLevel: "crawl" };
  }

  // Update existing record
  const newConsecutive = passed && (qualityScore ?? 0) >= 8
    ? existing.consecutivePasses + 1
    : 0;

  const newTotal = existing.totalCompleted + 1;
  const newRejections = passed
    ? Math.max(0, existing.rejectionsLast20 - (newTotal > 20 ? 1 : 0))
    : Math.min(20, existing.rejectionsLast20 + 1);

  const currentLevel = existing.maturityLevel as MaturityLevel;
  let promoted = false;
  let newLevel = currentLevel;

  // Auto-promote crawl->walk after 5 consecutive passes with score >= 8
  if (currentLevel === "crawl" && newConsecutive >= 5) {
    newLevel = "walk";
    promoted = true;
    logger.info(
      { companyId, workflowType, consecutivePasses: newConsecutive },
      "[workflow-maturity] Auto-promoting crawl -> walk",
    );
  }

  await db
    .update(workflowMaturity)
    .set({
      totalCompleted: newTotal,
      consecutivePasses: newConsecutive,
      rejectionsLast20: newRejections,
      maturityLevel: newLevel,
      ...(promoted ? { promotedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(workflowMaturity.id, existing.id));

  return { promoted, newLevel };
}

/**
 * Explicitly promote a workflow from walk->run. Requires user action.
 */
export async function promoteToRun(
  db: Db,
  companyId: string,
  workflowType: string,
  userId: string,
): Promise<{ success: boolean; message: string }> {
  const [record] = await db
    .select()
    .from(workflowMaturity)
    .where(
      and(
        eq(workflowMaturity.companyId, companyId),
        eq(workflowMaturity.workflowType, workflowType),
      ),
    );

  if (!record) {
    return { success: false, message: "No workflow maturity record found" };
  }

  if (record.maturityLevel !== "walk") {
    return {
      success: false,
      message: `Cannot promote from "${record.maturityLevel}" to "run". Must be at "walk" level.`,
    };
  }

  const now = new Date();
  await db
    .update(workflowMaturity)
    .set({
      maturityLevel: "run",
      promotedAt: now,
      promotedByUserId: userId,
      updatedAt: now,
    })
    .where(eq(workflowMaturity.id, record.id));

  logger.info(
    { companyId, workflowType, userId },
    "[workflow-maturity] User promoted walk -> run",
  );

  return { success: true, message: "Workflow promoted to run level" };
}
