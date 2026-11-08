import { notifyMuseContactVerification } from "../modules/external-agents/index.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyExternalObjectRefresh } from "./external-object-refresh-notifications.js";
import { notifyApprovalWork } from "./approval-work-notifications.js";
import { notifyAttentionRetentionWork, notifyCompanyRetentionWork } from "./retention-work-notifications.js";
import { addCents, compareCents, normalizeCents } from "@paperclipai/shared";
import { and, desc, eq, inArray, sql, or, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import {
  agents,
  approvals,
  budgetEvaluationWork,
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
import { withAccountingReadSnapshot, withAccountingTransaction, withOperationAccountingTransaction } from "./accounting-transaction.js";
import { logActivity, type LogActivityInput, type ActivityPublication } from "./activity-log.js";
import { computeObservedSpend, computeObservedSpends, type ObservedSpend } from "./budget-exposure.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { listPendingBudgetCancellationScopes } from "./heartbeat/budget-cancellation.js";
import { withBudgetSpan } from "./budget-tracing.js";
import { queueBudgetEvaluation, oldestBudgetInputAt } from "./budget-evaluation-work.js";
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

async function resolveSummaryScopeRecord(db: Db, companyId: string, scopeType: BudgetScopeType, scopeId: string): Promise<ScopeRecord> {
  let scope: ScopeRecord;
  try {
    scope = await resolveScopeRecord(db, scopeType, scopeId);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404 || (scopeType !== "agent" && scopeType !== "project")) throw error;
    return { companyId, name: scopeType === "agent" ? "Deleted agent" : "Deleted project",
      paused: false, pauseReason: null, budgetHeld: false };
  }
  if (scope.companyId !== companyId) throw notFound("Budget scope not found");
  return scope;
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

/** `runId` names the run being admitted, so its own pending accounting never holds it. */
type AdmissionContext = { issueId?: string | null; projectId?: string | null; runId?: string | null;
  /** The caller continues work that was already admitted: a validated
   * recovery owner, or a running run's own tool mutations. Temporary holds
   * (accounting that awaits settlement, recovering runs, budget inputs that
   * await evaluation) gate new work only; admitted work must be able to
   * finish, or concurrent recoveries after a restart storm wait on each other.
   * Hard stops and pauses still apply. */
  admittedRecovery?: boolean };

async function readAdmissionScopes(db: Db, companyId: string, agentId: string | null, context?: AdmissionContext) {
  const scopes: Array<{ scopeType: BudgetScopeType; scopeId: string }> = [
    { scopeType: "company", scopeId: companyId }, ...(agentId ? [{ scopeType: "agent" as const, scopeId: agentId }] : []),
    ...(context?.projectId ? [{ scopeType: "project" as const, scopeId: context.projectId }] : []),
  ];
  const records = await Promise.all(scopes.map(scope => resolveScopeRecord(db, scope.scopeType, scope.scopeId)));
  if (records.some(scope => scope.companyId !== companyId)) throw notFound("Budget scope not found");
  const policies = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.companyId, companyId),
    budgetPoliciesForRun(companyId, agentId, context?.projectId ?? null)));
  return { scopes, records, policies };
}

function scopePauseBlock(scopeType: BudgetScopeType, scopeId: string, scope: ScopeRecord, hasPolicies: boolean) {
  if (scopeType !== "agent" && scope.paused && scope.pauseReason !== "budget") {
    return { scopeType, scopeId, scopeName: scope.name, reason: `${scopeType === "company" ? "Company" : "Project"} is paused and cannot start new work.` };
  }
  if (scope.paused && scope.pauseReason === "budget" && !hasPolicies) {
    return { scopeType, scopeId, scopeName: scope.name, reason: "Budget pause requires a policy or an explicit operator resume." };
  }
  return null;
}

