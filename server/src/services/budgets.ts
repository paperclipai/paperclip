import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  issues,
  planDetails,
  projects,
} from "@paperclipai/db";
import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetMetric,
  BudgetOverview,
  PauseReason,
  BudgetPolicy,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
};

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
};

export type BudgetServiceOptions = {
  /**
   * Headroom above a hard cap within which an automatic (cost-event-driven)
   * hard-stop pauses the scope WITHOUT cancelling in-flight runs — letting the
   * current flow finish at its natural boundary instead of being killed
   * mid-assignment. Once observed spend reaches `cap * graceFactor` the full
   * pause-and-cancel fires (runaway ceiling). `1.0` reproduces the pre-grace
   * behavior exactly. Clamped to `>= 1.0`.
   */
  hardStopGraceFactor?: number;
};

const DEFAULT_HARD_STOP_GRACE_FACTOR = 1.25;

/**
 * Resolve the hard-stop grace factor from an explicit override, else the
 * `PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR` env var, else the default. Never
 * returns a value below 1.0 (a sub-1 factor would pause before the cap is even
 * reached, which is never intended).
 */
function resolveHardStopGraceFactor(override?: number): number {
  const raw = override ?? Number(process.env.PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR);
  const value = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HARD_STOP_GRACE_FACTOR;
  return Math.max(1, value);
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  return currentUtcMonthWindow(now);
}

function budgetStatusFromObserved(
  observedAmount: number,
  amount: number,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (amount <= 0) return "ok";
  if (observedAmount >= amount) return "hard_stop";
  if (observedAmount >= Math.ceil((amount * warnPercent) / 100)) return "warning";
  return "ok";
}

function normalizeScopeName(scopeType: BudgetScopeType, name: string) {
  if (scopeType === "company") return name;
  return name.trim().length > 0 ? name : scopeType;
}

async function resolveScopeRecord(db: Db, scopeType: BudgetScopeType, scopeId: string): Promise<ScopeRecord> {
  if (scopeType === "company") {
    const row = await db
      .select({
        companyId: companies.id,
        name: companies.name,
        status: companies.status,
        pauseReason: companies.pauseReason,
        pausedAt: companies.pausedAt,
      })
      .from(companies)
      .where(eq(companies.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused" || Boolean(row.pausedAt),
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  if (scopeType === "agent") {
    const row = await db
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents)
      .where(eq(agents.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent not found");
    return {
      companyId: row.companyId,
      name: row.name,
      paused: row.status === "paused",
      pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
    };
  }

  if (scopeType === "issue") {
    const row = await db
      .select({
        companyId: issues.companyId,
        title: issues.title,
        planState: planDetails.state,
      })
      .from(issues)
      .leftJoin(planDetails, eq(planDetails.issueId, issues.id))
      .where(eq(issues.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Issue not found");
    return {
      companyId: row.companyId,
      name: row.title,
      paused: row.planState === "stopped",
      pauseReason: row.planState === "stopped" ? "budget" : null,
    };
  }

  const row = await db
    .select({
      companyId: projects.companyId,
      name: projects.name,
      pauseReason: projects.pauseReason,
      pausedAt: projects.pausedAt,
    })
    .from(projects)
    .where(eq(projects.id, scopeId))
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Project not found");
  return {
    companyId: row.companyId,
    name: row.name,
    paused: Boolean(row.pausedAt),
    pauseReason: (row.pauseReason as ScopeRecord["pauseReason"]) ?? null,
  };
}

async function computeObservedAmount(
  db: Db,
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">,
) {
  if (policy.metric !== "billed_cents" && policy.metric !== "total_tokens") return 0;

  const conditions = [eq(costEvents.companyId, policy.companyId)];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));
  if (policy.scopeType === "issue") {
    // Issue scope = the issue itself plus every descendant stamped with
    // plan_root_issue_id. Subquery keeps it a single round-trip.
    const subtreeIds = db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, policy.companyId),
          sql`(${issues.id} = ${policy.scopeId} OR ${issues.planRootIssueId} = ${policy.scopeId})`,
        ),
      );
    conditions.push(inArray(costEvents.issueId, subtreeIds));
  }
  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  if (policy.windowKind === "calendar_month_utc") {
    conditions.push(gte(costEvents.occurredAt, start));
    conditions.push(lt(costEvents.occurredAt, end));
  }

  // total_tokens counts input + cached input + output (real usage pressure).
  const amountExpr =
    policy.metric === "total_tokens"
      ? sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}), 0)::double precision`
      : sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`;

  const [row] = await db
    .select({ total: amountExpr })
    .from(costEvents)
    .where(and(...conditions));

  return Number(row?.total ?? 0);
}

