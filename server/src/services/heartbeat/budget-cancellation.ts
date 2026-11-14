import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";
import type { BudgetEnforcementScope } from "../budgets.js";

/** Committed Stop intent survives policy edits, deletion, and terminal status.
 * Run control writes deliveredAt only after its ordinary stop proof succeeds. */
export function pendingBudgetRunCancellationPredicate() {
  return and(
    sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement') = 'object'`,
    sql`${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement'->>'deliveredAt' is null`,
  );
}

export function budgetCancellationScopePredicate(scope: Pick<BudgetEnforcementScope, "companyId" | "scopeType" | "scopeId">) {
  return and(eq(heartbeatRuns.companyId, scope.companyId),
    sql`${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement'->>'companyId' = ${scope.companyId}`,
    sql`${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement'->>'scopeType' = ${scope.scopeType}`,
    sql`${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement'->>'scopeId' = ${scope.scopeId}`);
}

/** The run IDs that still owe one scope's committed Stop (run control). */
export function pendingBudgetRunIdsForScopeQuery(db: Db, scope: Pick<BudgetEnforcementScope, "companyId" | "scopeType" | "scopeId">) {
  return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(pendingBudgetRunCancellationPredicate(), budgetCancellationScopePredicate(scope)));
}

/** The idle-sleep check: any committed Stop that is not delivered yet. */
export function pendingBudgetRunCancellationExistsQuery() {
  return sql`SELECT 1 FROM heartbeat_runs WHERE ${pendingBudgetRunCancellationPredicate()}`;
}

/** Oldest pending scopes first. The partial index
 * `heartbeat_runs_pending_budget_cancellation_idx` keeps this off the full
 * run history; its predicate must match `pendingBudgetRunCancellationPredicate`. */
export function pendingBudgetCancellationScopesQuery(db: Db, limit = 100) {
  const intent = sql`${heartbeatRuns.resultJson}->'startupCancellation'->'budgetEnforcement'`;
  const scopeType = sql<string>`${intent}->>'scopeType'`, scopeId = sql<string>`${intent}->>'scopeId'`;
  const attemptAt = sql`coalesce((${intent}->>'lastAttemptAt')::timestamptz,
    (${heartbeatRuns.resultJson}->'startupCancellation'->>'requestedAt')::timestamptz, ${heartbeatRuns.updatedAt})`;
  return db.select({ companyId: heartbeatRuns.companyId,
    intent: sql<Record<string, unknown>>`(array_agg(${intent} order by ${attemptAt}, ${heartbeatRuns.id}))[1]`,
  }).from(heartbeatRuns).where(pendingBudgetRunCancellationPredicate())
    .groupBy(heartbeatRuns.companyId, scopeType, scopeId)
    .orderBy(sql`min(${attemptAt})`, heartbeatRuns.companyId, scopeType, scopeId)
    .limit(limit);
}

export async function listPendingBudgetCancellationScopes(db: Db, limit = 100): Promise<BudgetEnforcementScope[]> {
  const rows = await pendingBudgetCancellationScopesQuery(db, limit);
  return rows.flatMap(({ companyId, intent }) => {
    if (intent.companyId !== companyId || !["company", "agent", "project"].includes(String(intent.scopeType))
      || typeof intent.scopeId !== "string" || !isUuidLike(intent.scopeId)
      || typeof intent.policyId !== "string" || !isUuidLike(intent.policyId)
      || !Number.isSafeInteger(intent.version) || Number(intent.version) < 0) return [];
    const cutoff = typeof intent.createdBefore === "string" ? new Date(intent.createdBefore) : null;
    return [{ companyId, scopeType: intent.scopeType as BudgetEnforcementScope["scopeType"], scopeId: intent.scopeId,
      enforcement: { policyId: intent.policyId, version: Number(intent.version) },
      ...(cutoff && Number.isFinite(cutoff.getTime()) ? { createdBefore: cutoff } : {}) }];
  });
}
