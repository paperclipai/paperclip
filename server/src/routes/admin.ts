import { Router, type Request } from "express";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { heartbeatService } from "../services/index.js";

const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;

function assertBoard(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export function adminRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db as any);

  /**
   * Clear stale executionRunId/executionLockedAt locks on issues where the
   * referenced run no longer exists or is in a terminal state.
   *
   * Safe to call at any time; does not touch running/queued runs.
   */
  router.post("/admin/cleanup-stale-locks", async (req, res) => {
    assertBoard(req);

    // Reap any running runs whose processes have disappeared, releasing their
    // issue execution locks in the process.
    const reaped = await heartbeat.reapOrphanedRuns();

    // Clear any remaining issue locks pointing at terminal or missing runs.
    const staleIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .leftJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
      .where(
        and(
          isNotNull(issues.executionRunId),
          or(
            isNull(heartbeatRuns.id), // run record missing
            inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
          ),
        ),
      );

    let clearedLocks = 0;
    if (staleIssues.length > 0) {
      const staleIssueIds = staleIssues.map((r) => r.id);
      const updated = await db
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          checkoutRunId: null,
          updatedAt: new Date(),
        })
        .where(inArray(issues.id, staleIssueIds))
        .returning({ id: issues.id });
      clearedLocks = updated.length;
    }

    res.json({ reaped: reaped.reaped, runIds: reaped.runIds, clearedLocks });
  });

  /**
   * Mark stuck queued runs as failed when the owning agent is paused,
   * terminated, or pending approval. Also releases the corresponding issue
   * execution locks so those issues can be reassigned.
   *
   * Optional body: { staleThresholdMs: number } — only reap runs older than
   * this many milliseconds (default: 0, reap all matching runs immediately).
   */
  router.post("/admin/reap-stale-queued-runs", async (req, res) => {
    assertBoard(req);

    const staleThresholdMs =
      typeof req.body?.staleThresholdMs === "number" ? req.body.staleThresholdMs : 0;

    const now = new Date();

    const queuedRuns = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          inArray(agents.status, ["paused", "terminated", "pending_approval"]),
        ),
      );

    const staleRuns =
      staleThresholdMs > 0
        ? queuedRuns.filter(
            (r) => now.getTime() - new Date(r.createdAt).getTime() >= staleThresholdMs,
          )
        : queuedRuns;

    if (staleRuns.length === 0) {
      res.json({ reaped: 0, runIds: [] });
      return;
    }

    const staleRunIds = staleRuns.map((r) => r.id);

    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: "Agent is paused or terminated; queued run reaped by admin",
        errorCode: "agent_unavailable",
        finishedAt: now,
        updatedAt: now,
      })
      .where(inArray(heartbeatRuns.id, staleRunIds));

    // Release any issue execution locks held by these runs.
    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        checkoutRunId: null,
        updatedAt: now,
      })
      .where(inArray(issues.executionRunId, staleRunIds));

    res.json({ reaped: staleRuns.length, runIds: staleRunIds });
  });

  return router;
}
