import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { enrichmentStaging } from "@paperclipai/db";

/**
 * A staging row is surfaced to reviewers as "flagged" when its anomaly score is
 * present and at or above this threshold. The persisted model carries no
 * `is_flagged` column, so flagging is derived here from `anomaly_score` and this
 * single source-of-truth constant.
 */
export const FLAG_THRESHOLD = 0.5;

export interface EnrichmentBatchSummary {
  batchId: string;
  rowCount: number;
  flaggedCount: number;
  approvedCount: number;
}

/**
 * The reviewer identity recorded on an approve/reject. This is the acting
 * agent or user id from the authenticated actor, never a request-body value.
 */
export type EnrichmentReviewer = string;

export function enrichmentService(db: Db) {
  // A row is flagged when it has an anomaly score at or above the threshold.
  const flaggedCondition: SQL = sql`${enrichmentStaging.anomalyScore} is not null and ${enrichmentStaging.anomalyScore} >= ${FLAG_THRESHOLD}`;
  // The inverse: unscored rows count as clean, so bulk-approve leaves flagged rows alone.
  const cleanCondition: SQL = sql`(${enrichmentStaging.anomalyScore} is null or ${enrichmentStaging.anomalyScore} < ${FLAG_THRESHOLD})`;

  async function listBatches(companyId: string): Promise<EnrichmentBatchSummary[]> {
    return db
      .select({
        batchId: enrichmentStaging.batchId,
        rowCount: sql<number>`count(*)::int`,
        flaggedCount: sql<number>`sum(case when ${flaggedCondition} then 1 else 0 end)::int`,
        approvedCount: sql<number>`sum(case when ${enrichmentStaging.humanApprovedAt} is not null then 1 else 0 end)::int`,
      })
      .from(enrichmentStaging)
      .where(eq(enrichmentStaging.companyId, companyId))
      .groupBy(enrichmentStaging.batchId)
      .orderBy(enrichmentStaging.batchId);
  }

  async function listStagingRows(
    companyId: string,
    batchId: string,
    options: { flaggedOnly?: boolean } = {},
  ) {
    const conditions: SQL[] = [
      eq(enrichmentStaging.companyId, companyId),
      eq(enrichmentStaging.batchId, batchId),
    ];
    if (options.flaggedOnly) conditions.push(flaggedCondition);
    return db
      .select()
      .from(enrichmentStaging)
      .where(and(...conditions))
      .orderBy(sql`${enrichmentStaging.anomalyScore} desc nulls last`, enrichmentStaging.id);
  }

  /**
   * Compare-and-set approve. The `companyId` guard is part of the WHERE clause,
   * so a caller can never reach another company's rows even with a leaked id;
   * `humanApprovedAt IS NULL` makes the review a one-shot decision. Returns the
   * updated row, or `null` when nothing changed (missing / foreign / reviewed).
   */
  async function approveRow(companyId: string, id: string, reviewer: EnrichmentReviewer) {
    const [updated] = await db
      .update(enrichmentStaging)
      .set({
        humanApprovedAt: new Date(),
        humanApprovedBy: reviewer,
        reviewerVerdict: "approved",
      })
      .where(
        and(
          eq(enrichmentStaging.id, id),
          eq(enrichmentStaging.companyId, companyId),
          isNull(enrichmentStaging.humanApprovedAt),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /** Compare-and-set reject; same isolation and one-shot guards as `approveRow`. */
  async function rejectRow(
    companyId: string,
    id: string,
    reviewer: EnrichmentReviewer,
    reason?: string,
  ) {
    const verdict = reason?.trim() ? `rejected: ${reason.trim()}` : "rejected";
    const [updated] = await db
      .update(enrichmentStaging)
      .set({
        humanApprovedAt: new Date(),
        humanApprovedBy: reviewer,
        reviewerVerdict: verdict,
      })
      .where(
        and(
          eq(enrichmentStaging.id, id),
          eq(enrichmentStaging.companyId, companyId),
          isNull(enrichmentStaging.humanApprovedAt),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Approve every clean (unflagged), unreviewed row in a company's batch. Flagged
   * rows are intentionally left for individual review. Returns the number of rows
   * approved.
   */
  async function bulkApproveBatch(companyId: string, batchId: string, reviewer: EnrichmentReviewer) {
    const updated = await db
      .update(enrichmentStaging)
      .set({
        humanApprovedAt: new Date(),
        humanApprovedBy: reviewer,
        reviewerVerdict: "approved",
      })
      .where(
        and(
          eq(enrichmentStaging.companyId, companyId),
          eq(enrichmentStaging.batchId, batchId),
          isNull(enrichmentStaging.humanApprovedAt),
          cleanCondition,
        ),
      )
      .returning({ id: enrichmentStaging.id });
    return updated.length;
  }

  return { listBatches, listStagingRows, approveRow, rejectRow, bulkApproveBatch };
}
