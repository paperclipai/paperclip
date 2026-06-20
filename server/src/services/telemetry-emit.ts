// PR2 telemetry emitter — derives one agent_runs row from a TERMINAL
// heartbeat_runs transition. NPI-SAFE BY CONSTRUCTION: reads only run metadata
// (id, agentId, timestamps, status, and the single scalar resultJson.tierUsed).
// It reads ZERO prompt/output payload — input_hash / output_hash are left null.
//
// Idempotent: at most one agent_runs row per heartbeat run, enforced by the
// partial unique index uq_agent_runs_heartbeat_run + ON CONFLICT DO NOTHING.
//
// The consumer (services/oracle-dispatcher/learning.py, P4) reads agent_runs via
// an 11-column allowlist and STRIPS heartbeat_run_id — so this link is safe to add.

import { and, eq, sql } from "drizzle-orm";
import { type Db, agentRuns, promptVersions, type heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled"]);
const TASK_CLASS = "general";

/**
 * Best-effort: derive + insert an agent_runs telemetry row from a terminal
 * heartbeat run. Swallows + logs all errors internally so it can NEVER throw to
 * the caller (the run's own lifecycle must never fail on telemetry).
 */
export async function emitAgentRunFromTerminal(
  db: Db,
  updatedRow: typeof heartbeatRuns.$inferSelect | null,
): Promise<void> {
  try {
    if (!updatedRow || !TERMINAL_STATUSES.has(updatedRow.status)) return;

    // agent = the stable agent UUID (NOT the display name).
    const agent = updatedRow.agentId;

    // Active prompt version for this (agent, 'general'); null if none seeded.
    const promptVersionRow = await db
      .select({ id: promptVersions.id })
      .from(promptVersions)
      .where(
        and(
          eq(promptVersions.agent, agent),
          eq(promptVersions.taskClass, TASK_CLASS),
          eq(promptVersions.status, "active"),
        ),
      )
      .limit(1);
    const promptVersionId = promptVersionRow[0]?.id ?? null;

    // Read ONLY the single scalar resultJson.tierUsed; ignore all other content.
    const tierUsedRaw = (updatedRow.resultJson as Record<string, unknown> | null | undefined)
      ?.tierUsed;
    const tier =
      typeof tierUsedRaw === "string" && tierUsedRaw.length > 0 ? tierUsedRaw : null;

    const latencyMs =
      updatedRow.startedAt && updatedRow.finishedAt
        ? Math.round(updatedRow.finishedAt.getTime() - updatedRow.startedAt.getTime())
        : null;

    // Only genuine failures enter the low-outcome cluster. succeeded defers to a
    // later business backfill; cancelled / timed_out are budget/infra, not failures.
    const outcome = updatedRow.status === "failed" ? "failed" : null;

    await db
      .insert(agentRuns)
      .values({
        agent,
        taskClass: TASK_CLASS,
        promptVersionId,
        inputHash: null,
        outputHash: null,
        outcome,
        userFeedback: null,
        latencyMs,
        tier,
        heartbeatRunId: updatedRow.id,
      })
      .onConflictDoNothing({
        target: agentRuns.heartbeatRunId,
        // The arbiter is a PARTIAL unique index; Postgres requires its predicate
        // in the ON CONFLICT clause to infer it. For onConflictDoNothing, drizzle
        // 0.38 renders `where` AS the target predicate — i.e. `(heartbeat_run_id)
        // WHERE heartbeat_run_id IS NOT NULL DO NOTHING`. Without it this errors
        // (42P10) on EVERY insert — see PR2 deviation note.
        where: sql`${agentRuns.heartbeatRunId} IS NOT NULL`,
      });
  } catch (err) {
    logger.error({ err, runId: updatedRow?.id ?? null }, "agent_runs emit failed (non-fatal)");
  }
}
