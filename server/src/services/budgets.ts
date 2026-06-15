import { and, desc, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  projects,
} from "@paperclipai/db";
import type {
  BudgetIncident,
  BudgetIncidentResolutionInput,
  BudgetMetric,
  BudgetOverview,
  BudgetPolicy,
  BudgetPolicySummary,
  BudgetPolicyUpsertInput,
  BudgetScopeType,
  BudgetThresholdType,
  BudgetWindowKind,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: "manual" | "budget" | "system" | null;
};

type PolicyRow = typeof budgetPolicies.$inferSelect;
type IncidentRow = typeof budgetIncidents.$inferSelect;

export type BudgetEnforcementScope = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
};

export type BudgetAlertPayload = {
  companyId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  scopeName: string;
  adapterName: string | null;
  thresholdType: "soft" | "hard";
  observedCents: number;
  limitCents: number;
  utilizationPercent: number;
  windowKind: BudgetWindowKind;
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
  onBudgetAlert?: (alert: BudgetAlertPayload) => Promise<void>;
};

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

function currentUtcDayWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, day + 1, 0, 0, 0, 0));
  return { start, end };
}

function resolveWindow(windowKind: BudgetWindowKind, now = new Date()) {
  if (windowKind === "lifetime") {
    return {
      start: new Date(Date.UTC(1970, 0, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(9999, 0, 1, 0, 0, 0, 0)),
    };
  }
  if (windowKind === "calendar_day_utc") {
    return currentUtcDayWindow(now);
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

async function resolveScopeRecord(
  db: Db,
  scopeType: BudgetScopeType,
  scopeId: string,
  adapterName?: string | null,
): Promise<ScopeRecord> {
  // Adapter scope: synthetic record — adapters cannot be paused as entities
  if (scopeType === "adapter") {
    const row = await db
      .select({ companyId: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, scopeId))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Company not found");
    return {
      companyId: row.companyId,
      name: adapterName ? `adapter:${adapterName}` : "adapter",
      paused: false,
      pauseReason: null,
    };
  }

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
  policy: Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric" | "adapterName">,
) {
  if (policy.metric !== "billed_cents") return 0;

  const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind);
  const windowConditions = policy.windowKind !== "lifetime"
    ? [gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)]
    : [];

  // Adapter scope: aggregate cost across all agents with matching adapterType
  if (policy.scopeType === "adapter" && policy.adapterName) {
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .innerJoin(agents, eq(costEvents.agentId, agents.id))
      .where(and(
        eq(costEvents.companyId, policy.companyId),
        eq(agents.adapterType, policy.adapterName),
        ...windowConditions,
      ));
    return Number(row?.total ?? 0);
  }

  const conditions = [eq(costEvents.companyId, policy.companyId), ...windowConditions];
  if (policy.scopeType === "agent") conditions.push(eq(costEvents.agentId, policy.scopeId));
  if (policy.scopeType === "project") conditions.push(eq(costEvents.projectId, policy.scopeId));

  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
    })
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

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
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
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId, policy.adapterName);
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
      adapterName: policy.adapterName ?? null,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      metric: policy.metric as BudgetMetric,
      windowKind: policy.windowKind as BudgetWindowKind,
      amount,
      observedAmount,
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      warnHighPercent: policy.warnHighPercent ?? 85,
      warnRecoveryPercent: policy.warnRecoveryPercent ?? 55,
      warnHighRecoveryPercent: policy.warnHighRecoveryPercent ?? 75,
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
  ): Promise<{ incident: IncidentRow; isNew: boolean } | null> {
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
    if (existing) return { incident: existing, isNew: false };

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

    const incident = await db
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

    return incident ? { incident, isNew: true } : null;
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

  async function checkAdapterCapBlock(companyId: string, adapterType: string) {
    const adapterPolicies = await db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, "adapter"),
          eq(budgetPolicies.adapterName, adapterType),
          eq(budgetPolicies.isActive, true),
          eq(budgetPolicies.metric, "billed_cents"),
        ),
      );

    for (const policy of adapterPolicies) {
      if (!policy.hardStopEnabled || policy.amount <= 0) continue;
      const observed = await computeObservedAmount(db, policy);
      if (observed >= policy.amount) {
        return {
          scopeType: "adapter" as BudgetScopeType,
          scopeId: policy.scopeId,
          scopeName: `adapter:${adapterType}`,
          reason: `Adapter '${adapterType}' daily budget cap reached (${observed}/${policy.amount} cents). Resets at UTC midnight.`,
        };
      }
    }
    return null;
  }

  return {
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        adapterName: row.adapterName ?? null,
        metric: row.metric as BudgetMetric,
        windowKind: row.windowKind as BudgetWindowKind,
      }));
    },

    upsertPolicy: async (
      companyId: string,
      input: BudgetPolicyUpsertInput,
      actorUserId: string | null,
    ): Promise<BudgetPolicySummary> => {
      const scope = await resolveScopeRecord(db, input.scopeType, input.scopeId, input.adapterName);
      if (scope.companyId !== companyId) {
        throw unprocessable("Budget scope does not belong to company");
      }

      const metric = input.metric ?? "billed_cents";
      const defaultWindow = input.scopeType === "project"
        ? "lifetime"
        : input.scopeType === "adapter"
          ? "calendar_day_utc"
          : "calendar_month_utc";
      const windowKind = input.windowKind ?? defaultWindow;
      const adapterName = input.scopeType === "adapter" ? (input.adapterName ?? null) : null;
      const amount = Math.max(0, Math.floor(input.amount));
      const nextIsActive = amount > 0 && (input.isActive ?? true);

      // Lookup by adapterName for adapter scope (adapterName is the unique identifier)
      const existingConditions = adapterName
        ? [
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, input.scopeType),
          eq(budgetPolicies.adapterName, adapterName),
          eq(budgetPolicies.metric, metric),
          eq(budgetPolicies.windowKind, windowKind),
        ]
        : [
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeType, input.scopeType),
          eq(budgetPolicies.scopeId, input.scopeId),
          eq(budgetPolicies.metric, metric),
          eq(budgetPolicies.windowKind, windowKind),
        ];

      const existing = await db
        .select()
        .from(budgetPolicies)
        .where(and(...existingConditions))
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            warnPercent: input.warnPercent ?? existing.warnPercent,
            warnHighPercent: input.warnHighPercent ?? existing.warnHighPercent,
            warnRecoveryPercent: input.warnRecoveryPercent ?? existing.warnRecoveryPercent,
            warnHighRecoveryPercent: input.warnHighRecoveryPercent ?? existing.warnHighRecoveryPercent,
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
            adapterName,
            metric,
            windowKind,
            amount,
            warnPercent: input.warnPercent ?? (input.scopeType === "adapter" ? 75 : 80),
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
          // Adapter scopes have no entity to resume; only non-adapter scopes need this
          if (input.scopeType !== "adapter") {
            await resumeScopeFromBudget(row);
          }
          await resolveOpenIncidentsForPolicy(row.id, actorUserId ? "approved" : null, actorUserId);
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          if (row.notifyEnabled && observedAmount >= softThreshold) {
            await createIncidentIfNeeded(row, "soft", observedAmount);
          }
          if (row.hardStopEnabled && observedAmount >= row.amount) {
            await resolveOpenSoftIncidents(row.id);
            await createIncidentIfNeeded(row, "hard", observedAmount);
            if (input.scopeType !== "adapter") {
              await pauseAndCancelScopeForBudget(row);
            }
          }
        }
      } else {
        if (input.scopeType !== "adapter") {
          await resumeScopeFromBudget(row);
        }
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
      // Fetch agent's adapterType so adapter-scope policies can be matched
      const agentRow = await db
        .select({ adapterType: agents.adapterType })
        .from(agents)
        .where(eq(agents.id, event.agentId))
        .then((rows) => rows[0] ?? null);
      const agentAdapterType = agentRow?.adapterType ?? null;

      const candidatePolicies = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, event.companyId),
            eq(budgetPolicies.isActive, true),
            inArray(budgetPolicies.scopeType, ["company", "agent", "project", "adapter"]),
          ),
        );

      const relevantPolicies = candidatePolicies.filter((policy) => {
        if (policy.scopeType === "company") return policy.scopeId === event.companyId;
        if (policy.scopeType === "agent") return policy.scopeId === event.agentId;
        if (policy.scopeType === "project") return Boolean(event.projectId) && policy.scopeId === event.projectId;
        if (policy.scopeType === "adapter") return agentAdapterType !== null && policy.adapterName === agentAdapterType;
        return false;
      });

      for (const policy of relevantPolicies) {
        if (policy.metric !== "billed_cents" || policy.amount <= 0) continue;
        const observedAmount = await computeObservedAmount(db, policy);
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);
        const utilizationPercent = Number(((observedAmount / policy.amount) * 100).toFixed(2));

        if (policy.notifyEnabled && observedAmount >= softThreshold) {
          const result = await createIncidentIfNeeded(policy, "soft", observedAmount);
          if (result) {
            const { incident: softIncident, isNew } = result;
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
                adapterName: policy.adapterName ?? null,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
              },
            });
            // Notify CEO only when the incident is newly created (avoid spam)
            if (isNew && hooks.onBudgetAlert) {
              const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId, policy.adapterName);
              await hooks.onBudgetAlert({
                companyId: policy.companyId,
                scopeType: policy.scopeType as BudgetScopeType,
                scopeId: policy.scopeId,
                scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
                adapterName: policy.adapterName ?? null,
                thresholdType: "soft",
                observedCents: observedAmount,
                limitCents: policy.amount,
                utilizationPercent,
                windowKind: policy.windowKind as BudgetWindowKind,
              });
            }
          }
        }

        if (policy.hardStopEnabled && observedAmount >= policy.amount) {
          await resolveOpenSoftIncidents(policy.id);
          const result = await createIncidentIfNeeded(policy, "hard", observedAmount);
          // Adapter policies cannot be entity-paused; hard-stop is enforced in getInvocationBlock
          if (policy.scopeType !== "adapter") {
            await pauseAndCancelScopeForBudget(policy);
          }
          if (result) {
            const { incident: hardIncident, isNew } = result;
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
                adapterName: policy.adapterName ?? null,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.approvalId ?? null,
              },
            });
            if (isNew && hooks.onBudgetAlert) {
              const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId, policy.adapterName);
              await hooks.onBudgetAlert({
                companyId: policy.companyId,
                scopeType: policy.scopeType as BudgetScopeType,
                scopeId: policy.scopeId,
                scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
                adapterName: policy.adapterName ?? null,
                thresholdType: "hard",
                observedCents: observedAmount,
                limitCents: policy.amount,
                utilizationPercent,
                windowKind: policy.windowKind as BudgetWindowKind,
              });
            }
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
          adapterType: agents.adapterType,
          costClass: agents.costClass,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
      if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
      const agentCostClass = (agent.costClass ?? "metered") as "free" | "metered" | "critical";

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
      if (agentPolicy && agentPolicy.amount > 0) {
        const observed = await computeObservedAmount(db, agentPolicy);
        const utilizationPct = (observed / agentPolicy.amount) * 100;

        // Hysteresis: if there is an open soft incident, use recovery thresholds
        // to avoid flapping between stages when utilization sits in the grey zone.
        const openSoftIncident = await db
          .select({ id: budgetIncidents.id })
          .from(budgetIncidents)
          .where(
            and(
              eq(budgetIncidents.policyId, agentPolicy.id),
              eq(budgetIncidents.thresholdType, "soft"),
              eq(budgetIncidents.status, "open"),
            ),
          )
          .then((rows) => rows[0] ?? null);

        const inActiveStage = openSoftIncident !== null;
        const warnPct = inActiveStage
          ? (agentPolicy.warnRecoveryPercent ?? 55)
          : (agentPolicy.warnPercent ?? 60);
        const warnHighPct = inActiveStage
          ? (agentPolicy.warnHighRecoveryPercent ?? 75)
          : (agentPolicy.warnHighPercent ?? 85);

        const stage = utilizationPct >= 100 ? 3
          : utilizationPct >= warnHighPct ? 2
          : utilizationPct >= warnPct ? 1
          : 0;

        if (stage > 0) {
          const agentBlock = {
            scopeType: "agent" as const,
            scopeId: agentId,
            scopeName: agent.name,
            reason: stage === 3
              ? "Agent cannot start because its budget hard-stop is still exceeded."
              : `Agent budget at stage ${stage} (${utilizationPct.toFixed(1)}% utilization).`,
          };
          if (stage === 3 && agentPolicy.hardStopEnabled) return agentBlock;
          if (stage === 2 && agentCostClass !== "critical") return agentBlock;
          if (stage === 1 && agentCostClass === "metered") return agentBlock;
        }
      }

      // Check adapter-level daily cap for the agent's adapter type
      if (agent.adapterType) {
        const adapterBlock = await checkAdapterCapBlock(companyId, agent.adapterType);
        if (adapterBlock) return adapterBlock;
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

    getCompanyGuardrailLevel: async (companyId: string): Promise<{ level: 0 | 1 | 2 | 3; utilizationPercent: number }> => {
      const policy = await db
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

      if (!policy || policy.amount <= 0) {
        return { level: 0, utilizationPercent: 0 };
      }

      const observed = await computeObservedAmount(db, policy);
      const utilizationPercent = Number(((observed / policy.amount) * 100).toFixed(2));
      const warnPct = policy.warnPercent ?? 60;
      const warnHighPct = policy.warnHighPercent ?? 85;

      const level: 0 | 1 | 2 | 3 =
        utilizationPercent >= 100 ? 3
        : utilizationPercent >= warnHighPct ? 2
        : utilizationPercent >= warnPct ? 1
        : 0;

      return { level, utilizationPercent };
    },

    getAdapterInvocationBlock: checkAdapterCapBlock,

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
