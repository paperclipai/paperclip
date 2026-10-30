import { notifyApprovalWork } from "./approval-work-notifications.js";
import { notifyCompanyRetentionWork } from "./retention-work-notifications.js";
import { addCents, compareCents, normalizeCents } from "@paperclipai/shared";
import { and, desc, eq, inArray, sql, or, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  budgetReservations,
  companies,
  costEvents,
  heartbeatRuns,
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
import { computeObservedSpend, computeObservedSpends, type ObservedSpend } from "./budget-exposure.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { listPendingBudgetCancellationScopes } from "./heartbeat/budget-cancellation.js";
import { withBudgetSpan } from "./budget-tracing.js";
export { computeObservedSpend, computeObservedSpends } from "./budget-exposure.js";
export type { BudgetExposure } from "./budget-exposure.js";

type ScopeRecord = {
  companyId: string;
  name: string;
  paused: boolean;
  pauseReason: PauseReason | null;
  budgetHeld: boolean;
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
      budgetHeld: row.pauseReason === "budget",
    };
  }

  if (scopeType === "agent") {
    const row = await db
      .select({
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        pauseReason: agents.pauseReason,
        lifecycleHolds: agents.lifecycleHolds,
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
      budgetHeld: row.lifecycleHolds.includes("budget"),
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
    budgetHeld: row.pauseReason === "budget",
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

function unpricedUsageBlocks(policy: PolicyRow, observed: ObservedSpend) {
  return policy.unpricedUsagePolicy !== "allow"
    && (observed.unpricedEventCount > 0 || observed.unknownBrowserRunCount > 0);
}

/** A run's cost ledger entry normally lands within moments of it finishing.
 * Before this many milliseconds elapse, `cost_accounting_pending = true` is
 * expected settlement latency, not a stuck run — it must not read as a budget
 * breach or block fresh work. Past this window the run counts as genuinely
 * stale and surfaces as such (see `stalePendingRunCount` below). Kept in sync
 * with the longer watchdog-alert window in accounting-integrity.ts, which
 * only pages operators once a run has been stuck much longer than this.
 * See JEN-42. */
export const ACCOUNTING_PENDING_GRACE_MS = 5 * 60 * 1000;

/** A run that never produced a usage receipt cannot be settled no matter how long
 * it is waited on — the provider process died mid-turn, the receipt spool lost it,
 * or the capture failed. Past this age the debt stops blocking new work; the gap
 * stays visible through accountingLastError and the integrity report, and a late
 * receipt is still replayed when it arrives. Without an upper bound a single lost
 * receipt paused an agent permanently (spend $0, pause_reason 'budget'). */
export const ACCOUNTING_ABANDONED_MS = 10 * 60 * 1000;

const STALE_PENDING_RUN_ID_SAMPLE = 5;

type StalePendingRunInfo = { stalePendingRunCount: number; stalePendingRunIds: string[] };

/** budget-exposure's ObservedSpend only carries a count of pending runs, not
 * their age or ids — not enough to tell "still settling" apart from "stuck."
 * This module-local extension adds that, so a hard-stop decision (and its
 * message) can name the actual stale runs instead of blocking on any pending
 * accounting at all. See JEN-42. */
export type ObservedSpendWithStalePending = ObservedSpend & StalePendingRunInfo;

/** Batched per-policy scan of terminal runs whose accounting is still
 * pending past ACCOUNTING_PENDING_GRACE_MS. Mirrors the "pending run" scope
 * predicate that budget-exposure.ts aggregates into `pendingRunCount`, but
 * keyed on run age instead of just existence — that aggregate alone cannot
 * tell a run that finished moments ago from one stuck for hours. */
async function computeStalePendingRunInfo(db: Db, policies: PolicyRow[], now = new Date()): Promise<StalePendingRunInfo[]> {
  const billable = policies.map((policy, index) => ({ policy, index })).filter(({ policy }) => policy.metric === "billed_cents");
  const staleCutoff = new Date(now.getTime() - ACCOUNTING_PENDING_GRACE_MS);
  const columns: Record<string, SQL> = {};
  const predicates: SQL[] = [];
  for (const { policy, index } of billable) {
    const { start, end } = resolveWindow(policy.windowKind as BudgetWindowKind, now);
    const inWindow = policy.windowKind === "calendar_month_utc"
      ? sql`coalesce(${heartbeatRuns.finishedAt}, ${now.toISOString()}::timestamptz) >= ${start.toISOString()}::timestamptz
        and coalesce(${heartbeatRuns.finishedAt}, ${now.toISOString()}::timestamptz) < ${end.toISOString()}::timestamptz` : sql`true`;
    const scoped = and(
      eq(heartbeatRuns.companyId, policy.companyId),
      eq(heartbeatRuns.costAccountingPending, true),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "cancelled", "interrupted"]),
      policy.scopeType === "agent" ? eq(heartbeatRuns.agentId, policy.scopeId) : undefined,
      policy.scopeType === "project" ? sql`${heartbeatRuns.usageJson}->'ledgerScope'->>'projectId' = ${policy.scopeId}` : undefined,
      inWindow,
    )!;
    const abandonedCutoff = new Date(now.getTime() - ACCOUNTING_ABANDONED_MS);
    const stale = and(
      scoped,
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) < ${staleCutoff.toISOString()}::timestamptz`,
      sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${abandonedCutoff.toISOString()}::timestamptz`,
    )!;
    predicates.push(scoped);
    columns[`count${index}`] = sql`count(*) filter (where ${stale})::int`;
    columns[`ids${index}`] = sql`coalesce(array_agg(${heartbeatRuns.id}::text order by coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}))
      filter (where ${stale}), '{}')`;
  }
  const [row = {}] = billable.length ? await db.select(columns).from(heartbeatRuns).where(or(...predicates)) : [];
  return policies.map((_, index) => ({
    stalePendingRunCount: Number(row[`count${index}`] ?? 0),
    stalePendingRunIds: ((row[`ids${index}`] ?? []) as string[]).slice(0, STALE_PENDING_RUN_ID_SAMPLE),
  }));
}

