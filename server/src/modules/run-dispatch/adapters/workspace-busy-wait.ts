import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { notifyScheduledRetryDispatch } from "../../../services/run-dispatch-notifications.js";
import { notifyScheduledRetryCancellation } from "../../../services/scheduled-retry-cancellation-notifications.js";
import {
  WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS,
  WORKSPACE_BUSY_PARKED_RECHECK_MS,
  WORKSPACE_BUSY_RETRY_REASON,
  WORKSPACE_BUSY_WAIT_KEY,
  readWorkspaceBusyWait,
} from "../domain/wake-context.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

const waitKeySql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${WORKSPACE_BUSY_WAIT_KEY} ->> 'key'`;
const waitHolderSql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${WORKSPACE_BUSY_WAIT_KEY} ->> 'holderRunId'`;
const waitingSinceSql = sql<string>`${heartbeatRuns.contextSnapshot} -> ${WORKSPACE_BUSY_WAIT_KEY} ->> 'waitingSince'`;

/**
 * Keeps a due workspace-busy retry parked, in place, while the workspace is
 * still taken: its recorded holder is live, or an earlier waiter for the same
 * workspace has not finished. Dispatching it would only reach the same
 * deferral gate, cancel it, and create another retry run for every check.
 * The holder ending wakes the waiter (wakeWorkspaceBusyWaitersInTx); the new
 * deadline only bounds a missed wake and a holder going stale. Returns true
 * when the run stays parked. Retries without a recorded wait are untouched.
 */
export async function parkWorkspaceBusyRetryInTx(tx: Db, run: HeartbeatRun, now: Date): Promise<boolean> {
  if (run.status !== "scheduled_retry") return false;
  const wait = readWorkspaceBusyWait(run.scheduledRetryReason, run.contextSnapshot);
  if (!wait) return false;

  const [holder] = await tx
    .select({
      status: heartbeatRuns.status,
      lastActivityAt: sql<Date>`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`,
    })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, wait.holderRunId)));
  const holderStaleAt = holder?.status === "running"
    ? new Date(holder.lastActivityAt).getTime() + WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS
    : null;
  const holderLive = holderStaleAt !== null && holderStaleAt > now.getTime();

  // Arrival order among waiters for one workspace: an earlier waiter that is
  // still parked, queued, or running goes first. Without this, every waiter
  // is released when the holder ends and all but one are cancelled again.
  const earlierWaiter = holderLive ? null : await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, run.companyId),
      ne(heartbeatRuns.id, run.id),
      inArray(heartbeatRuns.status, ["scheduled_retry", "queued", "running"]),
      eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
      sql`${waitKeySql} = ${wait.key}`,
      sql`((${waitingSinceSql})::timestamptz, ${heartbeatRuns.id}::text) < (${wait.waitingSince}::timestamptz, ${run.id}::text)`,
      // A silent running waiter is handled like any stale holder, not waited on.
      sql`(${heartbeatRuns.status} <> 'running' or coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${new Date(now.getTime() - WORKSPACE_BUSY_HOLDER_STALE_AFTER_MS).toISOString()}::timestamptz)`,
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!holderLive && !earlierWaiter) return false;

  const recheckAt = new Date(Math.min(
    now.getTime() + WORKSPACE_BUSY_PARKED_RECHECK_MS,
    holderLive ? holderStaleAt! + 1_000 : Number.POSITIVE_INFINITY,
  ));
  await notifyScheduledRetryCancellation(tx, { companyId: run.companyId, runId: run.id });
  const [parked] = await tx
    .update(heartbeatRuns)
    .set({
      scheduledRetryAt: recheckAt,
      updatedAt: now,
      contextSnapshot: sql`jsonb_set(coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb), '{scheduledRetryAt}', to_jsonb(${recheckAt.toISOString()}::text))`,
    })
    .where(and(
      eq(heartbeatRuns.id, run.id),
      eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.status, "scheduled_retry"),
    ))
    .returning({ id: heartbeatRuns.id });
  return Boolean(parked);
}

/**
 * Called in the transaction that ends a running run. Makes every retry parked
 * behind it due now: waiters that recorded it as their holder, and later
 * waiters for the workspace it was itself waiting for. The promotion check
 * then admits them in arrival order.
 */
export async function wakeWorkspaceBusyWaitersInTx(tx: Db, input: {
  companyId: string;
  runId: string;
  contextSnapshot: Record<string, unknown> | null | undefined;
  scheduledRetryReason: string | null | undefined;
  now: Date;
}): Promise<number> {
  const ownKey = readWorkspaceBusyWait(input.scheduledRetryReason, input.contextSnapshot)?.key ?? null;
  const waiting = and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.status, "scheduled_retry"),
    eq(heartbeatRuns.scheduledRetryReason, WORKSPACE_BUSY_RETRY_REASON),
    gt(heartbeatRuns.scheduledRetryAt, input.now),
    ownKey
      ? sql`(${waitHolderSql} = ${input.runId} or ${waitKeySql} = ${ownKey})`
      : sql`${waitHolderSql} = ${input.runId}`,
  );
  const waiters = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(waiting).for("update");
  if (waiters.length === 0) return 0;
  await notifyScheduledRetryDispatch(tx, { companyId: input.companyId });
  const woken = await tx
    .update(heartbeatRuns)
    .set({ scheduledRetryAt: input.now, updatedAt: input.now })
    .where(and(waiting, inArray(heartbeatRuns.id, waiters.map((row) => row.id))))
    .returning({ id: heartbeatRuns.id });
  return woken.length;
}
