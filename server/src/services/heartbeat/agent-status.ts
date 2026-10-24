import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../../telemetry.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { publishLiveEvent } from "../live-events.js";
import { finishedIdleRun, finishedIdleWake, finishedFailedIdleLease } from "../idle-work-proof.js";

type Outcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out" | "deferred";

const RECONCILIATION_GRACE_MS = 5 * 60_000;
const RECONCILIATION_BATCH_SIZE = 25;

function errorReason(reason: string | null | undefined) {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed;
}

function settledStatus(outcome: string | undefined, keepIdleOnFailure = false) {
  if (outcome === "deferred") return "idle";
  return outcome === "failed" || outcome === "timed_out"
    ? keepIdleOnFailure && outcome === "failed" ? "idle" : "error"
    : "idle";
}

function publishStatus(agent: typeof agents.$inferSelect, outcome: string) {
  publishLiveEvent({
    companyId: agent.companyId,
    type: "agent.status",
    payload: {
      agentId: agent.id,
      status: agent.status,
      lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
      outcome,
    },
  });
}

export function settledAgentWorkCondition(liveRunIds: ReadonlySet<string>, now: Date) {
  const localRuns = liveRunIds.size > 0
    ? sql`AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r
        WHERE r.id IN (${sql.join([...liveRunIds].map(id => sql`${id}::uuid`), sql`, `)})
          AND r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id})`
    : sql``;
  return sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs r
      WHERE r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND r.status IN ('running', 'queued'))
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r
      WHERE r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND ((${sql.raw(finishedIdleRun("r"))}) IS NOT TRUE
          OR r.controller_lease_expires_at > ${now.toISOString()}::timestamptz))
    ${localRuns}
    AND NOT EXISTS (SELECT 1 FROM native_run_finalizations f
      JOIN heartbeat_runs r ON r.id = f.run_id AND r.company_id = f.company_id
      WHERE f.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND (f.phase NOT IN ('committed', 'terminal_failure')
          OR f.lease_expires_at > ${now.toISOString()}::timestamptz OR f.next_attempt_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM environment_leases l
      JOIN heartbeat_runs r ON r.id = l.heartbeat_run_id AND r.company_id = l.company_id
      WHERE l.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND ((l.status NOT IN ('released', 'expired')
            AND (${sql.raw(finishedFailedIdleLease("l"))}) IS NOT TRUE)
          OR COALESCE(l.metadata->>'pendingCleanupInFlight', 'false') <> 'false'
          OR COALESCE(l.metadata, '{}'::jsonb) ?| ARRAY['nativeWorkspaceExportResume', 'sandboxStopAndRetain']))
    AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests w
      WHERE w.company_id = ${agents.companyId} AND w.agent_id = ${agents.id}
        AND (${sql.raw(finishedIdleWake("w"))}) IS NOT TRUE)
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c
      WHERE c.company_id = ${agents.companyId} AND c.agent_id = ${agents.id}
        AND (c.state NOT IN ('saved', 'unchanged', 'resolved', 'unavailable', 'conflict')
          OR c.process_stopped_at IS NULL OR c.next_attempt_at IS NOT NULL
          OR c.receipt ? 'baseline' OR c.receipt->>'cleanupPending' = 'true'))`;
}

export function createHeartbeatAgentStatus(db: Db) {
  async function finalizeAgentStatus(
    agentId: string,
    outcome: Outcome,
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(agents)
        .where(eq(agents.id, agentId)).for("no key update");
      if (!existing || existing.lifecycleState !== "ready" ||
          existing.status === "paused" || existing.status === "terminated") return null;
      const [running] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, existing.companyId),
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running"),
      )).limit(1);
      const nextStatus = running ? "running" : settledStatus(outcome, options?.keepIdleOnFailure);
      const failureReasonForStatus = outcome === "deferred" ? null : failureReason;
      const now = new Date();
      const [updated] = await tx.update(agents).set({
        status: nextStatus,
        errorReason: nextStatus === "error" ? errorReason(failureReasonForStatus) : null,
        lastHeartbeatAt: now,
        updatedAt: now,
      }).where(and(eq(agents.id, agentId), eq(agents.companyId, existing.companyId),
        eq(agents.lifecycleState, "ready"))).returning();
      return { updated, isFirstHeartbeat: options?.wasFirstHeartbeat ?? !existing.lastHeartbeatAt };
    });
    if (!result?.updated) return;
    if (result.isFirstHeartbeat) {
      const client = getTelemetryClient();
      if (client) trackAgentFirstHeartbeat(client, { agentRole: result.updated.role, agentId: result.updated.id });
    }
    publishStatus(result.updated, outcome);
  }

  async function reconcileStrandedAgentStatuses(liveRunIds: () => ReadonlySet<string>) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - RECONCILIATION_GRACE_MS);
    const candidates = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
      return tx.select({ id: agents.id, companyId: agents.companyId }).from(agents)
      .where(and(eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
        lte(agents.updatedAt, cutoff), settledAgentWorkCondition(liveRunIds(), now)))
      .orderBy(asc(agents.updatedAt), asc(agents.id)).limit(RECONCILIATION_BATCH_SIZE);
    });
    const reconciled: string[] = [];
    for (const candidate of candidates) {
      if (Date.now() - now.getTime() > 5_000) break;
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
        const [locked] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
        )).for("update", { skipLocked: true });
        if (!locked) return null;
        const [current] = await tx.select().from(agents).where(and(
          eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
          eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
          lte(agents.updatedAt, cutoff), settledAgentWorkCondition(liveRunIds(), now),
        ));
        if (!current) return null;
        const [lastRun] = await tx.select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
          .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId),
            eq(heartbeatRuns.agentId, candidate.id)))
          .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
        const nextStatus = settledStatus(lastRun?.status);
        const [agent] = await tx.update(agents).set({ status: nextStatus,
          errorReason: nextStatus === "error" ? errorReason(lastRun?.error) : null, updatedAt: now,
        }).where(and(eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
          eq(agents.status, "running"), eq(agents.lifecycleState, "ready"))).returning();
        await logActivity(tx as unknown as Db, {
          companyId: candidate.companyId, actorType: "system", actorId: "system",
          action: "agent.status_reconciled", entityType: "agent", entityId: candidate.id,
          details: { previousStatus: "running", nextStatus, reason: "no_unsettled_execution" },
        }, publications);
        return agent;
      });
      if (!updated) continue;
      reconciled.push(updated.id);
      for (const publication of publications) publishActivity(publication);
      publishStatus(updated, "reconciled");
    }
    return reconciled;
  }

  return { finalizeAgentStatus, reconcileStrandedAgentStatuses };
}
