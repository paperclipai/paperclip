import { and, eq, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

export type NativeRunBinding = { companyId: string; issueId: string; runId: string };

/**
 * A run of the same task created at or after the given run, in any state. A
 * queued or admitted run owns the task's next step even before it records a
 * decision. Compared in SQL: run timestamps keep microseconds that a Date drops.
 */
export async function hasNewerIssueRun(db: Db, binding: NativeRunBinding): Promise<boolean> {
  const [newer] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, binding.companyId), ne(heartbeatRuns.id, binding.runId),
    sql`${heartbeatRuns.createdAt} >= (select own_run.created_at from heartbeat_runs own_run
      where own_run.id = ${binding.runId} and own_run.company_id = ${binding.companyId})`,
    or(eq(heartbeatRuns.issueId, binding.issueId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${binding.issueId}`),
  )).limit(1);
  return Boolean(newer);
}
