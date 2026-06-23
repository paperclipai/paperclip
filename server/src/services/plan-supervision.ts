import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, planDetails } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { logger } from "../middleware/logger.js";
import {
  ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
  ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
} from "./recovery/service.js";

export type AgentHealth =
  | "working"
  | "stuck"
  | "stuck_critical"
  | "looping"
  | "needs_rewake"
  | "paused";

export interface AgentHealthEntry {
  agentId: string;
  agentName: string | null;
  issueId: string;
  runId?: string;
  health: AgentHealth;
  severity: "info" | "warning" | "critical";
  lastOutputAt: Date | null;
  detail: string;
}

export interface PlanHealthDiagnosis {
  planIssueId: string;
  overdue: boolean;
  agents: AgentHealthEntry[];
}

// Run statuses that are not active — the agent has stopped processing.
const TERMINAL_RUN_STATUSES = new Set(["failed", "timed_out", "cancelled", "succeeded"]);
// Issue statuses that mean the assignee should still be making progress.
const ACTIVE_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

function classifySeverity(health: AgentHealth): "info" | "warning" | "critical" {
  if (health === "stuck_critical" || health === "looping") return "critical";
  if (health === "stuck" || health === "needs_rewake" || health === "paused") return "warning";
  return "info";
}

function buildDetail(
  health: AgentHealth,
  run: { lastOutputAt: Date | null; startedAt: Date | null } | null,
  now: Date,
): string {
  switch (health) {
    case "working":
      return "Agent is actively producing output.";
    case "stuck": {
      const age = run?.lastOutputAt ? Math.round((now.getTime() - run.lastOutputAt.getTime()) / 60000) : null;
      return age !== null ? `No output for ${age} min (suspicious).` : "No output since run started.";
    }
    case "stuck_critical": {
      const age = run?.lastOutputAt ? Math.round((now.getTime() - run.lastOutputAt.getTime()) / 60000) : null;
      return age !== null ? `No output for ${age} min (critical).` : "No output for an extended period (critical).";
    }
    case "looping":
      return "Agent run is in an execution loop.";
    case "needs_rewake":
      return "Issue is active but agent has no running process — needs a wakeup.";
    case "paused":
      return "Agent is paused or terminated and cannot progress.";
  }
}

