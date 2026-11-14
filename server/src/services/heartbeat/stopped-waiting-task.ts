import { and, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

type StoppedRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "status" | "startedAt" | "contextSnapshot">;

const LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

/**
 * A person pressed Stop on a task whose run was still waiting in line. The run
 * never started, so nothing is working on the task any more: an `in_progress`
 * task goes back to `todo` instead of looking busy. The write is guarded so it
 * never touches a task another run (or a person) has picked up meanwhile.
 * Recovery already stands down for an operator-cancelled run, so this does not
 * start or promote another run for the task.
 */
export async function returnStoppedWaitingTaskToTodo(
  db: Db,
  run: StoppedRun,
  actor: { userId: string | null },
): Promise<{ issueId: string } | null> {
  if (run.status !== "cancelled" || run.startedAt) return null;
  const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
  if (!issueId) return null;
  // Publish only after the status change commits, so a viewer that refreshes
  // on the event reads the new status.
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (tx) => {
    const otherLiveRun = tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId),
      inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
    ));
    const [updated] = await tx.update(issues).set({
      status: "todo",
      checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
      executionRunId: null,
      executionLockedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(issues.companyId, run.companyId),
      eq(issues.id, issueId),
      eq(issues.status, "in_progress"),
      eq(issues.assigneeAgentId, run.agentId),
      isNull(issues.assigneeUserId),
      or(isNull(issues.executionRunId), eq(issues.executionRunId, run.id)),
      notExists(otherLiveRun),
    )).returning({ id: issues.id });
    if (!updated) return null;
    await logActivity(tx as unknown as Db, {
      companyId: run.companyId,
      actorType: "user",
      actorId: actor.userId ?? "board",
      action: "issue.updated",
      entityType: "issue",
      entityId: updated.id,
      agentId: run.agentId,
      runId: run.id,
      details: { status: "todo", previousStatus: "in_progress", reason: "stopped_while_waiting", _previous: { status: "in_progress" } },
    }, publications);
    return { issueId: updated.id };
  });
  publications.forEach(publishActivity);
  return result;
}
