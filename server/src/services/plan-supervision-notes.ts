import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues, planDetails, planSupervisionNotes } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { logger } from "../middleware/logger.js";
import { diagnosePlanHealth, type PlanHealthDiagnosis } from "./plan-supervision.js";

export const SUPERVISION_MONITOR_INTERVAL_MS = 15 * 60 * 1000;

export interface SupervisionNoteInput {
  planIssueId: string;
  companyId: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  kind: "observation" | "overrun" | "action";
  targetAgentId?: string | null;
  targetIssueId?: string | null;
  severity?: "info" | "warning" | "critical";
  body: string;
  healthSnapshot?: PlanHealthDiagnosis | null;
  actionTaken?: string | null;
}

export async function addSupervisionNote(db: Db, input: SupervisionNoteInput) {
  const [note] = await db
    .insert(planSupervisionNotes)
    .values({
      companyId: input.companyId,
      planIssueId: input.planIssueId,
      authorAgentId: input.authorAgentId ?? null,
      authorUserId: input.authorUserId ?? null,
      kind: input.kind,
      targetAgentId: input.targetAgentId ?? null,
      targetIssueId: input.targetIssueId ?? null,
      severity: input.severity ?? "info",
      body: input.body,
      healthSnapshot: input.healthSnapshot ?? null,
      actionTaken: input.actionTaken ?? null,
    })
    .returning();
  return note;
}

export async function listSupervisionNotes(
  db: Db,
  planIssueId: string,
  companyId: string,
  limit = 50,
) {
  return db
    .select()
    .from(planSupervisionNotes)
    .where(
      and(
        eq(planSupervisionNotes.planIssueId, planIssueId),
        eq(planSupervisionNotes.companyId, companyId),
      ),
    )
    .orderBy(desc(planSupervisionNotes.createdAt))
    .limit(limit);
}

