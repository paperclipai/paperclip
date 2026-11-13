import { and, eq, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { RECOVERY_WAKE_REASONS } from "./heartbeat/queued-run-dispatch-order.js";

/**
 * System recovery joins an agent's queue a few runs at a time. The rest stays
 * pending with its producer (a resolved recovery action), which delivers the
 * next one when a queued recovery run starts or is dropped. Recovery waits
 * behind people's work in the dispatcher, so a deep recovery queue would only
 * hold stale runs; pending recovery is re-read when it is admitted instead.
 */
export const QUEUED_RECOVERY_RUNS_PER_AGENT = 3;

/**
 * Evidence keys under which a restored task records the wake it is owed
 * (legacy-workspace rehome, released workspace writer). While its assignee's
 * recovery queue is full, that wake waits pending here.
 */
export const HELD_RECOVERY_WAKE_KEYS = ["legacyWorkspaceRehome", "releasedWorkspaceWriter"] as const;

/** Queued recovery runs of `agentId`, as SQL on a `heartbeat_runs` alias. */
export function queuedRecoveryRunsOf(companyId: SQL | string, agentId: SQL | string) {
  const reasons = sql.join([...RECOVERY_WAKE_REASONS].map(reason => sql`${reason}`), sql`, `);
  return sql`select 1 from ${heartbeatRuns} queued_recovery
    where queued_recovery.company_id = ${companyId} and queued_recovery.agent_id = ${agentId}
      and queued_recovery.status = 'queued' and queued_recovery.context_snapshot->>'wakeReason' in (${reasons})`;
}

/**
 * A soft cap, read before the producer's wake: producers that run at the same
 * moment can each see room, so the queue can briefly hold one more run per
 * concurrent producer (two today: continuation delivery and restored-task
 * wakes). That stays "a few at a time"; the dispatcher keeps every recovery
 * run behind people's work and re-checks it before it starts.
 */
export async function agentRecoveryQueueIsFull(db: Db, companyId: string, agentId: string) {
  const reasons = [...RECOVERY_WAKE_REASONS];
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"),
    sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' in (${sql.join(reasons.map(reason => sql`${reason}`), sql`, `)})`));
  return Number(row?.count ?? 0) >= QUEUED_RECOVERY_RUNS_PER_AGENT;
}