async function computeObservedSpendsWithStalePending(db: Db, policies: PolicyRow[]): Promise<ObservedSpendWithStalePending[]> {
  const [observed, stale] = await Promise.all([computeObservedSpends(db, policies), computeStalePendingRunInfo(db, policies)]);
  return observed.map((entry, index) => ({ ...entry, ...stale[index] }));
}

async function computeObservedSpendWithStalePending(db: Db, policy: PolicyRow): Promise<ObservedSpendWithStalePending> {
  return (await computeObservedSpendsWithStalePending(db, [policy]))[0];
}

/** A block triggered purely by unsettled accounting (stale pending runs) or
 * unpriced usage is real, but it is not a spend breach — `observed.total` is
 * frequently $0 in that case. Callers that write an incident or a pause
 * reason must say so explicitly instead of letting a $0-observed "hard stop"
 * read as a false overspend claim. See JEN-42. */
export type BudgetBlockReason = "spend_exceeded" | "accounting_pending" | "unpriced_usage";

function observedBlockReasons(policy: PolicyRow, observed: ObservedSpendWithStalePending): BudgetBlockReason[] {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return [];
  const reasons: BudgetBlockReason[] = [];
  if (compareCents(observed.totalExact, policy.amount) >= 0) reasons.push("spend_exceeded");
  // Pending accounting younger than ACCOUNTING_PENDING_GRACE_MS is expected
  // settlement latency, not a stuck run — only genuinely stale pending runs
  // block fresh work, and never one an active native recovery already owns.
  if ((observed.stalePendingRunCount - observed.recoveringRunCount) > 0) reasons.push("accounting_pending");
  if (unpricedUsageBlocks(policy, observed)) reasons.push("unpriced_usage");
  return reasons;
}

function observedBlocks(policy: PolicyRow, observed: ObservedSpendWithStalePending) {
  return observedBlockReasons(policy, observed).length > 0;
}
export async function policyBlocks(db: Db, policy: PolicyRow) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return observedBlocks(policy, await computeObservedSpendWithStalePending(db, policy));
}

/** Supplemental handoff check after authoritative accounting admission commits.
 * Read only: the caller can hold issue/run ownership, so this must never take
 * the company lock, reconcile holds, or deliver effects. A later concurrent
 * charge targets already-admitted work through the normal durable Stop path. */
