import { HttpError } from "../errors.js";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";

/** Admission has saved this refusal on the caller's durable deferred receipt.
 * HTTP callers still receive the existing 409; receipt recovery waits for its
 * owning gate producer instead of treating the refusal as infrastructure debt. */
export class PersistedExecutionWaitRefusal extends HttpError {
  constructor(message: string, details?: unknown) { super(409, message, details); }
}

export async function writeDeferredExecutionWait(db: Db, scope: { companyId: string; requestId: string },
  condition: Record<string, unknown>, options: { replace?: boolean } = {}) {
  return db.transaction(async tx => {
    const [current] = await tx.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"))).for("update");
    if (!current) return false;
    const previous = current.payload?.executionWait;
    const previousReason = previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>).reason : undefined;
    if (!previous || previousReason !== condition.reason) await notifyDeferredExecutionWork(tx, scope);
    const [saved] = await tx.update(agentWakeupRequests).set({
      payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
        ${options.replace ? sql`'{}'::jsonb` : sql`coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb)`}
          || ${JSON.stringify(condition)}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.id, scope.requestId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"))).returning({ id: agentWakeupRequests.id });
    return Boolean(saved);
  });
}
