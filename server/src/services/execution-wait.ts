import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";

type WakeRequest = typeof agentWakeupRequests.$inferInsert;

/**
 * Record a known gate without inventing an execution attempt. The caller holds
 * the company-scoped issue row lock. Only replaceable automatic signals may
 * coalesce; messages and authorized interaction receipts keep their identity.
 * These receipts are diagnostics, never authority to suppress a future wake:
 * admission must read the current gate again before calling this function.
 */
export async function recordExecutionWait(
  tx: Db,
  input: {
    issueId: string;
    request: WakeRequest;
    condition: Record<string, unknown>;
    coalesce: boolean;
  },
): Promise<{ created: boolean }> {
  const { request, issueId, condition } = input;
  const digest = createHash("sha256")
    .update(JSON.stringify([request.companyId, request.agentId, issueId, request.reason, condition]))
    .digest("hex");
  const key = `execution-wait:${digest}`;
  if (input.coalesce) {
    const [existing] = await tx.select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, request.companyId),
        eq(agentWakeupRequests.agentId, request.agentId),
        eq(agentWakeupRequests.status, "skipped"),
        eq(agentWakeupRequests.idempotencyKey, key),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).limit(1);
    if (existing) {
      await tx.update(agentWakeupRequests).set({
        coalescedCount: sql`${agentWakeupRequests.coalescedCount} + 1`,
        updatedAt: new Date(),
      }).where(and(
        eq(agentWakeupRequests.companyId, request.companyId),
        eq(agentWakeupRequests.id, existing.id),
      ));
      return { created: false };
    }
  }
  await tx.insert(agentWakeupRequests).values({
    ...request,
    status: "skipped",
    runId: null,
    finishedAt: new Date(),
    idempotencyKey: input.coalesce ? key : request.idempotencyKey,
    payload: {
      ...request.payload,
      issueId,
      executionWait: { ...condition, requestedIdempotencyKey: request.idempotencyKey ?? null },
    },
  });
  return { created: true };
}
