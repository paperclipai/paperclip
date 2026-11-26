import { and, eq, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, statusDecisions, type Db } from "@paperclipai/db";
import { EXTERNAL_CHAT_RESPONSE_WAIT_AUTHORIZATION_LOST } from "./status-arbiter.js";

type RunBinding = { companyId: string; issueId: string; runId: string };

/**
 * A run of the same task created at or after the given run, in any state. A
 * queued or admitted run owns the task's next step even before it records a
 * decision. Compared in SQL: run timestamps keep microseconds that a Date drops.
 */
export async function hasNewerIssueRun(db: Db, binding: RunBinding): Promise<boolean> {
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, binding.companyId), ne(heartbeatRuns.id, binding.runId),
    sql`${heartbeatRuns.createdAt} >= (select own_run.created_at from heartbeat_runs own_run
      where own_run.id = ${binding.runId} and own_run.company_id = ${binding.companyId})`,
    or(eq(heartbeatRuns.issueId, binding.issueId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${binding.issueId}`),
  )).limit(1);
  return Boolean(newer);
}

/**
 * The heartbeat settles a run and releases its task execution independently
 * of the run's native finalizer. When the finalizer's first status commit
 * loses a race, its scheduled retry applies the same saved result after the
 * run is already settled. That run still owns its response wait while no
 * other run owns the task: either its own saved result is still being
 * applied, or its committed decision recorded only that the wait authority
 * was lost. The caller still checks the assignee, the agent, and current
 * principal and destination policy.
 */
export async function settledRunOwnsResponseWait(
  tx: Db,
  binding: RunBinding,
  runStatus: string,
  issue: { executionRunId: string | null; checkoutRunId: string | null },
): Promise<boolean> {
  if (!["running", "succeeded"].includes(runStatus)) return false;
  if ((issue.executionRunId && issue.executionRunId !== binding.runId) ||
    (issue.checkoutRunId && issue.checkoutRunId !== binding.runId)) return false;
  const [coordinator] = await tx.select({
    phase: nativeRunFinalizations.phase,
    resultId: nativeRunFinalizations.resultId,
    decisionId: nativeRunFinalizations.decisionId,
  }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, binding.runId),
    eq(nativeRunFinalizations.companyId, binding.companyId),
    eq(nativeRunFinalizations.issueId, binding.issueId),
  )).limit(1);
  if (!coordinator?.resultId || coordinator.phase === "terminal_failure") return false;
  if (await hasNewerIssueRun(tx, binding)) return false;
  if (coordinator.phase !== "committed") return true;
  if (!coordinator.decisionId) return false;
  const [decision] = await tx.select({ reasonCode: statusDecisions.reasonCode }).from(statusDecisions)
    .where(and(eq(statusDecisions.id, coordinator.decisionId), eq(statusDecisions.companyId, binding.companyId),
      eq(statusDecisions.issueId, binding.issueId), eq(statusDecisions.runId, binding.runId),
      eq(statusDecisions.applicationState, "applied"))).limit(1);
  return decision?.reasonCode === EXTERNAL_CHAT_RESPONSE_WAIT_AUTHORIZATION_LOST;
}