function buildApprovalPayload(input: {
  policy: PolicyRow;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountObserved: number;
  windowStart: Date;
  windowEnd: Date;
}) {
  return {
    scopeType: input.policy.scopeType,
    scopeId: input.policy.scopeId,
    scopeName: input.scopeName,
    metric: input.policy.metric,
    windowKind: input.policy.windowKind,
    thresholdType: input.thresholdType,
    budgetAmount: input.policy.amount,
    observedAmount: input.amountObserved,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    guidance: "Raise the budget and resume the scope, or keep the scope paused.",
  };
}

async function markApprovalStatus(
  db: Db,
  approvalId: string | null,
  status: "approved" | "rejected",
  decisionNote: string | null | undefined,
  decidedByUserId: string,
) {
  if (!approvalId) return;
  await db
    .update(approvals)
    .set({
      status,
      decisionNote: decisionNote ?? null,
      decidedByUserId,
      decidedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));
}

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}, options: BudgetServiceOptions = {}) {
  const hardStopGraceFactor = resolveHardStopGraceFactor(options.hardStopGraceFactor);

  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "paused",
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), inArray(agents.status, ["active", "idle", "running", "error"])));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(eq(projects.id, policy.scopeId));
      return;
    }

    if (policy.scopeType === "issue") {
      // If the issue is a plan root, mark the plan stopped. No-op for plain tasks
      // (the subtree run cancellation is handled by the cancelWorkForScope hook).
      await db
        .update(planDetails)
        .set({ state: "stopped", stoppedAt: now, stopReason: "budget_cap", updatedAt: now })
        .where(and(eq(planDetails.issueId, policy.scopeId), ne(planDetails.state, "stopped")));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(companies.id, policy.scopeId));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow) {
    await pauseScopeForBudget(policy);
    await hooks.cancelWorkForScope?.({
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
    });
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db
        .update(agents)
        .set({
          status: "idle",
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(agents.id, policy.scopeId), eq(agents.pauseReason, "budget")));
      return;
    }

    if (policy.scopeType === "project") {
      await db
        .update(projects)
        .set({
          pauseReason: null,
          pausedAt: null,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.pauseReason, "budget")));
      return;
    }

    await db
      .update(companies)
      .set({
        status: "active",
        pauseReason: null,
        pausedAt: null,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.pauseReason, "budget")));
  }

  async function getPolicyRow(policyId: string) {
    const policy = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.id, policyId))
      .then((rows) => rows[0] ?? null);
    if (!policy) throw notFound("Budget policy not found");
    return policy;
  }

  async function listPolicyRows(companyId: string) {
    return db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.companyId, companyId))
      .orderBy(desc(budgetPolicies.updatedAt));
  }

  async function buildPolicySummary(policy: PolicyRow): Promise<BudgetPolicySummary> {
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const observedAmount = await computeObservedAmount(db, policy);
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const amount = policy.isActive ? policy.amount : 0;
    const utilizationPercent =
      amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0;
    return {
      policyId: policy.id,
      companyId: policy.companyId,
      scopeType: policy.scopeType as BudgetScopeType,
      scopeId: policy.scopeId,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      metric: policy.metric as BudgetMetric,
      windowKind: policy.windowKind as BudgetWindowKind,
      amount,
      observedAmount,
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: policy.isActive
        ? budgetStatusFromObserved(observedAmount, amount, policy.warnPercent)
        : "ok",
      paused: scope.paused,
      pauseReason: scope.pauseReason,
      windowStart: start,
      windowEnd: end,
    };
  }

  async function createIncidentIfNeeded(
    policy: PolicyRow,
    thresholdType: BudgetThresholdType,
    amountObserved: number,
  ) {
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
    const existing = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          ne(budgetIncidents.status, "dismissed"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const payload = buildApprovalPayload({
      policy,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      thresholdType,
      amountObserved,
      windowStart: start,
      windowEnd: end,
    });

    const approval = thresholdType === "hard"
      ? await db
        .insert(approvals)
        .values({
          companyId: policy.companyId,
          type: "budget_override_required",
          requestedByUserId: null,
          requestedByAgentId: null,
          status: "pending",
          payload,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
      : null;

    return db
      .insert(budgetIncidents)
      .values({
        companyId: policy.companyId,
        policyId: policy.id,
        scopeType: policy.scopeType,
        scopeId: policy.scopeId,
        metric: policy.metric,
        windowKind: policy.windowKind,
        windowStart: start,
        windowEnd: end,
        thresholdType,
        amountLimit: policy.amount,
        amountObserved,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function resolveOpenSoftIncidents(policyId: string) {
    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(budgetIncidents.policyId, policyId),
          eq(budgetIncidents.thresholdType, "soft"),
          eq(budgetIncidents.status, "open"),
        ),
      );
  }

  async function resolveOpenIncidentsForPolicy(
    policyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
  ) {
    const openRows = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open")));

    if (!approvalStatus || !decidedByUserId) return;
    for (const row of openRows) {
      await markApprovalStatus(db, row.approvalId ?? null, approvalStatus, "Resolved via budget update", decidedByUserId);
    }
  }

  async function hydrateIncidentRows(rows: IncidentRow[]): Promise<BudgetIncident[]> {
    const approvalIds = rows.map((row) => row.approvalId).filter((value): value is string => Boolean(value));
    const approvalRows = approvalIds.length > 0
      ? await db
        .select({ id: approvals.id, status: approvals.status })
        .from(approvals)
        .where(inArray(approvals.id, approvalIds))
      : [];
    const approvalStatusById = new Map(approvalRows.map((row) => [row.id, row.status]));

    return Promise.all(
      rows.map(async (row) => {
        const scope = await resolveScopeRecord(db, row.scopeType as BudgetScopeType, row.scopeId);
        return {
          id: row.id,
          companyId: row.companyId,
          policyId: row.policyId,
          scopeType: row.scopeType as BudgetScopeType,
          scopeId: row.scopeId,
          scopeName: normalizeScopeName(row.scopeType as BudgetScopeType, scope.name),
          metric: row.metric as BudgetMetric,
          windowKind: row.windowKind as BudgetWindowKind,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          thresholdType: row.thresholdType as BudgetThresholdType,
          amountLimit: row.amountLimit,
          amountObserved: row.amountObserved,
          status: row.status as BudgetIncident["status"],
          approvalId: row.approvalId ?? null,
          approvalStatus: row.approvalId ? approvalStatusById.get(row.approvalId) ?? null : null,
          resolvedAt: row.resolvedAt ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    );
  }

  return {
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        metric: row.metric as BudgetMetric,
        windowKind: row.windowKind as BudgetWindowKind,
      }));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
    ): Promise<BudgetPolicySummary> => {
      const scope = await resolveScopeRecord(db, input.scopeType, input.scopeId);
      if (scope.companyId !== companyId) {
        throw unprocessable("Budget scope does not belong to company");
      }

      const metric = input.metric ?? "billed_cents";
      const windowKind = input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
      const amount = Math.max(0, Math.floor(input.amount));
      const nextIsActive = amount > 0 && (input.isActive ?? true);
      const existing = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, input.scopeType),
            eq(budgetPolicies.scopeId, input.scopeId),
            eq(budgetPolicies.metric, metric),
            eq(budgetPolicies.windowKind, windowKind),
          ),
        )
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            isActive: nextIsActive,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, existing.id))
          .returning()
          .then((rows) => rows[0])
        : await db
          .insert(budgetPolicies)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            metric,
            windowKind,
            amount,
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            isActive: nextIsActive,
            createdByUserId: actorUserId,
            updatedByUserId: actorUserId,
          })
          .returning()
          .then((rows) => rows[0]);

      if (input.scopeType === "company" && windowKind === "calendar_month_utc") {
        await db
          .update(companies)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(companies.id, input.scopeId));
      }

      if (input.scopeType === "agent" && windowKind === "calendar_month_utc") {
        await db
          .update(agents)
          .set({
            budgetMonthlyCents: amount,
            updatedAt: now,
          })
          .where(eq(agents.id, input.scopeId));
      }

      if (amount > 0) {
        const observedAmount = await computeObservedAmount(db, row);
        if (observedAmount < amount) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          if (row.notifyEnabled && observedAmount >= softThreshold) {
            await createIncidentIfNeeded(row, "soft", observedAmount);
          }
          if (row.hardStopEnabled && observedAmount >= row.amount) {
            await resolveOpenSoftIncidents(row.id);
            await createIncidentIfNeeded(row, "hard", observedAmount);
            await pauseAndCancelScopeForBudget(row);
          }
        }
      } else {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actorUserId ?? "board",
        action: "budget.policy_upserted",
        entityType: "budget_policy",
        entityId: row.id,
        details: {
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          amount: row.amount,
          windowKind: row.windowKind,
        },
      });

      return buildPolicySummary(row);
    },

    overview: async (companyId: string): Promise<BudgetOverview> => {
      const rows = await listPolicyRows(companyId);
      const policies = await Promise.all(rows.map((row) => buildPolicySummary(row)));
      const activeIncidentRows = await db
        .select()
        .from(budgetIncidents)
        .where(and(eq(budgetIncidents.companyId, companyId), eq(budgetIncidents.status, "open")))
        .orderBy(desc(budgetIncidents.createdAt));
      const activeIncidents = await hydrateIncidentRows(activeIncidentRows);
      return {
        companyId,
        policies,
        activeIncidents,
        pausedAgentCount: policies.filter((policy) => policy.scopeType === "agent" && policy.paused).length,
        pausedProjectCount: policies.filter((policy) => policy.scopeType === "project" && policy.paused).length,
        pendingApprovalCount: activeIncidents.filter((incident) => incident.approvalStatus === "pending").length,
      };
    },

    evaluateCostEvent: async (event: typeof costEvents.$inferSelect) => {
      const candidatePolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, event.companyId),
            eq(budgetPolicies.isActive, true),
            inArray(budgetPolicies.scopeType, ["company", "agent", "project", "issue"]),
          ),
        );

      // Resolve the cost event's plan root once so issue-scoped caps on the plan
      // root also catch spend from its descendant tickets.
      let eventPlanRootId: string | null = null;
      if (event.issueId) {
        const issueRow = await db
          .select({ planRootIssueId: issues.planRootIssueId })
          .from(issues)
          .where(eq(issues.id, event.issueId))
          .then((rows) => rows[0] ?? null);
        eventPlanRootId = issueRow?.planRootIssueId ?? null;
      }

      const relevantPolicies = candidatePolicies.filter((policy) => {
        if (policy.scopeType === "company") return policy.scopeId === event.companyId;
        if (policy.scopeType === "agent") return policy.scopeId === event.agentId;
        if (policy.scopeType === "project") return Boolean(event.projectId) && policy.scopeId === event.projectId;
        if (policy.scopeType === "issue") {
          return (
            Boolean(event.issueId) &&
            (policy.scopeId === event.issueId || policy.scopeId === eventPlanRootId)
          );
        }
        return false;
      });

      for (const policy of relevantPolicies) {
        if ((policy.metric !== "billed_cents" && policy.metric !== "total_tokens") || policy.amount <= 0) continue;
        const observedAmount = await computeObservedAmount(db, policy);
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);

        if (policy.notifyEnabled && observedAmount >= softThreshold) {
          const softIncident = await createIncidentIfNeeded(policy, "soft", observedAmount);
          if (softIncident) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.soft_threshold_crossed",
              entityType: "budget_incident",
              entityId: softIncident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
              },
            });
            publishLiveEvent({
              companyId: policy.companyId,
              type: "budget.threshold",
              payload: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                thresholdType: "soft",
                metric: policy.metric,
                observed: observedAmount,
                limit: policy.amount,
              },
            });
          }
        }

        if (policy.hardStopEnabled && observedAmount >= policy.amount) {
          await resolveOpenSoftIncidents(policy.id);
          const hardIncident = await createIncidentIfNeeded(policy, "hard", observedAmount);
          // Grace band: between the cap and `cap * graceFactor`, pause the scope
          // (block the next wake) but let the in-flight run finish at its natural
          // boundary instead of cancelling it mid-flow. The agent pause survives
          // run completion (finalizeAgentStatus bails on "paused"); a stopped
          // plan blocks new subtree work but does not cancel running subtree
          // runs. Past the grace ceiling we fall back to full pause-and-cancel.
          const withinGrace = observedAmount < policy.amount * hardStopGraceFactor;
          if (withinGrace) {
            await pauseScopeForBudget(policy);
          } else {
            await pauseAndCancelScopeForBudget(policy);
          }
          publishLiveEvent({
            companyId: policy.companyId,
            type: "budget.threshold",
            payload: {
              scopeType: policy.scopeType,
              scopeId: policy.scopeId,
              thresholdType: "hard",
              metric: policy.metric,
              observed: observedAmount,
              limit: policy.amount,
            },
          });
          if (policy.scopeType === "issue") {
            publishLiveEvent({
              companyId: policy.companyId,
              type: "plan.state.changed",
              payload: { planIssueId: policy.scopeId, state: "stopped", reason: "budget_cap" },
            });
          }
          if (hardIncident) {
            await logActivity(db, {
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.hard_threshold_crossed",
              entityType: "budget_incident",
              entityId: hardIncident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.approvalId ?? null,
              },
            });
          }
        }
      }
    },

    getInvocationBlock: async (
      companyId: string,
      agentId: string,
      context?: { issueId?: string | null; projectId?: string | null },
    ) => {
      const agent = await db
        .select({
          status: agents.status,
          pauseReason: agents.pauseReason,
          companyId: agents.companyId,
          name: agents.name,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");

      const company = await db
        .select({
          status: companies.status,
          pauseReason: companies.pauseReason,
          name: companies.name,
        })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");
      if (company.status === "paused") {
        return {
          scopeType: "company" as const,
          scopeId: companyId,
          scopeName: company.name,
          reason:
            company.pauseReason === "budget"
              ? "Company is paused because its budget hard-stop was reached."
              : "Company is paused and cannot start new work.",
        };
      }

      const companyPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "company"),
            eq(budgetPolicies.scopeId, companyId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (companyPolicy && companyPolicy.hardStopEnabled && companyPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, companyPolicy);
        if (observed >= companyPolicy.amount) {
          return {
            scopeType: "company" as const,
            scopeId: companyId,
            scopeName: company.name,
            reason: "Company cannot start new work because its budget hard-stop is exceeded.",
          };
        }
      }

      if (agent.status === "paused" && agent.pauseReason === "budget") {
        return {
          scopeType: "agent" as const,
          scopeId: agentId,
          scopeName: agent.name,
          reason: "Agent is paused because its budget hard-stop was reached.",
        };
      }

      const agentPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "agent"),
            eq(budgetPolicies.scopeId, agentId),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (agentPolicy && agentPolicy.hardStopEnabled && agentPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, agentPolicy);
        if (observed >= agentPolicy.amount) {
          return {
            scopeType: "agent" as const,
            scopeId: agentId,
            scopeName: agent.name,
            reason: "Agent cannot start because its budget hard-stop is still exceeded.",
          };
        }
      }

      // MyHive issue/plan-scoped caps. Uses the issueId the heartbeat already
      // passes; checks the task itself and its plan root.
      const candidateIssueId = context?.issueId ?? null;
      if (candidateIssueId) {
        const issueRow = await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            title: issues.title,
            planRootIssueId: issues.planRootIssueId,
          })
          .from(issues)
          .where(eq(issues.id, candidateIssueId))
          .then((rows) => rows[0] ?? null);
        if (issueRow && issueRow.companyId === companyId) {
          const scopeIds = [issueRow.id, issueRow.planRootIssueId].filter(
            (value): value is string => typeof value === "string",
          );
          for (const scopeId of scopeIds) {
            // A stopped plan blocks new work outright.
            const planRow = await db
              .select({ state: planDetails.state })
              .from(planDetails)
              .where(eq(planDetails.issueId, scopeId))
              .then((rows) => rows[0] ?? null);
            if (planRow?.state === "stopped") {
              return {
                scopeType: "issue" as const,
                scopeId,
                scopeName: issueRow.title,
                reason: "Plan is stopped and cannot start new work.",
              };
            }
            const issuePolicies = await db
              .select()
              .from(budgetPolicies)
              .where(
                and(
                  eq(budgetPolicies.companyId, companyId),
                  eq(budgetPolicies.scopeType, "issue"),
                  eq(budgetPolicies.scopeId, scopeId),
                  eq(budgetPolicies.isActive, true),
                ),
              );
            for (const issuePolicy of issuePolicies) {
              if (!issuePolicy.hardStopEnabled || issuePolicy.amount <= 0) continue;
              const observed = await computeObservedAmount(db, issuePolicy);
              if (observed >= issuePolicy.amount) {
                return {
                  scopeType: "issue" as const,
                  scopeId,
                  scopeName: issueRow.title,
                  reason: "Plan/task budget hard-stop reached; cannot start new work.",
                };
              }
            }
          }
        }
      }

      const candidateProjectId = context?.projectId ?? null;
      if (!candidateProjectId) return null;

      const project = await db
        .select({
          id: projects.id,
          name: projects.name,
          companyId: projects.companyId,
          pauseReason: projects.pauseReason,
          pausedAt: projects.pausedAt,
        })
        .from(projects)
        .where(eq(projects.id, candidateProjectId))
        .then((rows) => rows[0] ?? null);

      if (!project || project.companyId !== companyId) return null;
      const projectPolicy = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, "project"),
            eq(budgetPolicies.scopeId, project.id),
            eq(budgetPolicies.isActive, true),
            eq(budgetPolicies.metric, "billed_cents"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (projectPolicy && projectPolicy.hardStopEnabled && projectPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, projectPolicy);
        if (observed >= projectPolicy.amount) {
          return {
            scopeType: "project" as const,
            scopeId: project.id,
            scopeName: project.name,
            reason: "Project cannot start work because its budget hard-stop is still exceeded.",
          };
        }
      }

      if (!project.pausedAt || project.pauseReason !== "budget") return null;
      return {
        scopeType: "project" as const,
        scopeId: project.id,
        scopeName: project.name,
        reason: "Project is paused because its budget hard-stop was reached.",
      };
    },

    resolveIncident: async (
      companyId: string,
      incidentId: string,
      input: BudgetIncidentResolutionInput,
      actorUserId: string,
    ): Promise<BudgetIncident> => {
      const incident = await db
        .select()
        .from(budgetIncidents)
        .where(eq(budgetIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incident) throw notFound("Budget incident not found");
      if (incident.companyId !== companyId) throw notFound("Budget incident not found");

      const policy = await getPolicyRow(incident.policyId);
      if (input.action === "raise_budget_and_resume") {
        const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
        const currentObserved = await computeObservedAmount(db, policy);
        if (nextAmount <= currentObserved) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        const now = new Date();
        await db
          .update(budgetPolicies)
          .set({
            amount: nextAmount,
            isActive: true,
            updatedByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(budgetPolicies.id, policy.id));

        if (policy.scopeType === "company" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(companies)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(companies.id, policy.scopeId));
        }

        if (policy.scopeType === "agent" && policy.windowKind === "calendar_month_utc") {
          await db
            .update(agents)
            .set({ budgetMonthlyCents: nextAmount, updatedAt: now })
            .where(eq(agents.id, policy.scopeId));
        }

        await resumeScopeFromBudget(policy);
        await db
          .update(budgetIncidents)
          .set({
            status: "resolved",
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(eq(budgetIncidents.policyId, policy.id), eq(budgetIncidents.status, "open")));

        await markApprovalStatus(db, incident.approvalId ?? null, "approved", input.decisionNote, actorUserId);
      } else {
        await db
          .update(budgetIncidents)
          .set({
            status: "dismissed",
            resolvedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(budgetIncidents.id, incident.id));
        await markApprovalStatus(db, incident.approvalId ?? null, "rejected", input.decisionNote, actorUserId);
      }

      await logActivity(db, {
        companyId: incident.companyId,
        actorType: "user",
        actorId: actorUserId,
        action: "budget.incident_resolved",
        entityType: "budget_incident",
        entityId: incident.id,
        details: {
          action: input.action,
          amount: input.amount ?? null,
          scopeType: incident.scopeType,
          scopeId: incident.scopeId,
        },
      });

      const [updated] = await hydrateIncidentRows([{
        ...incident,
        status: input.action === "raise_budget_and_resume" ? "resolved" : "dismissed",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }]);
      return updated!;
    },
  };
}
