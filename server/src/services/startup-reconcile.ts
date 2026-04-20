import { and, eq, lt, isNull, not, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Grace window: runs that started within this many milliseconds of server boot
 * are allowed to still be "running" — they may belong to a prior process that
 * is legitimately still alive (e.g. during a rolling restart). Runs older than
 * this window are considered orphaned and are failed.
 */
export const RECONCILE_GRACE_MS = 2 * 60 * 1000; // 2 minutes

export interface ReconcileResult {
  heartbeatRunsReset: number;
  agentsReset: number;
}

/**
 * Idempotent startup reconciliation: marks any heartbeat_runs that are stuck
 * in status='running' and started more than RECONCILE_GRACE_MS ago as
 * 'failed', then resets agents whose only active run was one of those orphans
 * back to 'idle'.
 *
 * This handles the case where docker-server-1 was killed mid-run and the
 * in-flight rows were never cleaned up.
 *
 * Should be called once after the DB connection is ready, before the server
 * begins serving traffic. Completes in <2 s even with thousands of rows
 * because both operations are single UPDATE … WHERE statements (no row-by-row
 * iteration).
 */
export async function reconcileStuckRunsOnStartup(db: Db): Promise<ReconcileResult> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - RECONCILE_GRACE_MS);

  // ------------------------------------------------------------------
  // 1. Fail every heartbeat_run that is stuck in 'running' and whose
  //    started_at is older than the grace window (or NULL, which means
  //    it never properly started).
  // ------------------------------------------------------------------
  const failedRuns = await db
    .update(heartbeatRuns)
    .set({
      status: "failed",
      error: "Reconciled on server start — process lost",
      finishedAt: now,
      exitCode: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        or(
          lt(heartbeatRuns.startedAt, cutoff),
          isNull(heartbeatRuns.startedAt),
        ),
      ),
    )
    .returning({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId });

  const heartbeatRunsReset = failedRuns.length;

  // ------------------------------------------------------------------
  // 2. Collect the set of agent IDs that now have at least one still-
  //    active (queued or running) heartbeat run. Agents in this set
  //    should NOT be reset — they have legitimate work in progress.
  // ------------------------------------------------------------------
  const activeRunRows = await db
    .select({ agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(inArray(heartbeatRuns.status, ["queued", "running"]));

  const activeAgentIds = new Set(activeRunRows.map((r) => r.agentId));

  // ------------------------------------------------------------------
  // 3. Reset agents that are stuck in 'running' but have no active run.
  // ------------------------------------------------------------------
  let agentsReset = 0;

  if (activeAgentIds.size > 0) {
    const updatedAgents = await db
      .update(agents)
      .set({ status: "idle", updatedAt: now })
      .where(
        and(
          eq(agents.status, "running"),
          not(inArray(agents.id, Array.from(activeAgentIds))),
        ),
      )
      .returning({ id: agents.id });
    agentsReset = updatedAgents.length;
  } else {
    // No active runs at all — reset every stuck agent.
    const updatedAgents = await db
      .update(agents)
      .set({ status: "idle", updatedAt: now })
      .where(eq(agents.status, "running"))
      .returning({ id: agents.id });
    agentsReset = updatedAgents.length;
  }

  logger.info(
    { heartbeatRunsReset, agentsReset },
    `[reconcile] reset ${heartbeatRunsReset} stuck heartbeat_runs, ${agentsReset} agents`,
  );

  return { heartbeatRunsReset, agentsReset };
}