// Build context bundle for a CTO monitoring wake:
// - current health snapshot for all subtree agents
// - recent activity log entries across the subtree since `since`
export async function buildMonitorContext(
  db: Db,
  planIssueId: string,
  companyId: string,
  since: Date | null,
) {
  const health = await diagnosePlanHealth(planIssueId, companyId, db);

  // Collect subtree issue ids via recursive CTE (same approach as plans.subtreeIssueIds)
  const rows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id FROM issues WHERE id = ${planIssueId}
      UNION ALL
      SELECT c.id FROM issues c INNER JOIN tree t ON c.parent_id = t.id
    )
    SELECT id FROM tree
  `);
  // db.execute returns either a { rows } envelope or a bare array depending on
  // the driver. Guard the shape so a future Drizzle change surfaces loudly
  // rather than silently yielding an empty subtree (and empty recentActivity).
  const list = (rows as unknown as { rows?: { id: string }[] }).rows ?? (rows as unknown as { id: string }[]);
  if (!Array.isArray(list)) {
    logger.error({ planIssueId }, "plan monitoring: unexpected db.execute result shape for subtree CTE");
  }
  const subtreeIds = Array.isArray(list) ? list.map((r) => r.id) : [planIssueId];

  let recentActivity: { action: string; entityId: string; actorId: string; createdAt: Date }[] = [];
  if (subtreeIds.length > 0) {
    const conditions = [
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.entityId, subtreeIds),
    ];
    if (since) {
      conditions.push(gt(activityLog.createdAt, since));
    }
    const rows = await db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        actorId: activityLog.actorId,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(desc(activityLog.createdAt))
      .limit(100);
    recentActivity = rows;
  }

  return { health, recentActivity, since };
}

interface MonitoringWakeupDeps {
  wakeup: (
    agentId: string,
    opts?: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
    },
  ) => Promise<unknown>;
}

// Wake the CTO once per active plan that is due for monitoring (lastMonitoredAt
// IS NULL or older than SUPERVISION_MONITOR_INTERVAL_MS). Sets lastMonitoredAt
// even when the CTO wake is skipped (no agent) to avoid retry spam.
export async function tickPlanMonitoring(
  db: Db,
  deps: MonitoringWakeupDeps,
  now = new Date(),
): Promise<{ woken: number }> {
  const agents_ = agentService(db);
  const due = new Date(now.getTime() - SUPERVISION_MONITOR_INTERVAL_MS);

  const filtered = await db
    .select({
      issueId: planDetails.issueId,
      companyId: planDetails.companyId,
      lastMonitoredAt: planDetails.lastMonitoredAt,
      rootAssigneeAgentId: issues.assigneeAgentId,
    })
    .from(planDetails)
    .innerJoin(issues, eq(planDetails.issueId, issues.id))
    .where(
      and(
        eq(planDetails.state, "active"),
        or(isNull(planDetails.lastMonitoredAt), lt(planDetails.lastMonitoredAt, due)),
      ),
    );

  let woken = 0;

  for (const plan of filtered) {
    const since = plan.lastMonitoredAt;

    // Build context before setting lastMonitoredAt so the since window is accurate
    let context: Awaited<ReturnType<typeof buildMonitorContext>>;
    try {
      context = await buildMonitorContext(db, plan.issueId, plan.companyId, since);
    } catch (err) {
      // Deliberate degradation: a context-build failure (DB blip, diagnosis
      // error) skips this one monitoring cycle rather than tight-looping every
      // tick. The CTO simply misses one cadence wake; lastMonitoredAt is stamped
      // so the next attempt waits a full interval. Logged at error for visibility.
      logger.error({ err, planIssueId: plan.issueId }, "plan monitoring: failed to build context, skipping this cycle");
      await db
        .update(planDetails)
        .set({ lastMonitoredAt: now, updatedAt: now })
        .where(eq(planDetails.issueId, plan.issueId));
      continue;
    }

    const { agent: ctoAgent } = await agents_.resolveByReference(plan.companyId, "cto");
    const wakeTargetId = ctoAgent?.id ?? plan.rootAssigneeAgentId;

    // Two-layer dedup against monitor storms: the lastMonitoredAt interval gate
    // in the SELECT above prevents re-entry across ticks, and this per-window
    // idempotencyKey de-dups at the wakeup layer if two ticks race before the
    // lastMonitoredAt UPDATE commits. Window bucket = now floored to the interval.
    const windowBucket = Math.floor(now.getTime() / SUPERVISION_MONITOR_INTERVAL_MS);

    if (!wakeTargetId) {
      logger.warn({ planIssueId: plan.issueId }, "plan monitoring: no CTO agent found, skipping wake");
    } else {
      await deps.wakeup(wakeTargetId, {
        source: "timer",
        reason: "plan_monitor",
        idempotencyKey: `plan_monitor:${plan.issueId}:${windowBucket}`,
        payload: {
          planIssueId: plan.issueId,
          since: since?.toISOString() ?? null,
          health: context.health,
          recentActivity: context.recentActivity,
        },
        requestedByActorType: "system",
      });
      woken++;
    }

    await db
      .update(planDetails)
      .set({ lastMonitoredAt: now, updatedAt: now })
      .where(eq(planDetails.issueId, plan.issueId));
  }

  return { woken };
}

// On-demand monitoring wake — ignores the interval gate, wakes CTO immediately.
// Returns 409 (throws with .status=409) if the plan is not active.
export async function monitorNow(
  db: Db,
  deps: MonitoringWakeupDeps,
  planIssueId: string,
  now = new Date(),
): Promise<{ woken: boolean }> {
  const agents_ = agentService(db);

  const [plan] = await db
    .select({
      issueId: planDetails.issueId,
      companyId: planDetails.companyId,
      state: planDetails.state,
      lastMonitoredAt: planDetails.lastMonitoredAt,
      rootAssigneeAgentId: issues.assigneeAgentId,
    })
    .from(planDetails)
    .innerJoin(issues, eq(planDetails.issueId, issues.id))
    .where(eq(planDetails.issueId, planIssueId));

  if (!plan) {
    const err = new Error("Plan not found") as Error & { status: number };
    err.status = 404;
    throw err;
  }

  if (plan.state !== "active") {
    const err = new Error("Plan is not active") as Error & { status: number };
    err.status = 409;
    throw err;
  }

  const since = plan.lastMonitoredAt;
  const context = await buildMonitorContext(db, planIssueId, plan.companyId, since);

  const { agent: ctoAgent } = await agents_.resolveByReference(plan.companyId, "cto");
  const wakeTargetId = ctoAgent?.id ?? plan.rootAssigneeAgentId;

  if (!wakeTargetId) {
    logger.warn({ planIssueId }, "monitorNow: no CTO agent found");
    await db
      .update(planDetails)
      .set({ lastMonitoredAt: now, updatedAt: now })
      .where(eq(planDetails.issueId, planIssueId));
    return { woken: false };
  }

  await deps.wakeup(wakeTargetId, {
    source: "on_demand",
    reason: "plan_monitor",
    // Random suffix so two on-demand triggers in the same millisecond don't
    // collide on the key (each click is an independent intentional wake).
    idempotencyKey: `plan_monitor_now:${planIssueId}:${now.getTime()}:${Math.random().toString(36).slice(2, 10)}`,
    payload: {
      planIssueId,
      since: since?.toISOString() ?? null,
      health: context.health,
      recentActivity: context.recentActivity,
    },
    requestedByActorType: "system",
  });

  await db
    .update(planDetails)
    .set({ lastMonitoredAt: now, updatedAt: now })
    .where(eq(planDetails.issueId, planIssueId));

  return { woken: true };
}