async function inspectInvocationEligibility(db: Db, companyId: string, agentId: string | null, context?: AdmissionContext) {
  const { scopes, records, policies } = await readAdmissionScopes(db, companyId, agentId, context);
  if (policies.length > 0) {
    if (records.some(scope => scope.budgetHeld)) return { needsReconciliation: true } as const;
    const observations = await computeObservedSpends(db, policies, undefined, context?.runId);
    if (policies.some((policy, index) => observedBlocks(policy, observations[index])
      || (policy.isActive && policy.hardStopEnabled && policy.amount > 0 && observations[index].recoveringRunCount > 0))) {
      return { needsReconciliation: true } as const;
    }
    const incidents = await db.select({ policyId: budgetIncidents.policyId, thresholdType: budgetIncidents.thresholdType })
      .from(budgetIncidents).where(and(eq(budgetIncidents.companyId, companyId),
        inArray(budgetIncidents.policyId, policies.map(policy => policy.id)), eq(budgetIncidents.status, "open")));
    const byId = new Map(policies.map((policy, index) => [policy.id, { policy, observed: observations[index] }]));
    if (incidents.some(incident => {
      const { policy, observed } = byId.get(incident.policyId)!;
      return incident.thresholdType === "hard" || shouldResolveSoftIncident(policy, observed);
    })) return { needsReconciliation: true } as const;
  }
  for (const [index, { scopeType, scopeId }] of scopes.entries()) {
    const block = scopePauseBlock(scopeType, scopeId, records[index],
      policies.some(policy => policy.scopeType === scopeType && policy.scopeId === scopeId));
    if (block) return { needsReconciliation: false, block } as const;
  }
  return { needsReconciliation: false, block: null } as const;
}

function unpricedUsageBlocks(policy: PolicyRow, observed: ObservedSpend) {
  return policy.unpricedUsagePolicy !== "allow"
    && (observed.unpricedEventCount > 0 || observed.unknownBrowserRunCount > 0);
}

function shouldResolveSoftIncident(policy: PolicyRow, observed: ObservedSpend) {
  return !policy.isActive || !policy.notifyEnabled
    || compareCents(observed.totalExact, Math.ceil(policy.amount * policy.warnPercent / 100)) < 0;
}

/** Spend reached the limit, or the operator blocks unpriced usage. Only this
 * opens a hard-stop incident, pauses a scope, or stops running work. */
function hardStopReached(policy: PolicyRow, observed: Awaited<ReturnType<typeof computeObservedSpend>>) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return compareCents(observed.totalExact, policy.amount) >= 0 || unpricedUsageBlocks(policy, observed);
}

/** Admission also waits while runs that ended without succeeding await
 * accounting. That unknown is a separate conservative restriction: it holds
 * new work only. A run that finishes moments before its charge commits must
 * not pause the company or cancel unrelated running work. A succeeded run with
 * only usage outstanding is bounded like a running run and does not wait. */
function observedBlocks(policy: PolicyRow, observed: Awaited<ReturnType<typeof computeObservedSpend>>) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return hardStopReached(policy, observed) || observed.waitingRunCount > 0;
}
export async function policyBlocks(db: Db, policy: PolicyRow) {
  if (!policy.isActive || !policy.hardStopEnabled || policy.amount <= 0) return false;
  return hardStopReached(policy, await computeObservedSpend(db, policy));
}

/** Supplemental handoff check after authoritative accounting admission commits.
 * Read only: the caller can hold issue/run ownership, so this must never take
 * the company lock, reconcile holds, or deliver effects. A later concurrent
 * charge targets already-admitted work through the normal durable Stop path. */
