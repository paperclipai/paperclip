import { and, eq, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRelations, issues } from "@paperclipai/db";

export type VestigialSignal =
  | { kind: "parent_cancelled"; parentId: string; parentIdentifier: string | null }
  | { kind: "superseded"; supersedingIssueId: string; supersedingIdentifier: string | null }
  | { kind: "duplicate_resolved"; duplicateIssueId: string; duplicateIdentifier: string | null };

export type VestigialIssueInput = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "parentId" | "originFingerprint" | "projectId" | "goalId"
>;

/**
 * Checks three signals that indicate an issue is vestigial dead work:
 * 1. parent_cancelled  — parentId is set and parent has status "cancelled"
 * 2. superseded        — a superseded_by relation points to a done issue
 * 3. duplicate_resolved — originFingerprint matches a done issue in the same project/goal scope
 *
 * Returns the first matching signal, or null when none match.
 * The fingerprint check is skipped for the default "default" fingerprint.
 */
export async function checkVestigialSignals(
  db: Db,
  issue: VestigialIssueInput,
): Promise<VestigialSignal | null> {
  // Signal 1: Cancelled parent
  if (issue.parentId) {
    const parent = await db
      .select({ id: issues.id, status: issues.status, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.id, issue.parentId), eq(issues.companyId, issue.companyId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (parent?.status === "cancelled") {
      return {
        kind: "parent_cancelled",
        parentId: parent.id,
        parentIdentifier: parent.identifier,
      };
    }
  }

  // Signal 2: superseded_by relation pointing to a done issue
  const supersedingDone = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issueRelations)
    .innerJoin(
      issues,
      and(
        eq(issues.id, issueRelations.relatedIssueId),
        eq(issues.status, "done"),
      ),
    )
    .where(
      and(
        eq(issueRelations.companyId, issue.companyId),
        eq(issueRelations.issueId, issue.id),
        eq(issueRelations.type, "superseded_by"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (supersedingDone) {
    return {
      kind: "superseded",
      supersedingIssueId: supersedingDone.id,
      supersedingIdentifier: supersedingDone.identifier,
    };
  }

  // Signal 3: originFingerprint dedup — same fingerprint, same project+goal scope, done
  if (issue.originFingerprint && issue.originFingerprint !== "default") {
    const duplicate = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.originFingerprint, issue.originFingerprint),
          eq(issues.status, "done"),
          ne(issues.id, issue.id),
          issue.projectId ? eq(issues.projectId, issue.projectId) : isNull(issues.projectId),
          issue.goalId ? eq(issues.goalId, issue.goalId) : isNull(issues.goalId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (duplicate) {
      return {
        kind: "duplicate_resolved",
        duplicateIssueId: duplicate.id,
        duplicateIdentifier: duplicate.identifier,
      };
    }
  }

  return null;
}