export async function recheckAdmittedRunBudgetReadOnly(db: Db, input: {
  companyId: string; agentId: string; runId: string; projectId: string | null; reservationId: string;
}): Promise<string | null> {
  return withBudgetSpan("budget.admission.evaluate", async () => {
    const [reservation] = await db.select({ amountCents: budgetReservations.amountCents }).from(budgetReservations).where(and(
      eq(budgetReservations.id, input.reservationId), eq(budgetReservations.companyId, input.companyId),
      eq(budgetReservations.runId, input.runId), eq(budgetReservations.agentId, input.agentId),
      sql`${budgetReservations.projectId} is not distinct from ${input.projectId}::uuid`,
      eq(budgetReservations.state, "held"),
    ));
    if (!reservation) return "Provider dispatch no longer owns a held budget reservation";
    const policies = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, input.companyId),
      eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true), eq(budgetPolicies.metric, "billed_cents"),
      sql`${budgetPolicies.amount} > 0`, budgetPoliciesForRun(input.companyId, input.agentId, input.projectId)));
    const observations = await computeObservedSpendsWithStalePending(db, policies);
    for (const [index, policy] of policies.entries()) {
      const observed = observations[index];
      if (observedBlocks(policy, observed)) return "Applicable budget no longer permits provider work";
      const capacity = compareCents(addCents(observed.ledgerCents, observed.effectiveHeldCents), policy.amount);
      if (capacity > 0 || (compareCents(reservation.amountCents, 0) === 0 && capacity >= 0))
        return "Available budget is reserved by unfinished runs";
    }
    return null;
  });
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
  const [approval] = await db.select({ companyId: approvals.companyId }).from(approvals).where(eq(approvals.id, approvalId));
  if (!approval) return;
  await notifyApprovalWork(db, approval.companyId, { approvalId });
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
      const { applyAgentBudgetHoldInTransaction } = await import("./agent-lifecycle.js");
      await applyAgentBudgetHoldInTransaction(db, policy.companyId, policy.scopeId, true);
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
        .where(and(eq(projects.id, policy.scopeId), isNull(projects.pausedAt)));
      return;
    }

    const scope = await resolveScopeRecord(db, "company", policy.scopeId);
    if (scope.paused) return;
    await notifyCompanyRetentionWork(db, policy.companyId);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.agentTimers);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.routineSchedules);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.issueMonitors);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, policy.companyId);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.skillSourceSync);
    await db
      .update(companies)
      .set({
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
        updatedAt: now,
      })
      .where(and(eq(companies.id, policy.scopeId), eq(companies.status, "active")));
  }

  async function pauseAndCancelScopeForBudget(policy: PolicyRow, requestCancellation = true) {
    await pauseScopeForBudget(policy);
    if (!requestCancellation) return;
    // A pending generation already covers all admitted work in this scope.
    // Rechecks must not invalidate a worker that is delivering that intent.
    await notifyDeliveryWork(db, DELIVERY_QUEUES.budgetEnforcement, policy.companyId);
    await db.update(budgetPolicies).set({
      enforcementVersion: sql`case when ${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}
        then ${budgetPolicies.enforcementVersion} else ${budgetPolicies.enforcementVersion} + 1 end`,
      updatedAt: sql`case when ${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}
        then ${budgetPolicies.updatedAt} else now() end`,
    }).where(eq(budgetPolicies.id, policy.id));
  }

  async function resumeScopeFromBudget(policy: PolicyRow) {
    const policies = await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, policy.companyId), eq(budgetPolicies.scopeType, policy.scopeType),
      eq(budgetPolicies.scopeId, policy.scopeId), eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true),
    ));
    const observations = await computeObservedSpendsWithStalePending(db, policies);
    if (policies.some((candidate, index) => observedBlocks(candidate, observations[index]))) return;
    const now = new Date();
    if (policy.scopeType === "agent") {
      const { applyAgentBudgetHoldInTransaction } = await import("./agent-lifecycle.js");
      await applyAgentBudgetHoldInTransaction(db, policy.companyId, policy.scopeId, false);
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

    await notifyDeliveryWork(db, DELIVERY_QUEUES.skillSourceSync);
    const scope = await resolveScopeRecord(db, "company", policy.scopeId);
    if (scope.pauseReason !== "budget") return;
    await notifyCompanyRetentionWork(db, policy.companyId);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.agentTimers);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.routineSchedules);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.issueMonitors);
    await notifyDeliveryWork(db, DELIVERY_QUEUES.agentLifecycle, policy.companyId);
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
    const observed = await computeObservedSpendWithStalePending(db, policy);
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
    observed: ObservedSpend,
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

    if (thresholdType === "hard") await notifyApprovalWork(db, policy.companyId);
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

  async function reconcileScope(companyId: string, scopeType: BudgetScopeType, scopeId: string,
    prepared?: { scope: ScopeRecord; policies: PolicyRow[]; observations: ObservedSpendWithStalePending[] }) {
    const scope = prepared?.scope ?? await resolveScopeRecord(db, scopeType, scopeId);
    if (scope.companyId !== companyId) throw notFound("Budget scope not found");
    const policies = prepared?.policies ?? await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, scopeType), eq(budgetPolicies.scopeId, scopeId),
    ));
    let recoveringPolicy: PolicyRow | undefined;
    const observations = prepared?.observations ?? await computeObservedSpendsWithStalePending(db, policies);
    for (const [index, policy] of policies.entries()) {
      const observed = observations[index];
      const reasons = observedBlockReasons(policy, observed);
      if (reasons.length) {
        const incident = await createIncidentIfNeeded(policy, "hard", observed);
        await pauseAndCancelScopeForBudget(policy, !scope.budgetHeld);
        const title = scopeType === "company" ? "Company" : scopeType === "agent" ? "Agent" : "Project";
        // A block caused only by stale pending accounting or unpriced usage is
        // real, but `observed.total` can be $0 in that case — never let it read
        // as a spend breach. Name the actual stale runs so the pause is
        // explainable without inspecting the ledger. See JEN-42.
        if (!reasons.includes("spend_exceeded")) {
          if (incident?.created) {
            await recordActivity({
              companyId: policy.companyId,
              actorType: "system",
              actorId: "budget_service",
              action: "budget.accounting_pending_blocked",
              entityType: "budget_incident",
              entityId: incident.incident.id,
              details: {
                scopeType: policy.scopeType,
                scopeId: policy.scopeId,
                reasons,
                stalePendingRunIds: observed.stalePendingRunIds,
                stalePendingRunCount: observed.stalePendingRunCount,
                unpricedEventCount: observed.unpricedEventCount,
              },
            });
          }
          if (reasons.includes("accounting_pending")) {
            const ids = observed.stalePendingRunIds;
            const idList = ids.length < observed.stalePendingRunCount ? `${ids.join(", ")}, +${observed.stalePendingRunCount - ids.length} more` : ids.join(", ");
            return { scopeType, scopeId, scopeName: scope.name,
              reason: `${title} cannot start work: ${observed.stalePendingRunCount} completed run(s) have unsettled cost accounting for over ${Math.round(ACCOUNTING_PENDING_GRACE_MS / 60000)} minutes (${idList}). This is not a spend breach — resolve or retry accounting for those runs.` };
          }
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
    if (scope.budgetHeld && policies[0]) await resumeScopeFromBudget(policies[0]);
    if (recoveringPolicy) return { scopeType, scopeId, scopeName: scope.name,
      reason: "New work must wait while a native run recovers its unfinished accounting." };
    return null;
  }

  async function evaluateAffectedScopes(companyId: string, agentId: string | null, projectId: string | null) {
    const candidatePolicies = await db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.isActive, true),
          budgetPoliciesForRun(companyId, agentId, projectId),
        ),
      );

    const policies = candidatePolicies.filter(policy => policy.metric === "billed_cents" && policy.amount > 0);
    const observations = await computeObservedSpendsWithStalePending(db, policies);
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

      const reasons = observedBlockReasons(policy, observed);
      if (reasons.length) {
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
              // A reason set without "spend_exceeded" means this $0-observed
              // "hard" incident is an accounting/pricing block, not an
              // overspend — named so the audit trail cannot be misread as a
              // false breach claim. See JEN-42.
              reasons,
              stalePendingRunIds: observed.stalePendingRunIds,
              stalePendingRunCount: observed.stalePendingRunCount,
            },
          });
        }
      }
    }
    // A final receipt or price correction can reduce a partial observation.
    // Release only this scope's budget-owned hold after all its policies agree.
    const healthyScopes = new Map<string, PolicyRow>();
    for (const [index, policy] of policies.entries()) {
      if (!observedBlocks(policy, observations[index])) healthyScopes.set(`${policy.scopeType}:${policy.scopeId}`, policy);
    }
    for (const policy of healthyScopes.values()) {
      const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
      if (scope.budgetHeld) await resumeScopeFromBudget(policy);
    }
  }

  async function evaluateAdmissionInTransaction(companyId: string, agentId: string | null,
    context?: { issueId?: string | null; projectId?: string | null }) {
    const scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [
      { scopeType: "company", scopeId: companyId }, ...(agentId ? [{ scopeType: "agent" as const, scopeId: agentId }] : []),
      ...(context?.projectId ? [{ scopeType: "project" as const, scopeId: context.projectId }] : []),
    ];
    const records = await Promise.all(scopes.map(scope => resolveScopeRecord(db, scope.scopeType, scope.scopeId)));
    if (records.some(scope => scope.companyId !== companyId)) throw notFound("Budget scope not found");
    const policies = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, companyId),
      budgetPoliciesForRun(companyId, agentId, context?.projectId ?? null)));
    const observations = await computeObservedSpendsWithStalePending(db, policies);
    const reservationIndexes = policies.map((policy, i) => policy.isActive && policy.hardStopEnabled && policy.metric === "billed_cents" && policy.amount > 0 ? i : -1).filter(i => i >= 0);
    const admission = (block: Awaited<ReturnType<typeof reconcileScope>>) => ({ block,
      policies: reservationIndexes.map(i => policies[i]), observations: reservationIndexes.map(i => observations[i]) });
    for (const [index, { scopeType, scopeId }] of scopes.entries()) {
      const indexes = policies.map((policy, i) => policy.scopeType === scopeType && policy.scopeId === scopeId ? i : -1).filter(i => i >= 0);
      const block = await reconcileScope(companyId, scopeType, scopeId, { scope: records[index],
        policies: indexes.map(i => policies[i]), observations: indexes.map(i => observations[i]) });
      if (block) return admission(block);
    }
    return admission(null);
  }

  const evaluateAdmission = (...args: Parameters<typeof evaluateAdmissionInTransaction>) =>
    withBudgetSpan("budget.admission.evaluate", () => evaluateAdmissionInTransaction(...args));

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
      await notifyDeliveryWork(db, DELIVERY_QUEUES.budgetEnforcement, companyId);
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
            enforcementVersion: sql`${budgetPolicies.enforcementVersion} + 1`,
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
        const observed = await computeObservedSpendWithStalePending(db, row);
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

    evaluateAffectedScopes,
    evaluateCostEvent: (event: typeof costEvents.$inferSelect) => evaluateAffectedScopes(event.companyId, event.agentId, event.projectId),

    evaluateAdmission,
    getInvocationBlock: async (companyId: string, agentId: string | null, context?: { issueId?: string | null; projectId?: string | null }) =>
      (await evaluateAdmission(companyId, agentId, context)).block,

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
        const observed = await computeObservedSpendWithStalePending(db, policy);
        if (unpricedUsageBlocks(policy, observed)) {
          throw unprocessable("Resolve unpriced usage or explicitly allow it in the budget policy before resuming");
        }
        // A recently finished run's accounting may simply not have settled yet
        // (see ACCOUNTING_PENDING_GRACE_MS) — that must not block a manual
        // resume. Only genuinely stale pending accounting still does. See JEN-42.
        if ((observed.stalePendingRunCount - observed.recoveringRunCount) > 0) throw unprocessable("Completed runs must finish accounting before resuming");
        if (compareCents(observed.totalExact, nextAmount) >= 0) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        const now = new Date();
        await notifyDeliveryWork(db, DELIVERY_QUEUES.budgetEnforcement, companyId);
        await db
          .update(budgetPolicies)
          .set({
            amount: nextAmount,
            isActive: true,
            updatedByUserId: actorUserId,
            updatedAt: now,
            enforcementVersion: sql`${budgetPolicies.enforcementVersion} + 1`,
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

async function deliverScopes<T>(items: T[], deliver: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) await deliver(items[next++]);
  }));
}