export async function recheckAdmittedRunBudgetReadOnly(db: Db, input: {
  companyId: string; agentId: string; runId: string; projectId: string | null; reservationId: string;
  /** See AdmissionContext.admittedRecovery. */
  admittedRecovery?: boolean;
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
    const observations = await computeObservedSpends(db, policies, undefined, input.runId);
    for (const [index, policy] of policies.entries()) {
      const observed = observations[index];
      if (input.admittedRecovery ? hardStopReached(policy, observed) : observedBlocks(policy, observed))
        return "Applicable budget no longer permits provider work";
      // An owned recovery reuses the hold reserveRunBudget already admitted;
      // other runs' holds filling the budget must not refuse it.
      if (input.admittedRecovery) continue;
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

/** Owner transactions read eligibility or append work. Only the fenced worker
 * and explicit policy edits evaluate and publish aggregate transitions. */
export function budgetServiceInTransaction(db: Db, publications: ActivityPublication[] = [],
  options: { evaluate?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const recordActivity = (input: LogActivityInput) => logActivity(db, input, publications);
  async function pauseScopeForBudget(policy: PolicyRow) {
    const now = new Date();
    if (policy.scopeType === "agent") {
      const { applyAgentBudgetHoldInTransaction } = await import("./agent-lifecycle.js");
      await applyAgentBudgetHoldInTransaction(db, policy.companyId, policy.scopeId, true);
      return;
    }

    if (policy.scopeType === "project") {
      // Admission rechecks the same hard stop. Lock current eligibility before
      // publishing intent so a no-op pause cannot reactivate its own receipts.
      const [project] = await db.select({ pausedAt: projects.pausedAt }).from(projects)
        .where(and(eq(projects.id, policy.scopeId), eq(projects.companyId, policy.companyId))).for("update");
      if (!project || project.pausedAt !== null) return;
      await notifyRunDispatch(db, { companyId: policy.companyId });
      await notifyDeferredExecutionEligibility(db, { companyId: policy.companyId });
      await db
        .update(projects)
        .set({
          pauseReason: "budget",
          pausedAt: now,
          updatedAt: now,
        })
        .where(and(eq(projects.id, policy.scopeId), eq(projects.companyId, policy.companyId), isNull(projects.pausedAt)));
      return;
    }

    const scope = await resolveScopeRecord(db, "company", policy.scopeId);
    if (scope.paused) return;
    await notifyRunDispatch(db, { companyId: policy.companyId });
    await notifyDeferredExecutionEligibility(db, { companyId: policy.companyId });
    await notifyCompanyRetentionWork(db, policy.companyId);
    await notifyStatusCardIssueChange(db, policy.companyId);
    await notifyExternalObjectRefresh(db, policy.companyId);
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
    const observations = await computeObservedSpends(db, policies, now);
    if (policies.some((candidate, index) => hardStopReached(candidate, observations[index]))) return;
    if (policy.scopeType === "agent") {
      const { applyAgentBudgetHoldInTransaction } = await import("./agent-lifecycle.js");
      await applyAgentBudgetHoldInTransaction(db, policy.companyId, policy.scopeId, false);
      return;
    }

    if (policy.scopeType === "project") {
      await notifyRunDispatch(db, { companyId: policy.companyId });
      await notifyDeferredExecutionEligibility(db, { companyId: policy.companyId });
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
    await notifyMuseContactVerification(db,{companyId:policy.companyId});
    await notifyRunDispatch(db, { companyId: policy.companyId });
    await notifyDeferredExecutionEligibility(db, { companyId: policy.companyId });
    await notifyCompanyRetentionWork(db, policy.companyId);
    await notifyStatusCardIssueChange(db, policy.companyId);
    await notifyExternalObjectRefresh(db, policy.companyId);
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
    const scope = await resolveSummaryScopeRecord(db, policy.companyId, policy.scopeType as BudgetScopeType, policy.scopeId);
    const observed = await computeObservedSpend(db, policy, now);
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
      status: hardStopReached(policy, observed) ? "hard_stop" : policy.isActive
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

    await notifyAttentionRetentionWork(db, { companyId: policy.companyId, sourceKind: "budget_alert" });
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

  async function resolveOpenSoftIncidents(policyId: string, companyId: string) {
    await notifyAttentionRetentionWork(db, { companyId, sourceKind: "budget_alert" });
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
    companyId: string,
    approvalStatus: "approved" | "rejected" | null,
    decidedByUserId: string | null,
    thresholdType?: BudgetThresholdType,
  ) {
    await notifyAttentionRetentionWork(db, { companyId, sourceKind: "budget_alert" });
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
      const scope = await resolveSummaryScopeRecord(db, row.companyId, row.scopeType as BudgetScopeType, row.scopeId);
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
    prepared?: { scope: ScopeRecord; policies: PolicyRow[]; observations: ObservedSpend[] }) {
    const scope = prepared?.scope ?? await resolveScopeRecord(db, scopeType, scopeId);
    if (scope.companyId !== companyId) throw notFound("Budget scope not found");
    const policies = prepared?.policies ?? await db.select().from(budgetPolicies).where(and(
      eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, scopeType), eq(budgetPolicies.scopeId, scopeId),
    ));
    let recoveringPolicy: PolicyRow | undefined;
    let accountingHold = false;
    const observations = prepared?.observations ?? await computeObservedSpends(db, policies, now);
    const title = scopeType === "company" ? "Company" : scopeType === "agent" ? "Agent" : "Project";
    for (const [index, policy] of policies.entries()) {
      const observed = observations[index];
      if (hardStopReached(policy, observed)) {
        await createIncidentIfNeeded(policy, "hard", observed);
        await pauseAndCancelScopeForBudget(policy, !scope.budgetHeld);
        if (observed.pendingRunCount > 0) {
          return { scopeType, scopeId, scopeName: scope.name, reason: `${title} cannot start work while completed runs await accounting.` };
        }
        if (unpricedUsageBlocks(policy, observed)) {
          return { scopeType, scopeId, scopeName: scope.name, reason: `${title} cannot start work because recorded usage has no reliable price.` };
        }
        return { scopeType, scopeId, scopeName: scope.name, reason: scopeType === "project"
          ? "Project cannot start work because its budget hard-stop is still exceeded."
          : `${title} is paused because its budget hard-stop was reached.` };
      }
      // Pending accounting holds new work only. It never keeps a budget-owned
      // pause or a hard incident, including one opened by older releases.
      if (observedBlocks(policy, observed)) accountingHold = true;
      // An open native coordinator must finish the original run's accounting.
      // Deny fresh work without pausing/cancelling that recovery or its hold.
      if (policy.isActive && policy.hardStopEnabled && policy.amount > 0 && observed.recoveringRunCount > 0) recoveringPolicy ??= policy;
      // A closed UTC window, inactive policy, or budget raise releases only
      // budget-owned pauses. Manual pauses remain operator decisions.
      await resolveOpenIncidentsForPolicy(policy.id, policy.companyId, "approved", "budget_service", "hard");
      if (shouldResolveSoftIncident(policy, observed)) {
        await resolveOpenIncidentsForPolicy(policy.id, policy.companyId, "approved", "budget_service", "soft");
      }
    }
    const pauseBlock = scopePauseBlock(scopeType, scopeId, scope, policies.length > 0);
    if (pauseBlock) return pauseBlock;
    if (scope.budgetHeld && policies[0]) await resumeScopeFromBudget(policies[0]);
    if (accountingHold) return { scopeType, scopeId, scopeName: scope.name,
      reason: `${title} cannot start work while completed runs await accounting.` };
    if (recoveringPolicy) return { scopeType, scopeId, scopeName: scope.name,
      reason: "New work must wait while a native run recovers its unfinished accounting." };
    return null;
  }

  async function evaluateAffectedScopes(companyId: string, agentId: string | null, projectId: string | null,
    prepared?: { policies: PolicyRow[]; observations: ObservedSpend[] }) {
    const candidatePolicies = prepared?.policies ?? await db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.isActive, true),
          budgetPoliciesForRun(companyId, agentId, projectId),
        ),
      );

    const policies = candidatePolicies.filter(policy => policy.isActive && policy.metric === "billed_cents" && policy.amount > 0);
    const observations = prepared ? policies.map(policy => prepared.observations[prepared.policies.findIndex(row => row.id === policy.id)])
      : await computeObservedSpends(db, policies, now);
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

      if (hardStopReached(policy, observed)) {
        await resolveOpenSoftIncidents(policy.id, policy.companyId);
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
    // A final receipt or price correction can reduce a partial observation.
    // Release only this scope's budget-owned hold after all its policies agree.
    const healthyScopes = new Map<string, PolicyRow>();
    for (const [index, policy] of policies.entries()) {
      if (!hardStopReached(policy, observations[index])) healthyScopes.set(`${policy.scopeType}:${policy.scopeId}`, policy);
    }
    for (const policy of healthyScopes.values()) {
      const scope = await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
      if (scope.budgetHeld) await resumeScopeFromBudget(policy);
    }
  }

  async function evaluateAdmissionInTransaction(companyId: string, agentId: string | null,
    context?: AdmissionContext) {
    const { scopes, records, policies } = await readAdmissionScopes(db, companyId, agentId, context);
    const observations = await computeObservedSpends(db, policies, now, context?.runId);
    const reservationIndexes = policies.map((policy, i) => policy.isActive && policy.hardStopEnabled && policy.metric === "billed_cents" && policy.amount > 0 ? i : -1).filter(i => i >= 0);
    const admission = (block: Awaited<ReturnType<typeof reconcileScope>>) => ({ block,
      policies: reservationIndexes.map(i => policies[i]), observations: reservationIndexes.map(i => observations[i]) });
    for (const [index, { scopeType, scopeId }] of scopes.entries()) {
      const scope = records[index];
      const scoped = policies.map((policy, i) => ({ policy, observed: observations[i] }))
        .filter(({ policy }) => policy.scopeType === scopeType && policy.scopeId === scopeId);
      const pause = scopePauseBlock(scopeType, scopeId, scope, scoped.length > 0);
      if (pause) return admission(pause);
      for (const { policy, observed } of scoped) {
        const title = scopeType === "company" ? "Company" : scopeType === "agent" ? "Agent" : "Project";
        if (context?.admittedRecovery ? hardStopReached(policy, observed) : observedBlocks(policy, observed)) return admission({ scopeType, scopeId, scopeName: scope.name,
          reason: observed.waitingRunCount > 0 ? `${title} cannot start work while completed runs await accounting.`
            : unpricedUsageBlocks(policy, observed) ? `${title} cannot start work because recorded usage has no reliable price.`
            : scopeType === "project" ? "Project cannot start work because its budget hard-stop is still exceeded."
              : `${title} is paused because its budget hard-stop was reached.` });
        if (!context?.admittedRecovery && policy.isActive && policy.hardStopEnabled && policy.amount > 0 && observed.recoveringRunCount > 0)
          return admission({ scopeType, scopeId, scopeName: scope.name,
            reason: "New work must wait while a native run recovers its unfinished accounting." });
      }
      if (scope.budgetHeld) return admission({ scopeType, scopeId, scopeName: scope.name,
        reason: "Budget hold is awaiting reconciliation." });
    }
    if (reservationIndexes.length > 0 && !context?.admittedRecovery) {
      for (const index of reservationIndexes) {
        const policy = policies[index];
        const oldest = await oldestBudgetInputAt(db, { companyId,
          agentId: policy.scopeType === "agent" ? policy.scopeId : null,
          projectId: policy.scopeType === "project" ? policy.scopeId : null });
        if (oldest && now.getTime() - oldest.getTime() > 15_000) return admission({ scopeType: policy.scopeType as BudgetScopeType,
          scopeId: policy.scopeId, scopeName: records.find((_, i) => scopes[i].scopeType === policy.scopeType)?.name ?? "Budget scope",
          reason: "Budget accounting changes are awaiting reconciliation." });
      }
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

      // A newly created policy can race a no-policy batch that already consumed
      // its charge. Its own committed input must trigger a fresh evaluation.
      await queueBudgetEvaluation(db, { companyId,
        agentId: input.scopeType === "agent" ? input.scopeId : null,
        projectId: input.scopeType === "project" ? input.scopeId : null });

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
        if (!hardStopReached(row, observed)) {
          await resumeScopeFromBudget(row);
          await resolveOpenIncidentsForPolicy(row.id, row.companyId, "approved", actorUserId ?? "budget_service", "hard");
          if (row.notifyEnabled && compareCents(observed.totalExact, Math.ceil(row.amount * row.warnPercent / 100)) >= 0) {
            await createIncidentIfNeeded(row, "soft", observed);
          } else {
            await resolveOpenIncidentsForPolicy(row.id, row.companyId, null, null, "soft");
          }
        } else {
          const softThreshold = Math.ceil((row.amount * row.warnPercent) / 100);
          if (row.notifyEnabled && compareCents(observed.totalExact, softThreshold) >= 0 && (!row.hardStopEnabled || compareCents(observed.totalExact, row.amount) < 0)) {
            await createIncidentIfNeeded(row, "soft", observed);
          }
          if (hardStopReached(row, observed)) {
            await resolveOpenSoftIncidents(row.id, row.companyId);
            await createIncidentIfNeeded(row, "hard", observed);
            await pauseAndCancelScopeForBudget(row);
          }
        }
      } else {
        await resumeScopeFromBudget(row);
        await resolveOpenIncidentsForPolicy(row.id, row.companyId, "approved", actorUserId ?? "budget_service");
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

    evaluateAffectedScopes: options.evaluate ? evaluateAffectedScopes
      : (companyId: string, agentId: string | null, projectId: string | null) => queueBudgetEvaluation(db, { companyId, agentId, projectId }),
    evaluateCostEvent: (event: typeof costEvents.$inferSelect) => options.evaluate
      ? evaluateAffectedScopes(event.companyId, event.agentId, event.projectId)
      : queueBudgetEvaluation(db, { companyId: event.companyId, agentId: event.agentId, projectId: event.projectId }),

    evaluateAdmission,
    getInvocationBlock: async (companyId: string, agentId: string | null, context?: AdmissionContext) =>
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
      if (policy.companyId !== companyId || policy.scopeType !== incident.scopeType || policy.scopeId !== incident.scopeId) {
        throw notFound("Budget scope not found");
      }
      const scope = input.action === "keep_paused"
        ? await resolveSummaryScopeRecord(db, companyId, policy.scopeType as BudgetScopeType, policy.scopeId)
        : await resolveScopeRecord(db, policy.scopeType as BudgetScopeType, policy.scopeId);
      if (scope.companyId !== companyId) throw notFound("Budget scope not found");
      if (input.action === "raise_budget_and_resume") {
        const now = new Date();
        await queueBudgetEvaluation(db, { companyId,
          agentId: policy.scopeType === "agent" ? policy.scopeId : null,
          projectId: policy.scopeType === "project" ? policy.scopeId : null });
        const nextAmount = Math.max(0, Math.floor(input.amount ?? 0));
        const observed = await computeObservedSpend(db, policy, now);
        if (unpricedUsageBlocks(policy, observed)) {
          throw unprocessable("Resolve unpriced usage or explicitly allow it in the budget policy before resuming");
        }
        if (compareCents(observed.totalExact, nextAmount) >= 0) {
          throw unprocessable("New budget must exceed current observed spend");
        }

        await notifyAttentionRetentionWork(db, { companyId, sourceKind: "budget_alert" });
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
  return withOperationAccountingTransaction(db, scope.companyId, async (tx) => {
    if (scope.enforcement) {
      const [policy] = await tx.select().from(budgetPolicies).where(and(
        eq(budgetPolicies.id, scope.enforcement.policyId), eq(budgetPolicies.companyId, scope.companyId),
      )).for("update");
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
        const cancellation = await withOperationAccountingTransaction(db, policy.companyId, async tx => {
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

/** Policy-only coordination, off the financial path. RR detects a policy edit
 * or newer evaluator after this snapshot; every pass advances its publication
 * fence even when no threshold transition is needed. */
async function fenceBudgetPolicies(tx: Db, companyId: string, extra?: { scopeType: string; scopeId: string }) {
  const policies = await tx.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId))
    .orderBy(budgetPolicies.id).for("update");
  // Existing control/configuration writers own their resource before changing
  // policies. Never wait for those resources while holding the policy fence:
  // relinquish this transaction so the control writer can finish. These locks
  // are only for aggregate publication, never receipt or settlement commits.
  const scopes = [...policies, ...(extra ? [extra] : [])];
  try {
    for (const [table, scopeType] of [[companies, "company"], [agents, "agent"], [projects, "project"]] as const) {
      const ids = [...new Set(scopes.filter(scope => scope.scopeType === scopeType).map(scope => scope.scopeId))].sort();
      if (ids.length) await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids))
        .orderBy(table.id).for("no key update", { noWait: true });
    }
  } catch (error) {
    const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (code === "55P03") throw Object.assign(new Error("Budget control changed during evaluation", { cause: error }), { code: "40001" });
    throw error;
  }
  if (policies.length) await tx.update(budgetPolicies).set({ evaluationVersion: sql`${budgetPolicies.evaluationVersion} + 1` })
    .where(inArray(budgetPolicies.id, policies.map(row => row.id)));
  return policies;
}

/** Consume selected committed IDs only. Earlier allocated IDs that commit
 * later remain discoverable; no company high-water mark is written. */
export async function flushBudgetEvaluationWork(db: Db, options: { companyId?: string } = {}): Promise<number> {
  return (await flushBudgetEvaluationWorkPage(db, options)).consumed;
}

/** The cursor rotates bounded company pages; it is a scheduling hint only.
 * Pending inputs remain durable across retries, lower-ID arrivals and restart. */
export async function flushBudgetEvaluationWorkPage(db: Db, options: { companyId?: string; cursor?: string | null } = {}): Promise<{ consumed: number; nextCursor: string | null }> {
  const pending = await db.selectDistinct({ companyId: budgetEvaluationWork.companyId }).from(budgetEvaluationWork)
    .where(and(options.companyId ? eq(budgetEvaluationWork.companyId, options.companyId) : undefined,
      options.cursor ? sql`${budgetEvaluationWork.companyId} > ${options.cursor}::uuid` : undefined))
    .orderBy(budgetEvaluationWork.companyId).limit(100);
  let consumed = 0;
  for (const { companyId } of pending) {
    try {
      consumed += await withOperationAccountingTransaction(db, companyId, async (tx, publications) => {
        const now = new Date();
        const inputs = await tx.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, companyId))
          .orderBy(budgetEvaluationWork.createdAt, budgetEvaluationWork.id).limit(500);
        if (!inputs.length) return 0;
        const agents = new Set(inputs.map(input => input.agentId));
        const projects = new Set(inputs.map(input => input.projectId));
        const policies = (await fenceBudgetPolicies(tx, companyId)).filter(policy => policy.scopeType === "company"
          || (policy.scopeType === "agent" ? agents : projects).has(policy.scopeId));
        const existing: PolicyRow[] = [];
        const scopes = new Map<string, ScopeRecord>();
        for (const policy of policies) {
          const key = `${policy.scopeType}:${policy.scopeId}`;
          try {
            if (!scopes.has(key)) scopes.set(key, await resolveScopeRecord(tx, policy.scopeType as BudgetScopeType, policy.scopeId));
            existing.push(policy);
          } catch (error) {
            if (!(error instanceof HttpError) || error.status !== 404) throw error;
            // Archived charges outlive deleted scope resources; they still affect
            // the company policy, without resurrecting the deleted scope.
          }
        }
        const observations = await computeObservedSpends(tx, existing, now);
        const service = budgetServiceInTransaction(tx, publications, { evaluate: true, now });
        await service.evaluateAffectedScopes(companyId, null, null, { policies: existing, observations });
        for (const [key, scope] of scopes) {
          const scoped = existing.map((policy, index) => ({ policy, observed: observations[index] }))
            .filter(({ policy }) => `${policy.scopeType}:${policy.scopeId}` === key);
          if (!scoped.length) continue;
          await service.reconcileScope(companyId, scoped[0].policy.scopeType as BudgetScopeType, scoped[0].policy.scopeId,
            { scope, policies: scoped.map(row => row.policy), observations: scoped.map(row => row.observed) });
        }
        if (existing.some(policy => policy.windowKind === "calendar_month_utc") && Date.now() >= currentUtcMonthWindow(now).end.getTime())
          throw Object.assign(new Error("Budget window changed during evaluation"), { code: "40001" });
        await tx.delete(budgetEvaluationWork).where(inArray(budgetEvaluationWork.id, inputs.map(input => input.id)));
        return inputs.length;
      });
    } catch (error) {
      // One company's control contention or malformed retained input must not
      // suppress another company's evaluations or already-committed Stops.
      // The rolled-back input IDs stay pending for the coordinator's retry.
      logger.warn({ err: error, companyId }, "Budget evaluation remains pending");
    }
  }
  return { consumed, nextCursor: pending.length === 100 ? pending[pending.length - 1].companyId : null };
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
export async function reconcileDueBudgetPolicies(db: Db, options: { startup?: boolean; cursor?: string | null } = {}): Promise<{ nextCursor: string | null; hadFailures?: boolean }> {
  const actionable = options.startup ? or(budgetOwnedScope, openIncidentScope,
    sql`${budgetPolicies.enforcementVersion} > ${budgetPolicies.enforcementDeliveredVersion}`,
    and(eq(budgetPolicies.isActive, true), eq(budgetPolicies.hardStopEnabled, true), sql`${budgetPolicies.amount} > 0`, unfinishedRunScope))
    : and(eq(budgetPolicies.windowKind, "calendar_month_utc"), or(budgetOwnedScope, openIncidentScope));
  const rows = await db.select({ id: budgetPolicies.id, companyId: budgetPolicies.companyId, scopeType: budgetPolicies.scopeType, scopeId: budgetPolicies.scopeId })
    .from(budgetPolicies).where(and(actionable, options.cursor ? sql`${budgetPolicies.id} > ${options.cursor}::uuid` : undefined))
    .orderBy(budgetPolicies.id).limit(100);
  const scopes = new Map(rows.map(scope => [`${scope.companyId}:${scope.scopeType}:${scope.scopeId}`, scope]));
  let hadFailures = false;
  for (const scope of scopes.values()) {
    try {
      await withOperationAccountingTransaction(db, scope.companyId, async (tx, publications) => {
        const now = new Date();
        await fenceBudgetPolicies(tx, scope.companyId, scope);
        const result = await budgetServiceInTransaction(tx, publications, { evaluate: true, now })
          .reconcileScope(scope.companyId, scope.scopeType as BudgetScopeType, scope.scopeId);
        if (Date.now() >= currentUtcMonthWindow(now).end.getTime())
          throw Object.assign(new Error("Budget window changed during reconciliation"), { code: "40001" });
        return result;
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) continue;
      hadFailures = true;
      logger.warn({ err: error, companyId: scope.companyId, policyId: scope.id }, "Budget scope reconciliation remains pending");
    }
  }
  return { nextCursor: rows.length === 100 ? rows[rows.length - 1].id : null, ...(hadFailures ? { hadFailures: true } : {}) };
}

export function budgetService(db: Db, _hooks: BudgetServiceHooks = {}) {
  const mutate = <T>(companyId: string, work: (service: ReturnType<typeof budgetServiceInTransaction>) => Promise<T>,
    scope?: { scopeType: string; scopeId: string }) => withOperationAccountingTransaction(db, companyId, async (tx, publications) => {
      const now = new Date();
      const policies = await fenceBudgetPolicies(tx, companyId, scope);
      const result = await work(budgetServiceInTransaction(tx, publications, { evaluate: true, now }));
      if ((policies.some(policy => policy.windowKind === "calendar_month_utc") || scope) && Date.now() >= currentUtcMonthWindow(now).end.getTime())
        throw Object.assign(new Error("Budget window changed during publication"), { code: "40001" });
      return result;
    });
  return {
    listPolicies: (companyId: string) => withAccountingReadSnapshot(db, companyId,
      tx => budgetServiceInTransaction(tx).listPolicies(companyId)),
    overview: (companyId: string) => withAccountingReadSnapshot(db, companyId,
      tx => budgetServiceInTransaction(tx).overview(companyId)),
    evaluateAdmission: (companyId: string, agentId: string | null, context?: AdmissionContext) =>
      withAccountingReadSnapshot(db, companyId, tx => budgetServiceInTransaction(tx).evaluateAdmission(companyId, agentId, context)),
    evaluateAffectedScopes: (companyId: string, agentId: string | null, projectId: string | null) =>
      withOperationAccountingTransaction(db, companyId, tx => queueBudgetEvaluation(tx, { companyId, agentId, projectId })),
    reconcileScope: (companyId: string, scopeType: BudgetScopeType, scopeId: string) =>
      mutate(companyId, service => service.reconcileScope(companyId, scopeType, scopeId), { scopeType, scopeId }),
    reconcilePolicies: () => reconcileDueBudgetPolicies(db, { startup: true }),
    upsertPolicy: (companyId: string, input: BudgetPolicyUpsertInput, actorUserId: string | null) =>
      mutate(companyId, service => service.upsertPolicy(companyId, input, actorUserId), input),
    evaluateCostEvent: (event: typeof costEvents.$inferSelect) => withOperationAccountingTransaction(db, event.companyId, tx => queueBudgetEvaluation(tx, { companyId: event.companyId, agentId: event.agentId, projectId: event.projectId })),
    getInvocationBlock: (companyId: string, agentId: string | null, context?: AdmissionContext) =>
      withBudgetSpan("budget.admission.inspect", () => withAccountingReadSnapshot(db, companyId,
        tx => budgetServiceInTransaction(tx).getInvocationBlock(companyId, agentId, context))),
    resolveIncident: async (companyId: string, incidentId: string, input: BudgetIncidentResolutionInput, actorUserId: string) => {
      const [scope] = await db.select({ scopeType: budgetIncidents.scopeType, scopeId: budgetIncidents.scopeId }).from(budgetIncidents)
        .where(and(eq(budgetIncidents.id, incidentId), eq(budgetIncidents.companyId, companyId)));
      if (!scope) throw notFound("Budget incident not found");
      return mutate(companyId, service => service.resolveIncident(companyId, incidentId, input, actorUserId), scope);
    },
  };
}
