import { and, asc, eq, gt, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { readRunCancellation } from "../run-cancellation.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import type { ScheduledRetryCancellationScope } from "../scheduled-retry-cancellation-notifications.js";
import type { CancelRunOptions } from "./run-control.js";

type Deadline = { id: string; companyId: string; dueAt: number };

export function createScheduledRetryCancellationRecovery(db: Db, cancelRun: (
  runId: string, reason: string, options: Pick<CancelRunOptions, "expectedStatus" | "errorCode" | "resultJson">,
) => Promise<unknown>) {
  function candidates(scope?: ScheduledRetryCancellationScope, cursor?: string, full = false) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
      result: full ? sql<Record<string, unknown>>`${heartbeatRuns.resultJson}`
        : sql<Record<string, unknown>>`jsonb_build_object('cancellation', ${heartbeatRuns.resultJson}->'cancellation')`,
      errorCode: sql<unknown>`${heartbeatRuns.resultJson}->'startupCancellation'->'errorCode'`,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.status, "scheduled_retry"),
      sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation') = 'object'`,
      scope ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
      scope?.runId ? eq(heartbeatRuns.id, scope.runId) : undefined,
      cursor ? gt(heartbeatRuns.id, cursor) : undefined,
    )).orderBy(asc(heartbeatRuns.id)).limit(100);
  }
  async function load(scope: ScheduledRetryCancellationScope | undefined, admitted: () => boolean, cursor?: string) {
    if (!admitted()) throw new Error("Scheduled retry cancellation reconstruction stopped");
    const rows = await candidates(scope, cursor);
    if (!admitted()) throw new Error("Scheduled retry cancellation reconstruction stopped");
    const entries: Deadline[] = rows.filter(row => readRunCancellation(row.result)?.expected)
      .map(row => ({ id: row.id, companyId: row.companyId, dueAt: 0 }));
    return { rows: entries, complete: rows.length < 100, cursor: rows.at(-1)?.id };
  }
  async function check(entry: Deadline, admitted: () => boolean) {
    const [run] = await candidates({ companyId: entry.companyId, runId: entry.id }, undefined, true);
    const cancellation = readRunCancellation(run?.result);
    if (!run || !cancellation?.expected) return null;
    if (!admitted()) throw new Error("Scheduled retry cancellation stopped");
    await cancelRun(run.id, cancellation.reason, { expectedStatus: "scheduled_retry",
      errorCode: typeof run.errorCode === "string" && run.errorCode.trim() ? run.errorCode.trim() : "cancelled",
      resultJson: run.result });
    const [remaining] = await candidates({ companyId: entry.companyId, runId: entry.id });
    if (remaining && readRunCancellation(remaining.result)?.expected)
      throw new Error("Scheduled retry cancellation remains pending");
    return null;
  }
  async function sweep() {
    let cursor: string | undefined;
    let checked = 0;
    while (checked < 20) {
      const page = await load(undefined, () => true, cursor);
      for (const entry of page.rows) {
        if (checked === 20) break;
        checked++;
        try { await check(entry, () => true); }
        catch (error) { logger.warn({ err: error, runId: entry.id }, "failed to finish interrupted retry cancellation"); }
      }
      if (page.complete) break;
      cursor = page.cursor;
    }
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean>) {
    const cursors = new Map<string, string>();
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.scheduledRetryCancellation,
      batchSize: 20,
      decodeScope: (hint: string): ScheduledRetryCancellationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry: Deadline, scope?: ScheduledRetryCancellationScope) => !scope ||
        entry.companyId === scope.companyId && (!scope.runId || entry.id === scope.runId),
      load: async (scope, signal) => {
        const key = scope ? `${scope.companyId}:${scope.runId ?? "*"}` : "*";
        if (!await canRecover()) { cursors.delete(key); return []; }
        const page = await load(scope, () => canRun() && !signal?.aborted, cursors.get(key));
        if (page.complete) cursors.delete(key); else cursors.set(key, page.cursor!);
        return { rows: page.rows, complete: page.complete };
      },
      check: async (entry, signal) => await canRecover()
        ? check(entry, () => canRun() && !signal?.aborted) : null,
    }, canRun);
  }
  return { sweep, register };
}