/** Cancellation is an at-least-once external effect. Only the delivery worker
 * invokes this: request paths commit intent and return without awaiting it. */
export async function deliverBudgetEnforcement(db: Db, hooks: BudgetServiceHooks, companyId?: string, _agentId?: string | null) {
  if (!hooks.cancelWorkForScope) return;
  const attempted = new Set<string>();
  const scopeKey = (scope: BudgetEnforcementScope) => `${scope.companyId}:${scope.scopeType}:${scope.scopeId}`;
  const pending = await db.select().from(budgetPolicies).where(and(
    sql`${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}`,
    companyId ? eq(budgetPolicies.companyId, companyId) : undefined,
  )).orderBy(budgetPolicies.updatedAt, budgetPolicies.id).limit(100);
  await deliverScopes(pending, policy => withBudgetSpan("budget.enforcement.scope", async () => {
      try {
        const cancellation = await withAccountingTransaction(db, policy.companyId, async tx => {
          const [current] = await tx.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
          if (!current || current.enforcementVersion !== policy.enforcementVersion || !(await policyBlocks(tx, current))) return null;
          return { companyId: policy.companyId, scopeType: policy.scopeType as BudgetScopeType, scopeId: policy.scopeId,
            createdBefore: new Date(), enforcement: { policyId: policy.id, version: policy.enforcementVersion } };
        });
        if (cancellation) {
          attempted.add(scopeKey(cancellation));
          await hooks.cancelWorkForScope!(cancellation);
        }
        await db.update(budgetPolicies).set({ enforcementDeliveredVersion: policy.enforcementVersion })
          .where(and(eq(budgetPolicies.id, policy.id), eq(budgetPolicies.enforcementVersion, policy.enforcementVersion)));
      } catch (error) {
        logger.warn({ err: error, policyId: policy.id }, "Budget cancellation delivery pending; accounting is committed");
        // Rotate a failed scope behind other pending work. A poisoned delivery
        // must not monopolize the bounded batch on every retry.
        await db.update(budgetPolicies).set({ updatedAt: new Date() }).where(and(eq(budgetPolicies.id, policy.id),
          eq(budgetPolicies.enforcementVersion, policy.enforcementVersion))).catch(() => undefined);
      }
    }, { "budget.enforcement.queue_delay_ms": Math.max(0, Date.now() - policy.updatedAt.getTime()) }));
  // A committed run Stop outlives a policy edit or deletion. It remains owed
  // even if no policy generation now authorizes a fresh cancellation.
  const committed = (await listPendingBudgetCancellationScopes(db))
    .filter(scope => (!companyId || scope.companyId === companyId) && !attempted.has(scopeKey(scope)));
  await deliverScopes(committed, async scope => {
    try { await hooks.cancelWorkForScope!(scope); }
    catch (error) { logger.warn({ err: error, companyId: scope.companyId, scopeType: scope.scopeType, scopeId: scope.scopeId }, "Committed budget Stop remains pending"); }
  });
}

