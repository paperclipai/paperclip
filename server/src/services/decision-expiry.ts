import { and, asc, eq, getTableColumns, lte, sql } from "drizzle-orm";
import { decisions, type Db } from "@paperclipai/db";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { writeDecisionChange } from "./decision-work-notifications.js";

type Decision = typeof decisions.$inferSelect;
type ExpiryReason = "ttl" | "target_gone" | "target_completed";
const open = sql`${decisions.status} = 'open'`;

export function decisionExpiryService(db: Db, deliverContinuation: (id: string) => Promise<void>) {
  let recoveryCursor: { expiresAt: string; id: string } | undefined;
  async function expire(decision: Decision, reason: ExpiryReason, now: Date) {
    const publications: ActivityPublication[] = [];
    const updated = await writeDecisionChange(db, async tx => {
      const [row] = await tx.update(decisions).set({
        status: "expired", updatedAt: now,
        metadata: sql`${decisions.metadata} || ${JSON.stringify({ expiredReason: reason,
          ...(decision.continuationPolicy === "wake_origin_agent" ? { continuationPending: true } : {}) })}::jsonb`,
      }).where(and(eq(decisions.id, decision.id), open,
        reason === "ttl" ? lte(decisions.expiresAt, now) : undefined)).returning();
      if (!row) return null;
      await logActivity(tx, { companyId: row.companyId, actorType: "system", actorId: "decision-expiry-sweeper",
        agentId: row.originAgentId, runId: row.originRunId, action: "decision.expired", entityType: "decision",
        entityId: row.id, details: { expiredReason: reason } }, publications);
      return row;
    });
    if (!updated) return 0;
    for (const publication of publications) publishActivity(publication);
    await deliverContinuation(updated.id);
    return 1;
  }

  async function due(now: Date, limit: number, cursor?: { expiresAt: string; id: string }) {
    return db.select({ ...getTableColumns(decisions), cursorExpiresAt: sql<string>`${decisions.expiresAt}::text` })
      .from(decisions).where(and(open, lte(decisions.expiresAt, now), cursor
      ? sql`(${decisions.expiresAt}, ${decisions.id}) > (${cursor.expiresAt}::timestamptz, ${cursor.id}::uuid)` : undefined))
      .orderBy(asc(decisions.expiresAt), asc(decisions.id)).limit(limit);
  }

  async function sweep(now = new Date(), signal?: AbortSignal) {
    let expired = 0;
    if (signal?.aborted) return { expired };
    const errors: unknown[] = [];
    const configuredBatchSize = Number(process.env.PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE ?? 100);
    const batchSize = Number.isFinite(configuredBatchSize) ? Math.max(1, Math.trunc(configuredBatchSize)) : 100;
    const rows = await due(now, batchSize, recoveryCursor);
    for (const row of rows) {
      if (signal?.aborted) return { expired };
      try { expired += await expire(row, "ttl", now); } catch (error) { errors.push(error); }
      recoveryCursor = { expiresAt: row.cursorExpiresAt, id: row.id };
    }
    if (rows.length < batchSize) recoveryCursor = undefined;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Decision expiry failed");
    return { expired };
  }

  async function next(): Promise<number | null> {
    const [row] = await db.select({ at: decisions.expiresAt }).from(decisions).where(open)
      .orderBy(asc(decisions.expiresAt), asc(decisions.id)).limit(1);
    return row?.at.getTime() ?? null;
  }

  return { expire, due, sweep, next };
}
