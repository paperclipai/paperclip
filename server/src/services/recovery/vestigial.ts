import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

export type VestigialReason = "parent_cancelled" | "superseded" | "duplicate_resolved";

export interface VestigialDetectionResult {
  reason: VestigialReason;
  details: Record<string, unknown>;
}

/**
 * Checks whether an issue is effectively dead work and should not be retried.
 *
 * Three signals are evaluated in order:
 *   1. Cancelled parent — parent issue has status `cancelled`.
 *   2. Superseded — the issue's `supersededById` points to a `done` issue.
 *   3. Fingerprint dedup — another `done` issue shares the same `originFingerprint`
 *      in the same (companyId, projectId, goalId) scope.
 *
 * Returns the first matching signal, or null if the issue is not vestigial.
 */
export async function checkVestigialIssue(
  db: Db,
  issue: typeof issues.$inferSelect,
): Promise<VestigialDetectionResult | null> {
  // Check 1: cancelled parent
  if (issue.parentId) {
    const parent = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.parentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (parent?.status === "cancelled") {
      return {
        reason: "parent_cancelled",
        details: { parentId: issue.parentId },
      };
    }
  }

  // Check 2: superseded by a done issue
  if (issue.supersededById) {
    const superseder = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.supersededById))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (superseder?.status === "done") {
      return {
        reason: "superseded",
        details: { supersededById: issue.supersededById },
      };
    }
  }

  // Check 3: fingerprint dedup — another done issue with the same origin fingerprint
  // in the same (projectId, goalId) scope. Skip if fingerprint is the default sentinel
  // or if the issue has no project/goal scope.
  if (
    issue.originFingerprint !== "default" &&
    (issue.projectId !== null || issue.goalId !== null)
  ) {
    const duplicate = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.originFingerprint, issue.originFingerprint),
          eq(issues.status, "done"),
          // NULL-safe equality for projectId scope
          issue.projectId !== null
            ? eq(issues.projectId, issue.projectId)
            : isNull(issues.projectId),
          // NULL-safe equality for goalId scope
          issue.goalId !== null
            ? eq(issues.goalId, issue.goalId)
            : isNull(issues.goalId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // The stalled issue is never `done`, so any match is a distinct duplicate.
    if (duplicate) {
      return {
        reason: "duplicate_resolved",
        details: {
          duplicateIssueId: duplicate.id,
          originFingerprint: issue.originFingerprint,
        },
      };
    }
  }

  return null;
}