export async function hasPendingBudgetEnforcement(db: Db): Promise<boolean> {
  const [pending] = await db.select({ id: budgetPolicies.id }).from(budgetPolicies)
    .where(sql`${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}`).limit(1);
  return Boolean(pending) || (await listPendingBudgetCancellationScopes(db, 1)).length > 0;
}

const budgetOwnedScope = or(
  and(eq(budgetPolicies.scopeType, "company"), sql`exists (select 1 from ${companies} where ${companies.id} = ${budgetPolicies.scopeId} and ${companies.pauseReason} = 'budget')`),
  and(eq(budgetPolicies.scopeType, "agent"), sql`exists (select 1 from ${agents} where ${agents.id} = ${budgetPolicies.scopeId} and ${agents.lifecycleHolds} @> '["budget"]'::jsonb)`),
  and(eq(budgetPolicies.scopeType, "project"), sql`exists (select 1 from ${projects} where ${projects.id} = ${budgetPolicies.scopeId} and ${projects.pauseReason} = 'budget')`),
)!;

const openIncidentScope = sql`exists (select 1 from ${budgetIncidents}
  where ${budgetIncidents.policyId} = ${budgetPolicies.id} and ${budgetIncidents.status} = 'open')`;
const unfinishedRunScope = sql`exists (select 1 from ${heartbeatRuns}
  where ${heartbeatRuns.companyId} = ${budgetPolicies.companyId} and ${heartbeatRuns.costAccountingPending} = true
    and ${heartbeatRuns.costAccountedAt} is null and (${budgetPolicies.scopeType} = 'company'
      or (${budgetPolicies.scopeType} = 'agent' and ${heartbeatRuns.agentId} = ${budgetPolicies.scopeId})
      or (${budgetPolicies.scopeType} = 'project' and ${heartbeatRuns.usageJson}->'ledgerScope'->>'projectId' = ${budgetPolicies.scopeId}::text)))`;

