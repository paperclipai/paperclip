import { PersistedExecutionWaitRefusal } from "../deferred-execution-wait.js";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { DeferredExecutionScope, DeferredReceiptRecoveryOptions } from "../deferred-execution-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };
type NativeIntentOptions = DeferredExecutionScope & {
  onDeferredDeadline(at: number): void;
  onError(error: unknown): void;
};

export function registerDeferredReceiptWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    resume(scope: DeferredReceiptRecoveryOptions): Promise<unknown>;
    settleTaskChat(scope: DeferredExecutionScope): Promise<unknown>;
    createNativeBatch(): (scope: NativeIntentOptions) => Promise<unknown>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  function register(kind: "deferred" | "task_chat" | "native") {
    const cursors = new Map<string, string>();
    let enabled = false;
    let dispatchNative: ReturnType<typeof owner.createNativeBatch>;
    const queue = kind === "deferred" ? DELIVERY_QUEUES.deferredExecutionReceipts
      : kind === "task_chat" ? DELIVERY_QUEUES.taskRetryReceiptSettlement : DELIVERY_QUEUES.nativeStatusWakeIntents;
    return registerScopedDeadlineWork<Entry, DeferredExecutionScope>(coordinator, {
      queue,
      batchSize: kind === "native" ? 100 : undefined,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => {
        enabled = !(await owner.schedulingSuppressed());
        if (kind === "native") dispatchNative = owner.createNativeBatch();
      },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId && (!scope.requestId || entry.id === scope.requestId),
      load: async scope => {
        const key = scope ? JSON.stringify({ companyId: scope.companyId, requestId: scope.requestId }) : "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
          status: agentWakeupRequests.status, updatedAt: agentWakeupRequests.updatedAt,
          claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
          delayed: sql<boolean>`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null
            or ${agentWakeupRequests.payload}->'executionWait' is not null`,
          interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
            where r.company_id = ${agentWakeupRequests.companyId} and r.agent_id = ${agentWakeupRequests.agentId}
              and r.runtime_mode = 'legacy' and r.status = 'cancelled'
              and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text)`,
        }).from(agentWakeupRequests).where(and(
          scope ? eq(agentWakeupRequests.companyId, scope.companyId) : undefined,
          scope?.requestId ? eq(agentWakeupRequests.id, scope.requestId) : undefined,
          cursor ? gt(agentWakeupRequests.id, cursor) : undefined,
          kind === "native" ? and(
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
            inArray(agentWakeupRequests.status, ["queued", "claimed"]), isNull(agentWakeupRequests.runId),
          ) : and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
            kind === "task_chat" ? and(eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' is not null`) : or(
              eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
              sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
              sql`jsonb_typeof(${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'
                and ${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
              sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
              sql`exists (select 1 from heartbeat_runs r where r.company_id = ${agentWakeupRequests.companyId}
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text)`,
            )),
        )).orderBy(asc(agentWakeupRequests.id)).limit(100);
        const complete = rows.length < 100;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        return { rows: rows.map(row => ({ id: row.id, companyId: row.companyId,
          dueAt: kind === "native" && row.status === "claimed" && row.claimedAt ? row.claimedAt.getTime() + 60_000
            : kind === "native" && row.error ? row.updatedAt.getTime() + 30_000
            : kind === "deferred" && row.delayed && !row.interruptedLegacy ? row.updatedAt.getTime() + 30_000
            : Date.now(),
        })), complete };
      },
      check: async entry => {
        if (!enabled) return null;
        if (kind !== "task_chat") {
          const [current] = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload,
            updatedAt: agentWakeupRequests.updatedAt, claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
            interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
              where r.company_id = ${agentWakeupRequests.companyId} and r.agent_id = ${agentWakeupRequests.agentId}
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text)`,
          }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, entry.companyId),
            eq(agentWakeupRequests.id, entry.id)));
          if (!current) return null;
          const due = kind === "native" && current.status === "claimed" && current.claimedAt
            ? current.claimedAt.getTime() + 60_000
            : kind === "native" && current.status === "queued" && current.error ? current.updatedAt.getTime() + 30_000
              : kind === "deferred" && current.status === "deferred_issue_execution" && !current.interruptedLegacy
                && (current.payload?.queuedCommentInterrupt || current.payload?.executionWait)
                ? current.updatedAt.getTime() + 30_000 : null;
          if (due !== null && due > Date.now()) return { ...entry, dueAt: due };
        }
        const errors: unknown[] = [];
        let next: number | null = null;
        const scope = { companyId: entry.companyId, requestId: entry.id };
        if (kind === "native") await dispatchNative({ ...scope,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); },
          onError: error => { errors.push(error); },
        });
        else if (kind === "task_chat") await owner.settleTaskChat(scope);
        else {
          const failed = (error: unknown) => { if (!(error instanceof PersistedExecutionWaitRefusal)) errors.push(error); };
          try { await owner.resume({ ...scope, onError: failed }); }
          catch (error) { failed(error); }
        }
        if (errors.length) throw new AggregateError(errors, `Deferred receipt ${entry.id} could not settle`);
        return next === null ? null : { ...entry, dueAt: next };
      },
    }, canRun);
  }
  const workers = [register("deferred"), register("task_chat"), register("native")];
  return { ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
