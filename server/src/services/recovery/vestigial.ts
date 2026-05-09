import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

type VestigialIssue = typeof issues.$inferSelect;
type VestigialRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;

export type VestigialResult = {
  reason: "parent_cancelled" | "superseded" | "duplicate_resolved";
};

export async function checkVestigialIssue(
  db: Db,
  issue: VestigialIssue,
  latestRun?: VestigialRun | null,
): Promise<VestigialResult | null> {
  if (issue.parentId) {
    const parent = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.parentId))
      .then((rows) => rows[0] ?? null);

    if (parent?.status === "cancelled") {
      await suppressVestigialIssue(db, issue, latestRun, "parent_cancelled");
      return { reason: "parent_cancelled" };
    }
  }

  if (issue.supersededById) {
    const superseder = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issue.supersededById))
      .then((rows) => rows[0] ?? null);

    if (superseder?.status === "done") {
      await suppressVestigialIssue(db, issue, latestRun, "superseded");
      return { reason: "superseded" };
    }
  }

  if (issue.originFingerprint !== "default") {
    const duplicate = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          issue.projectId ? eq(issues.projectId, issue.projectId) : isNull(issues.projectId),
          issue.goalId ? eq(issues.goalId, issue.goalId) : isNull(issues.goalId),
          eq(issues.originFingerprint, issue.originFingerprint),
          eq(issues.status, "done"),
          ne(issues.id, issue.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (duplicate) {
      await suppressVestigialIssue(db, issue, latestRun, "duplicate_resolved");
      return { reason: "duplicate_resolved" };
    }
  }

  return null;
}

async function suppressVestigialIssue(
  db: Db,
  issue: VestigialIssue,
  latestRun: VestigialRun | null | undefined,
  reason: VestigialResult["reason"],
) {
  logger.warn(
    { issueId: issue.id, companyId: issue.companyId, reason },
    "vestigial issue detected; cancelling",
  );

  if (latestRun) {
    const [seqRow] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, latestRun.id));
    const seq = Number(seqRow?.maxSeq ?? 0) + 1;

    await db.insert(heartbeatRunEvents).values({
      companyId: latestRun.companyId,
      runId: latestRun.id,
      agentId: latestRun.agentId,
      seq,
      eventType: "vestigial_issue_detected",
      stream: "system",
      level: "warn",
      message: `Issue is vestigial (${reason}); cancelling`,
      payload: { issueId: issue.id, reason },
    });
  }

  await db
    .update(issues)
    .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(issues.id, issue.id), notInArray(issues.status, ["done", "cancelled"])));
}