export async function nextBudgetReconciliationAt(db: Db): Promise<Date | null> {
  const [held] = await db.select({ id: budgetPolicies.id }).from(budgetPolicies)
    .where(and(eq(budgetPolicies.windowKind, "calendar_month_utc"), or(budgetOwnedScope, openIncidentScope))).limit(1);
  return held ? currentUtcMonthWindow().end : null;
}

/** Startup repairs configured policy scopes, not every agent. Afterwards only
 * held monthly scopes owe a timed reevaluation; writes reconcile their own scopes. */
export async function reconcileDueBudgetPolicies(db: Db, options: { startup?: boolean; cursor?: string | null } = {}): Promise<{ nextCursor: string | null }> {
  const actionable = options.startup ? or(budgetOwnedScope, openIncidentScope,
    sql`${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}`,
    and(eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true), sql`${budgetPolicies.amount} > 0`, unfinishedRunScope))
    : and(eq(budgetPolicies.windowKind, "calendar_month_utc"), or(budgetOwnedScope, openIncidentScope));
  const rows = await db.select({ id: budgetPolicies.id, companyId: budgetPolicies.companyId, scopeType: budgetPolicies.scopeType, scopeId: budgetPolicies.scopeId })
    .from(budgetPolicies).where(and(actionable, options.cursor ? sql`${budgetPolicies.id} > ${options.cursor}::uuid` : undefined))
    .orderBy(budgetPolicies.id).limit(100);
  const scopes = new Map(rows.map(scope => [`${scope.companyId}:${scope.scopeType}:${scope.scopeId}`, scope]));
  for (const scope of scopes.values()) {
    try {
      await withAccountingTransaction(db, scope.companyId, (tx, publications) => budgetServiceInTransaction(tx, publications)
        .reconcileScope(scope.companyId, scope.scopeType as BudgetScopeType, scope.scopeId));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      throw error;
    }
  }
  return { nextCursor: rows.length === 100 ? rows[rows.length - 1].id : null };
}