export async function diagnosePlanHealth(
  planRootIssueId: string,
  companyId: string,
  db: Db,
  now: Date = new Date(),
): Promise<PlanHealthDiagnosis> {
  // Step 0: load plan details to determine overdue.
  const [planRow] = await db
    .select({ estimatedCompletionAt: planDetails.estimatedCompletionAt })
    .from(planDetails)
    .where(eq(planDetails.issueId, planRootIssueId))
    .limit(1);

  if (!planRow) {
    return { planIssueId: planRootIssueId, overdue: false, agents: [] };
  }

  const overdue =
    !!planRow.estimatedCompletionAt && planRow.estimatedCompletionAt < now;

  // Step 1: load active subtree issues with an assignee.
  const subtreeIssues = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
    .from(issues)
    .where(
      and(
        eq(issues.planRootIssueId, planRootIssueId),
        isNotNull(issues.assigneeAgentId),
        inArray(issues.status, [...ACTIVE_ISSUE_STATUSES]),
      ),
    );

  if (subtreeIssues.length === 0) {
    return { planIssueId: planRootIssueId, overdue, agents: [] };
  }

  // Step 2: one representative issue per agent (first active issue found).
  const agentIssueMap = new Map<string, string>();
  for (const issue of subtreeIssues) {
    if (issue.assigneeAgentId && !agentIssueMap.has(issue.assigneeAgentId)) {
      agentIssueMap.set(issue.assigneeAgentId, issue.id);
    }
  }

  const agentIds = Array.from(agentIssueMap.keys());

  // Step 3: load agent records.
  const agentRows = await db
    .select({ id: agents.id, status: agents.status, name: agents.name })
    .from(agents)
    .where(inArray(agents.id, agentIds));

  const agentMap = new Map(agentRows.map((a) => [a.id, a]));

  // Step 4: load latest heartbeat run per agent via window CTE.
  // ROW_NUMBER() PARTITION BY agent_id hits heartbeat_runs_company_agent_started_idx.
  const latestRunCte = db.$with("latest_run").as(
    db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        livenessState: heartbeatRuns.livenessState,
        startedAt: heartbeatRuns.startedAt,
        rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${heartbeatRuns.agentId} ORDER BY ${heartbeatRuns.startedAt} DESC NULLS FIRST)`.as(
          "rn",
        ),
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.agentId, agentIds),
        ),
      ),
  );

  const runRows = await db
    .with(latestRunCte)
    .select()
    .from(latestRunCte)
    .where(eq(latestRunCte.rn, 1));

  const latestRunMap = new Map(runRows.map((r) => [r.agentId, r]));

  // Step 5: classify each agent.
  const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
  const criticalBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS);

  const entries: AgentHealthEntry[] = [];

  for (const agentId of agentIds) {
    const agent = agentMap.get(agentId);
    const run = latestRunMap.get(agentId) ?? null;
    const issueId = agentIssueMap.get(agentId)!;

    let health: AgentHealth;

    if (!agent || agent.status === "paused" || agent.status === "terminated") {
      health = "paused";
    } else if (run?.status === "running") {
      if (run.livenessState === "execution_loop_likely") {
        health = "looping";
      } else {
        const effectiveLastOutput = run.lastOutputAt ?? run.startedAt ?? now;
        if (effectiveLastOutput < criticalBefore) {
          health = "stuck_critical";
        } else if (effectiveLastOutput < suspicionBefore) {
          health = "stuck";
        } else {
          health = "working";
        }
      }
    } else if (!run || TERMINAL_RUN_STATUSES.has(run.status)) {
      health = "needs_rewake";
    } else {
      // queued or scheduled_retry — agent will run soon, treat as working.
      health = "working";
    }

    const isTerminal = !run || TERMINAL_RUN_STATUSES.has(run.status);
    entries.push({
      agentId,
      agentName: agent?.name ?? null,
      issueId,
      runId: !isTerminal ? run?.id : undefined,
      health,
      severity: classifySeverity(health),
      lastOutputAt: run?.lastOutputAt ?? null,
      detail: buildDetail(health, run ?? null, now),
    });
  }

  return { planIssueId: planRootIssueId, overdue, agents: entries };
}

interface WakeupDeps {
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

// Wake the CTO once for each active plan whose ETA has passed and hasn't been
// notified yet. Returns the count of CTO wakes enqueued.
// The etaOverrunNotifiedAt IS NULL predicate is the real dedup guard;
// idempotencyKey is stored for audit tracing only.
export async function tickPlanEtaOverruns(
  db: Db,
  deps: WakeupDeps,
  now = new Date(),
): Promise<{ notified: number }> {
  const agents_ = agentService(db);

  const overduePlans = await db
    .select({
      issueId: planDetails.issueId,
      companyId: planDetails.companyId,
      rootAssigneeAgentId: issues.assigneeAgentId,
    })
    .from(planDetails)
    .innerJoin(issues, eq(planDetails.issueId, issues.id))
    .where(
      and(
        eq(planDetails.state, "active"),
        isNotNull(planDetails.estimatedCompletionAt),
        lt(planDetails.estimatedCompletionAt, now),
        isNull(planDetails.etaOverrunNotifiedAt),
      ),
    );

  let notified = 0;

  for (const plan of overduePlans) {
    // Per-plan isolation: a wakeup failure for one plan must not abort the
    // whole batch, and must not leave that plan stamped-but-unwoken.
    try {
      // Resolve CTO agent; fall back to the plan root's assignee.
      const { agent: ctoAgent } = await agents_.resolveByReference(plan.companyId, "cto");
      const wakeTargetId = ctoAgent?.id ?? plan.rootAssigneeAgentId;

      if (!wakeTargetId) {
        logger.warn({ planIssueId: plan.issueId }, "plan ETA overrun: no CTO agent found, stamping notified to suppress retry");
      } else {
        await deps.wakeup(wakeTargetId, {
          source: "automation",
          reason: "plan_eta_overrun",
          // idempotencyKey is stored for audit tracing only — the etaOverrunNotifiedAt
          // IS NULL predicate above is the real dedup guard.
          idempotencyKey: `eta_overrun:${plan.issueId}`,
          payload: { planIssueId: plan.issueId },
          requestedByActorType: "system",
        });
        notified++;
      }

      // Stamp only after the wake succeeded (or was deliberately skipped for a
      // missing CTO). On wake failure we fall through to the catch and leave
      // etaOverrunNotifiedAt NULL so the next tick retries; the stable
      // idempotencyKey prevents a duplicate wake if the failed call partially landed.
      await db
        .update(planDetails)
        .set({ etaOverrunNotifiedAt: now, updatedAt: now })
        .where(eq(planDetails.issueId, plan.issueId));
    } catch (err) {
      logger.error({ err, planIssueId: plan.issueId }, "plan ETA overrun: failed to wake CTO, will retry next tick");
    }
  }

  return { notified };
}
