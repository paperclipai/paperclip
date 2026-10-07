import { compareCents, normalizeCents } from "@paperclipai/shared";
import { and, desc, eq, gte, inArray, lt, ne, sql, or, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { recordAgentStatusEvent } from "./resource-lifecycle-events.js";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  heartbeatRuns,
  nativeRunFinalizations,
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
import { HttpError, notFound, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { logActivity, type LogActivityInput, type ActivityPublication } from "./activity-log.js";

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
  /** Snapshot taken under the company lock, before a later budget grant can admit new work. */
  createdBefore?: Date;
  /** Revalidated at the durable cancellation write, under the admission lock. */
  enforcement?: { policyId: string; version: number };
};

export type BudgetServiceHooks = {
  cancelWorkForScope?: (scope: BudgetEnforcementScope) => Promise<void>;
};

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
  observedAmount: string,
  amount: number,
  warnPercent: number,
): BudgetPolicySummary["status"] {
  if (amount <= 0) return "ok";
  if (compareCents(observedAmount, amount) >= 0) return "hard_stop";
  if (compareCents(observedAmount, Math.ceil((amount * warnPercent) / 100)) >= 0) return "warning";
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

// Keep a large dashboard from filling the database pool with queued reads.
async function mapBudgetReads<T, R>(rows: T[], read: (row: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let start = 0; start < rows.length; start += 4) {
    result.push(...await Promise.all(rows.slice(start, start + 4).map(read)));
  }
  return result;
}

/** Filter in PostgreSQL so one run never loads unrelated agents' policies. */
export function budgetPoliciesForRun(companyId: string, agentId: string | null, projectId: string | null) {
  return or(
    and(eq(budgetPolicies.scopeType, "company"), eq(budgetPolicies.scopeId, companyId)),
    agentId ? and(eq(budgetPolicies.scopeType, "agent"), eq(budgetPolicies.scopeId, agentId)) : undefined,
    projectId ? and(eq(budgetPolicies.scopeType, "project"), eq(budgetPolicies.scopeId, projectId)) : undefined,
  );
}

type SpendPolicy = Pick<PolicyRow, "companyId" | "scopeType" | "scopeId" | "windowKind" | "metric">;
type ObservedSpend = { windowStart: Date; windowEnd: Date; total: number; totalExact: string; unpricedEventCount: number; pendingRunCount: number; recoveringRunCount: number };

/** One ledger scan and one pending-run scan for the affected policies. The
 * company lock still protects decisions; nothing is cached across mutations.
 * Each aggregate keeps its own scope/window, including mixed lifetime and
 * monthly policies. An outer predicate excludes rows no policy needs. */
async function computeObservedSpends(db: Db, policies: SpendPolicy[]): Promise<ObservedSpend[]> {
  const now = new Date();
  const windows = policies.map(policy => resolveWindow(policy.windowKind as BudgetWindowKind, now));
  const billable = policies.map((policy, index) => ({ policy, index })).filter(({ policy }) => policy.metric === "billed_cents");
  const ledgerColumns: Record<string, SQL> = {};
  const pendingColumns: Record<string, SQL> = {};
  const ledgerPredicates: SQL[] = [], pendingPredicates: SQL[] = [];
  for (const { policy, index } of billable) {
    const { start, end } = windows[index];
    const ledger = and(
      eq(costEvents.companyId, policy.companyId),
      policy.scopeType === "agent" ? eq(costEvents.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? eq(costEvents.projectId, policy.scopeId) : undefined,
      policy.windowKind === "calendar_month_utc" ? and(gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)) : undefined,
    )!;
    const pending = and(
      eq(heartbeatRuns.companyId, policy.companyId), eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]),
      policy.scopeType === "agent" ? eq(heartbeatRuns.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? sql`${heartbeatRuns.usageJson}->'ledgerScope'->>'projectId' = ${policy.scopeId}` : undefined,
      policy.windowKind === "calendar_month_utc" ? sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${start.toISOString()}::timestamptz
        and coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) < ${end.toISOString()}::timestamptz` : undefined,
    )!;
    ledgerPredicates.push(ledger); pendingPredicates.push(pending);
    ledgerColumns[`total${index}`] = sql`coalesce(sum(${costEvents.costCents}) filter (where ${ledger}), 0)::text`;
    ledgerColumns[`unpriced${index}`] = sql`count(*) filter (where ${ledger} and ${costEvents.costStatus} = 'unpriced' and ${costEvents.billingType} <> 'subscription_included')::int`;
    pendingColumns[`pending${index}`] = sql`count(*) filter (where ${pending})::int`;
    pendingColumns[`recovering${index}`] = sql`count(*) filter (where ${pending} and ${heartbeatRuns.runtimeMode} = 'native'
      and exists (select 1 from ${nativeRunFinalizations} where ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId}
        and ${nativeRunFinalizations.resultId} is null and ${nativeRunFinalizations.phase} <> 'terminal_failure'))::int`;
  }
  const [ledger = {}] = billable.length ? await db.select(ledgerColumns).from(costEvents).where(or(...ledgerPredicates)) : [];
  const [pending = {}] = billable.length ? await db.select(pendingColumns).from(heartbeatRuns).where(or(...pendingPredicates)) : [];
  return policies.map((_, index) => ({
    windowStart: windows[index].start, windowEnd: windows[index].end,
    total: Number(ledger[`total${index}`] ?? 0), totalExact: normalizeCents(String(ledger[`total${index}`] ?? 0)),
    unpricedEventCount: Number(ledger[`unpriced${index}`] ?? 0), pendingRunCount: Number(pending[`pending${index}`] ?? 0),
    recoveringRunCount: Number(pending[`recovering${index}`] ?? 0),
  }));
}

export async function computeObservedSpend(db: Db, policy: SpendPolicy) {
  return (await computeObservedSpends(db, [policy]))[0];
}

function observedBlocks(policy: PolicyRow, observed: Awaited<ReturnType<typeof computeObservedSpend>>) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return compareCents(observed.totalExact, policy.amount) >= 0 || (observed.pendingRunCount - observed.recoveringRunCount) > 0 || (policy.unpricedUsagePolicy !== "allow" && observed.unpricedEventCount > 0);
}
async function policyBlocks(db: Db, policy: PolicyRow) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return observedBlocks(policy, await computeObservedSpend(db, policy));
}

function buildApprovalPayload(input: {
  policy: PolicyRow;
  scopeName: string;
  thresholdType: BudgetThresholdType;
  amountObserved: number;
  amountObservedExact: string;
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
    observedAmountExact: input.amountObservedExact,
    warnPercent: input.policy.warnPercent,
    windowStart: input.windowStart.toISOString(),
    windowEnd: input.windowEnd.toISOString(),
    policyId: input.policy.id,
    guidance: "Resolve pending or unpriced accounting, raise the budget, or keep the scope paused.",
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

/** Internal: caller must hold the company accounting transaction lock. */
export function budgetServiceInTransaction(db: Db, publications: ActivityPublication[] = []) {
  const recordActivity = (input: LogActivityInput) => logActivity(db, input, publications);
  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db.transaction(async tx => {
        const [agent] = await tx.select().from(agents)
          .where(and(eq(agents.id, policy.scopeId), eq(agents.companyId, policy.companyId))).for("update");
        if (agent && ["active", "idle", "running", "error"].includes(agent.status)) {
          await tx.update(agents).set({ status: "paused", pauseReason: "budget", pausedAt: now, updatedAt: now })
            .where(eq(agents.id, agent.id));
          await recordAgentStatusEvent(tx as unknown as Db, agent.companyId, agent.id, agent.status, "paused");
        }
      });
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
        .where(and(eq(projects.id, policy.scopeId), or(isNull(projects.pausedAt), eq(projects.pauseReason, "budget"))));
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
      .where(and(eq(companies.id, policy.scopeId), or(eq(companies.status, "active"), and(eq(companies.status, "paused"), eq(companies.pauseReason, "budget")))));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow) {
    await pauseScopeForBudget(policy);
    await db.update(budgetPolicies).set({
      enforcementVersion: sql`${budgetPolicies.enforcementVersion} + 1`,
    }).where(eq(budgetPolicies.id, policy.id));
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    const policies = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, policy.companyId), eq(budgetPolicies.scopeType, policy.scopeType),
      eq(budgetPolicies.scopeId, policy.scopeId), eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true),
    ));
    for (const candidate of policies) {
      if (await policyBlocks(db, candidate)) return;
    }
    const now = new Date();
    if (policy.scopeType === "agent") {
      await db.transaction(async tx => {
        const [agent] = await tx.select().from(agents)
          .where(and(eq(agents.id, policy.scopeId), eq(agents.companyId, policy.companyId))).for("update");
        if (agent?.status === "paused" && agent.pauseReason === "budget") {
          await tx.update(agents).set({ status: "idle", pauseReason: null, pausedAt: null, updatedAt: now })
            .where(eq(agents.id, agent.id));
          await recordAgentStatusEvent(tx as unknown as Db, agent.companyId, agent.id, agent.status, "idle");
        }
      });
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
      .where(and(eq(companies.id, policy.scopeId), eq(companies.status, "paused"), eq(companies.pauseReason, "budget")));
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
    const observed = await computeObservedSpend(db, policy);
    const { total: observedAmount, totalExact: observedAmountExact, unpricedEventCount, pendingRunCount } = observed;
    const { windowStart: start, windowEnd: end } = observed;
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
      observedAmountExact,
      reservationCents: policy.reservationCents,
      unpricedEventCount,
      pendingRunCount,
      unpricedUsagePolicy: policy.unpricedUsagePolicy as "block" | "allow",
      remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
      utilizationPercent,
      warnPercent: policy.warnPercent,
      hardStopEnabled: policy.hardStopEnabled,
      notifyEnabled: policy.notifyEnabled,
      isActive: policy.isActive,
      status: observedBlocks(policy, observed) ? "hard_stop" : policy.isActive
        ? budgetStatusFromObserved(observedAmountExact, amount, policy.warnPercent)
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
    observed: Awaited<ReturnType<typeof computeObservedSpend>>,
  ) {
    const { windowStart: start, windowEnd: end } = observed;
    const existing = await db
      .select()
      .from(budgetIncidents)
      .where(
        and(
          eq(budgetIncidents.policyId, policy.id),
          eq(budgetIncidents.windowStart, start),
          eq(budgetIncidents.thresholdType, thresholdType),
          or(eq(budgetIncidents.status, "open"), and(eq(budgetIncidents.status, "dismissed"), eq(budgetIncidents.amountLimit, policy.amount))),
        ),
      )
      .orderBy(desc(budgetIncidents.createdAt))
      .then((rows) => rows[0] ?? null);
    if (existing) return { incident: existing, created: false };

    const { total: amountObserved, totalExact: amountObservedExact } = observed;
    const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
    const payload = buildApprovalPayload({
      policy,
      scopeName: normalizeScopeName(policy.scopeType as BudgetScopeType, scope.name),
      thresholdType,
      amountObserved,
      amountObservedExact,
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
        amountObserved: sql`${amountObservedExact}::numeric`,
        status: "open",
        approvalId: approval?.id ?? null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    return incident ? { incident, created: true } : null;
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
    thresholdType?: BudgetThresholdType,
  ) {
    const condition = and(eq(budgetIncidents.policyId, policyId), eq(budgetIncidents.status, "open"),
      thresholdType ? eq(budgetIncidents.thresholdType, thresholdType) : undefined);
    const openRows = await db
      .select()
      .from(budgetIncidents)
      .where(condition);

    await db
      .update(budgetIncidents)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(condition);

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

    return mapBudgetReads(rows, async (row) => {
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
    });
  }

  async function reconcileScope(companyId: string, scopeType: BudgetScopeType, scopeId: string) {
    const scope = await resolveScopeRecord(db, scopeType, scopeId);
    if (scope.companyId !== companyId) throw notFound("Budget scope not found");
    const policies = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, scopeType), eq(budgetPolicies.scopeId, scopeId),
    ));
    let recoveringPolicy: PolicyRow | undefined;
    for (const policy of policies) {
      const observed = await computeObservedSpend(db, policy);
      if (observedBlocks(policy, observed)) {
        await createIncidentIfNeeded(policy, "hard", observed);
        await pauseAndCancelScopeForBudget(policy);
        const title = scopeType === "company" ? "Company" : scopeType === "agent" ? "Agent" : "Project";
        if (observed.pendingRunCount > 0) {
          return { scopeType, scopeId, scopeName: scope.name, reason: `${title} cannot start work while completed runs await accounting.` };
        }
        if (policy.unpricedUsagePolicy !== "allow" && observed.unpricedEventCount > 0) {
          return { scopeType, scopeId, scopeName: scope.name, reason: `${title} cannot start work because recorded usage has no reliable price.` };
        }
        return { scopeType, scopeId, scopeName: scope.name, reason: scopeType === "project"
          ? "Project cannot start work because its budget hard-stop is still exceeded."
          : `${title} is paused because its budget hard-stop was reached.` };
      }
      // An open native coordinator must finish the original run's accounting.
      // Deny fresh work without pausing/cancelling that recovery or its hold.
      if (policy.isActive && policy.hardStopEnabled && policy.amount > 0 && observed.recoveringRunCount > 0) recoveringPolicy ??= policy;
      // A closed UTC window, inactive policy, or budget raise releases only
      // budget-owned pauses. Manual pauses remain operator decisions.
      await resolveOpenIncidentsForPolicy(policy.id, "approved", "budget_service", "hard");
      if (!policy.isActive || !policy.notifyEnabled || compareCents(observed.totalExact, Math.ceil(policy.amount * policy.warnPercent / 100)) < 0) {
        await resolveOpenIncidentsForPolicy(policy.id, "approved", "budget_service", "soft");
      }
    }
    // Agent status has its own admission gate and error code. Preserve a
    // manual pause without misclassifying it as a budget failure.
    if (scopeType !== "agent" && scope.paused && scope.pauseReason !== "budget") {
      return { scopeType, scopeId, scopeName: scope.name, reason: `${scopeType === "company" ? "Company" : "Project"} is paused and cannot start new work.` };
    }
    if (scope.paused && scope.pauseReason === "budget" && !policies.length) {
      return { scopeType, scopeId, scopeName: scope.name, reason: "Budget pause requires a policy or an explicit operator resume." };
    }
    if (scope.pauseReason === "budget" && policies[0]) await resumeScopeFromBudget(policies[0]);
    if (recoveringPolicy) return { scopeType, scopeId, scopeName: scope.name,
      reason: "New work must wait while a native run recovers its unfinished accounting." };
    return null;
  }

  return {
    reconcileScope,
    listPolicies: async (companyId: string): Promise<BudgetPolicy[]> => {
      const rows = await listPolicyRows(companyId);
      return rows.map((row) => ({
        ...row,
        scopeType: row.scopeType as BudgetScopeType,
        unpricedUsagePolicy: row.unpricedUsagePolicy as "block" | "allow",
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

      if (input.reservationCents !== undefined && compareCents(input.reservationCents, 0) < 0) throw unprocessable("Reservation cannot be negative");
      const metric = input.metric ?? "billed_cents";
      const windowKind = input.windowKind ?? (input.scopeType === "project" ? "lifetime" : "calendar_month_utc");
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

      if (!existing && input.amount === undefined) throw unprocessable("Amount is required for a new budget policy");
      const amount = Math.max(0, Math.floor(input.amount ?? existing!.amount));
      // A saved zero disables enforcement. Raising it is an explicit limit
      // setting; editing a disabled positive policy must preserve that choice.
      const nextIsActive = amount > 0 && (input.isActive ?? (existing?.amount === 0 ? true : existing?.isActive) ?? true);
      const now = new Date();
      const row = existing
        ? await db
          .update(budgetPolicies)
          .set({
            amount,
            reservationCents: normalizeCents(input.reservationCents ?? existing.reservationCents ?? 0),
            warnPercent: input.warnPercent ?? existing.warnPercent,
            hardStopEnabled: input.hardStopEnabled ?? existing.hardStopEnabled,
            notifyEnabled: input.notifyEnabled ?? existing.notifyEnabled,
            unpricedUsagePolicy: input.unpricedUsagePolicy ?? existing.unpricedUsagePolicy,
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
            reservationCents: normalizeCents(input.reservationCents ?? 0),
            warnPercent: input.warnPercent ?? 80,
            hardStopEnabled: input.hardStopEnabled ?? true,
            notifyEnabled: input.notifyEnabled ?? true,
            unpricedUsagePolicy: input.unpricedUsagePolicy ?? "block",
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

      if (row.isActive && amount > 0) {
        const observed = await computeObservedSpend(db, row);
        if (!observedBlocks(row, observed)) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, "approved", actorUserId ?? "budget_service", "hard");
          if (row.notifyEnabled && compareCents(observed.totalExact, Math.ceil(row.amount * row.warnPercent / 100)) >= 0) {
            await createIncidentIfNeeded(row, "soft", observed);
          } else {
            await resolveOpenIncidentsForPolicy(row.id, null, null, "soft");
          }
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          if (row.notifyEnabled && compareCents(observed.totalExact, softThreshold) >= 0 && (!row.hardStopEnabled || compareCents(observed.totalExact, row.amount) < 0)) {
            await createIncidentIfNeeded(row, "soft", observed);
          }
          if (observedBlocks(row, observed)) {
            await resolveOpenSoftIncidents(row.id);
            await createIncidentIfNeeded(row, "hard", observed);
            await pauseAndCancelScopeForBudget(row);
          }
        }
      } else {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, "approved", actorUserId ?? "budget_service");
      }

      await recordActivity({
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
      const policies = await mapBudgetReads(rows, buildPolicySummary);
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
        pausedAgentCount: new Set(policies.filter((policy) => policy.scopeType === "agent" && policy.paused).map((policy) => policy.scopeId)).size,
        pausedProjectCount: new Set(policies.filter((policy) => policy.scopeType === "project" && policy.paused).map((policy) => policy.scopeId)).size,
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
            budgetPoliciesForRun(event.companyId, event.agentId, event.projectId),
          ),
        );

      const policies = candidatePolicies.filter(policy => policy.metric === "billed_cents" && policy.amount > 0);
      const observations = await computeObservedSpends(db, policies);
      for (const [index, policy] of policies.entries()) {
        const observed = observations[index];
        const observedAmount = observed.total;
        const softThreshold = Math.ceil((policy.amount * policy.warnPercent) / 100);

        if (policy.notifyEnabled && compareCents(observed.totalExact, softThreshold) >= 0 && (!policy.hardStopEnabled || compareCents(observed.totalExact, policy.amount) < 0)) {
          const softIncident = await createIncidentIfNeeded(policy, "soft", observed);
          if (softIncident?.created) {
            await recordActivity({
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.soft_threshold_crossed",
              entityType: "budget_incident",
              entityId: softIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
              },
            });
          }
        }

        if (observedBlocks(policy, observed)) {
          await resolveOpenSoftIncidents(policy.id);
          const hardIncident = await createIncidentIfNeeded(policy, "hard", observed);
          await pauseAndCancelScopeForBudget(policy);
          if (hardIncident?.created) {
            await recordActivity({
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.hard_threshold_crossed",
              entityType: "budget_incident",
              entityId: hardIncident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                amountObserved: observedAmount,
                amountLimit: policy.amount,
                approvalId: hardIncident.incident.approvalId ?? null,
              },
            });
          }
        }
      }
    },

    getInvocationBlock: async (
      companyId: string,
      agentId: string | null,
      context?: { issueId?: string | null; projectId?: string | null },
    ) => {
      const scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [
        { scopeType: "company", scopeId: companyId }, ...(agentId ? [{ scopeType: "agent" as const, scopeId: agentId }] : []),
        ...(context?.projectId ? [{ scopeType: "project" as const, scopeId: context.projectId }] : []),
      ];
      for (const { scopeType, scopeId } of scopes) {
        if ((await resolveScopeRecord(db, scopeType, scopeId)).companyId !== companyId) throw notFound("Budget scope not found");
      }
      for (const { scopeType, scopeId } of scopes) {
        const block = await reconcileScope(companyId, scopeType, scopeId);
        if (block) return block;
      }
      return null;
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
        const observed = await computeObservedSpend(db, policy);
        if (policy.unpricedUsagePolicy !== "allow" && observed.unpricedEventCount > 0) {
          throw unprocessable("Resolve unpriced usage or explicitly allow it in the budget policy before resuming");
        }
        if (observed.pendingRunCount > 0) throw unprocessable("Completed runs must finish accounting before resuming");
        if (compareCents(observed.totalExact, nextAmount) >= 0) {
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

      await recordActivity({
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

/** Fence the durable stop intent against policy edits and admission. External
 * process shutdown must happen after this transaction, without holding locks
 * that the executor needs to persist its final usage receipt. */
export async function withCurrentBudgetEnforcement<T>(db: Db, scope: BudgetEnforcementScope, work: (tx: Db) => Promise<T>): Promise<T | null> {
  return withAccountingTransaction(db, scope.companyId, async (tx) => {
    if (scope.enforcement) {
      const [policy] = await tx.select().from(budgetPolicies).where(and(
        eq(budgetPolicies.id, scope.enforcement.policyId), eq(budgetPolicies.companyId, scope.companyId),
      ));
      if (!policy || policy.scopeType !== scope.scopeType || policy.scopeId !== scope.scopeId
        || policy.enforcementVersion !== scope.enforcement.version || !(await policyBlocks(tx, policy))) return null;
    }
    return work(tx);
  });
}

/** Cancellation is an at-least-once external effect. A failed delivery never
 * rolls back committed spend, and its version remains pending for recovery. */
export async function deliverBudgetEnforcement(db: Db, hooks: BudgetServiceHooks, companyId?: string) {
  if (!hooks.cancelWorkForScope) return;
  const pending = await db.select().from(budgetPolicies).where(and(
    sql`${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}`,
    companyId ? eq(budgetPolicies.companyId, companyId) : undefined,
  ));
  for (const policy of pending) {
    try {
      const cancellation = await withAccountingTransaction(db, policy.companyId, async (tx) => {
        const [current] = await tx.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
        if (!current || current.enforcementVersion !== policy.enforcementVersion || !(await policyBlocks(tx, current))) return null;
        return { companyId: policy.companyId, scopeType: policy.scopeType as BudgetScopeType, scopeId: policy.scopeId, createdBefore: new Date(), enforcement: { policyId: policy.id, version: policy.enforcementVersion } };
      });
      if (cancellation) await hooks.cancelWorkForScope(cancellation);
      await db.update(budgetPolicies).set({ enforcementDeliveredVersion: policy.enforcementVersion })
        .where(and(eq(budgetPolicies.id, policy.id), eq(budgetPolicies.enforcementVersion, policy.enforcementVersion)));
    } catch (error) {
      logger.warn({ err: error, policyId: policy.id }, "Budget cancellation delivery pending; accounting is committed");
    }
  }
}

export function budgetService(db: Db, hooks: BudgetServiceHooks = {}) {
  const reads = budgetServiceInTransaction(db);
  async function mutate<T>(companyId: string, work: (service: ReturnType<typeof budgetServiceInTransaction>) => Promise<T>) {
    const result = await withAccountingTransaction(db, companyId, (tx, publications) => work(budgetServiceInTransaction(tx, publications)));
    await deliverBudgetEnforcement(db, hooks, companyId);
    return result;
  }
  return {
    ...reads,
    deliverPendingEnforcement: (companyId?: string) => deliverBudgetEnforcement(db, hooks, companyId),
    reconcilePolicies: async () => {
      const scopes = await db.selectDistinct({ companyId: budgetPolicies.companyId, scopeType: budgetPolicies.scopeType, scopeId: budgetPolicies.scopeId })
        .from(budgetPolicies).orderBy(budgetPolicies.companyId, budgetPolicies.scopeType, budgetPolicies.scopeId);
      // Each scope commits independently: deleted targets and a failed scope
      // must not roll back recovery or cancellation delivery for other work.
      for (const scope of scopes) {
        try {
          await mutate(scope.companyId, (service) => service.reconcileScope(scope.companyId, scope.scopeType as BudgetScopeType, scope.scopeId));
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) continue;
          logger.warn({ err: error, ...scope }, "Budget scope recovery pending; continuing remaining scopes");
        }
      }
    },
    upsertPolicy: (companyId: string, input: BudgetPolicyUpsertInput, actorUserId: string | null) =>
      mutate(companyId, (service) => service.upsertPolicy(companyId, input, actorUserId)),
    evaluateCostEvent: (event: typeof costEvents.$inferSelect) =>
      mutate(event.companyId, (service) => service.evaluateCostEvent(event)),
    getInvocationBlock: (companyId: string, agentId: string | null, context?: { issueId?: string | null; projectId?: string | null }) =>
      mutate(companyId, (service) => service.getInvocationBlock(companyId, agentId, context)),
    resolveIncident: (companyId: string, incidentId: string, input: BudgetIncidentResolutionInput, actorUserId: string) =>
      mutate(companyId, (service) => service.resolveIncident(companyId, incidentId, input, actorUserId)),
  };
}