export function budgetService(db: Db, _hooks: BudgetServiceHooks = {}) {
  const reads = budgetServiceInTransaction(db);
  const mutate = <T>(companyId: string, work: (service: ReturnType<typeof budgetServiceInTransaction>) => Promise<T>) =>
    withAccountingTransaction(db, companyId, (tx, publications) => work(budgetServiceInTransaction(tx, publications)));
  return {
    ...reads,
    evaluateAdmission: (companyId: string, agentId: string | null, context?: { issueId?: string | null; projectId?: string | null }) =>
      mutate(companyId, service => service.evaluateAdmission(companyId, agentId, context)),
    evaluateAffectedScopes: (companyId: string, agentId: string | null, projectId: string | null) =>
      mutate(companyId, service => service.evaluateAffectedScopes(companyId, agentId, projectId)),
    reconcileScope: (companyId: string, scopeType: BudgetScopeType, scopeId: string) =>
      mutate(companyId, service => service.reconcileScope(companyId, scopeType, scopeId)),
    reconcilePolicies: () => reconcileDueBudgetPolicies(db, { startup: true }),
    upsertPolicy: (companyId: string, input: BudgetPolicyUpsertInput, actorUserId: string | null) =>
      mutate(companyId, service => service.upsertPolicy(companyId, input, actorUserId)),
    evaluateCostEvent: (event: typeof costEvents.$inferSelect) => mutate(event.companyId, service => service.evaluateCostEvent(event)),
    getInvocationBlock: (companyId: string, agentId: string | null, context?: { issueId?: string | null; projectId?: string | null }) =>
      mutate(companyId, service => service.getInvocationBlock(companyId, agentId, context)),
    resolveIncident: (companyId: string, incidentId: string, input: BudgetIncidentResolutionInput, actorUserId: string) =>
      mutate(companyId, service => service.resolveIncident(companyId, incidentId, input, actorUserId)),
  };
}
