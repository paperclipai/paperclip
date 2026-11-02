import { and, asc, eq, gt, sql } from "drizzle-orm";
import { databaseWorkScopeKey, decisions, type Db } from "@paperclipai/db";

export type DecisionContinuationWake = (input: {
  companyId: string; agentId: string; issueId: string; decisionId: string;
  outcome: "decided" | "expired" | "cancelled";
}) => Promise<unknown>;

const flights = new WeakMap<object, Map<string, Promise<void>>>();
const ready = sql`${decisions.continuationPolicy} = 'wake_origin_agent'
  AND ${decisions.metadata} ->> 'continuationPending' = 'true'
  AND (${decisions.status} IN ('expired', 'cancelled') OR
    (${decisions.status} = 'decided' AND ${decisions.executionStatus} IN ('succeeded', 'partial', 'failed')))`;

export function decisionContinuationService(db: Db, wake: DecisionContinuationWake) {
  const scope = databaseWorkScopeKey(db);
  let pending = flights.get(scope);
  if (!pending) flights.set(scope, pending = new Map());
  const inFlight = pending;
  let recoveryCursor: string | undefined;

  function deliver(id: string): Promise<void> {
    const existing = inFlight.get(id);
    if (existing) return existing;
    const attempt = (async () => {
      const [decision] = await db.select().from(decisions).where(and(eq(decisions.id, id), ready));
      if (!decision) return;
      await wake({ companyId: decision.companyId, agentId: decision.originAgentId,
        issueId: decision.originIssueId, decisionId: id,
        outcome: decision.status === "expired" ? "expired" : decision.status === "cancelled" ? "cancelled" : "decided" });
      await db.update(decisions).set({
        metadata: sql`coalesce(${decisions.metadata}, '{}'::jsonb) || jsonb_build_object(
          'continuationPending', false, 'continuationDeliveredAt', ${new Date().toISOString()}::text)`,
        updatedAt: new Date(),
      }).where(and(eq(decisions.id, id), ready));
    })().finally(() => { inFlight.delete(id); });
    inFlight.set(id, attempt);
    return attempt;
  }

  async function sweep(maxRows = 100, signal?: AbortSignal) {
    let attempted = 0;
    const errors: unknown[] = [];
    while (attempted < maxRows) {
      if (signal?.aborted) return { retry: true };
      const limit = Math.min(100, maxRows - attempted);
      const rows = await db.select({ id: decisions.id }).from(decisions)
        .where(and(ready, recoveryCursor ? gt(decisions.id, recoveryCursor) : undefined))
        .orderBy(asc(decisions.id)).limit(limit);
      for (const row of rows) {
        if (signal?.aborted) return { retry: true };
        try { await deliver(row.id); } catch (error) { errors.push(error); }
        recoveryCursor = row.id;
      }
      attempted += rows.length;
      if (rows.length < limit) { recoveryCursor = undefined; break; }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Decision continuation delivery failed");
    if (signal?.aborted) return { retry: true };
    const remaining = await db.select({ id: decisions.id }).from(decisions).where(ready).limit(1);
    return { retry: remaining.length > 0 };
  }

  return { deliver, sweep };
}
