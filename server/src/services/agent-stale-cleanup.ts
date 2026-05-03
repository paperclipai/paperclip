import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/** Time threshold for considering an agent "stuck" in running status (10 minutes). */
const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

/** Time threshold before auto-recovering an agent from error status (5 minutes). */
const ERROR_RECOVERY_THRESHOLD_MS = 5 * 60 * 1000;

/** Interval between cleanup sweeps (default: 2 minutes). */
const DEFAULT_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Reset agents that are stuck in "running" or "error" status.
 *
 * Running agents are considered stuck if they have no active heartbeat runs
 * and have been in that state for more than STALE_RUNNING_THRESHOLD_MS.
 *
 * Error agents are auto-recovered to idle if they have been in error status
 * for more than ERROR_RECOVERY_THRESHOLD_MS. Most agent errors are transient
 * (adapter crashes, permission denials, timeouts) and the next heartbeat
 * should get a fresh attempt. Agents paused or terminated by governance
 * are excluded.
 */
export async function resetStaleRunningAgents(db: Db): Promise<number> {
  const runningCutoff = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS);
  const errorCutoff = new Date(Date.now() - ERROR_RECOVERY_THRESHOLD_MS);

  const stuckAgents = await db
    .select({
      agentId: agents.id,
      companyId: agents.companyId,
      agentName: agents.name,
      status: agents.status,
      lastUpdated: agents.updatedAt,
    })
    .from(agents)
    .where(
      and(
        inArray(agents.status, ["running", "error"]),
        lt(agents.updatedAt, runningCutoff),
      ),
    );

  if (stuckAgents.length === 0) {
    return 0;
  }

  let resetCount = 0;

  for (const agent of stuckAgents) {
    try {
      if (agent.status === "running") {
        const activeRuns = await db
          .select({ count: sql<number>`count(*)` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agent.agentId),
              eq(heartbeatRuns.status, "running"),
            ),
          );

        const hasActiveRuns = Number(activeRuns[0]?.count ?? 0) > 0;

        if (hasActiveRuns) {
          await db
            .update(agents)
            .set({ updatedAt: new Date() })
            .where(eq(agents.id, agent.agentId));
          continue;
        }
      }

      if (agent.status === "error" && agent.lastUpdated > errorCutoff) {
        continue;
      }

      await db
        .update(agents)
        .set({
          status: "idle",
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.agentId));

      logger.info(
        {
          agentId: agent.agentId,
          companyId: agent.companyId,
          agentName: agent.agentName,
          previousStatus: agent.status,
          lastUpdated: agent.lastUpdated,
        },
        `Auto-reset agent from "${agent.status}" to "idle"`,
      );

      resetCount++;
    } catch (err) {
      logger.error(
        { err, agentId: agent.agentId, agentName: agent.agentName },
        "Failed to reset stuck agent status",
      );
    }
  }

  if (resetCount > 0) {
    logger.info({ resetCount, checkedCount: stuckAgents.length }, "Stale agent cleanup completed");
  }

return resetCount;
}

/**
 * Start periodic stale agent cleanup.
 *
 * @param db - Database connection
 * @param intervalMs - How often to run the cleanup (default: 2 minutes)
 * @returns A cleanup function that stops the interval
 */
export function startStaleAgentCleanup(
  db: Db,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    resetStaleRunningAgents(db).catch((err) => {
      logger.error({ err }, "Stale agent cleanup sweep failed");
    });
  }, intervalMs);

  // Run once immediately on startup
  resetStaleRunningAgents(db).catch((err) => {
    logger.error({ err }, "Initial stale agent cleanup failed");
  });

  return () => clearInterval(timer);
}
