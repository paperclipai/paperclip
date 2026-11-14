import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import type { ProviderTurnWaitOptions } from "../../vendor/paperclip-runner/index.js";

type NativeRunScope = { companyId: string; runId: string; issueId: string; agentId: string };

export async function nativeProviderTurnWaitStartedAt(db: Db, scope: Pick<NativeRunScope, "companyId" | "runId">) {
  const [first] = await db.select({ createdAt: heartbeatRunEvents.createdAt }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId),
    eq(heartbeatRunEvents.eventType, "turn.completed"),
    sql`${heartbeatRunEvents.payload} -> 'prpEvent' -> 'payload' ->> 'awaitingProviderTurn' = 'true'`,
  )).orderBy(asc(heartbeatRunEvents.seq)).limit(1);
  return first?.createdAt instanceof Date ? first.createdAt.getTime() : null;
}

export async function personCommentedDuringNativeRun(db: Db, scope: NativeRunScope) {
  const [run] = await db.select({ startedAt: heartbeatRuns.startedAt, createdAt: heartbeatRuns.createdAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, scope.runId))).limit(1);
  if (!run) return false;
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, scope.issueId),
    isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.createdByRunId),
    isNull(issueComments.deletedAt), gte(issueComments.createdAt, run.startedAt ?? run.createdAt),
    sql`exists (select 1 from ${agentWakeupRequests} where ${agentWakeupRequests.companyId} = ${scope.companyId}
      and ${agentWakeupRequests.agentId} = ${scope.agentId} and ${agentWakeupRequests.status} = 'deferred_issue_execution'
      and ${agentWakeupRequests.payload} ->> 'issueId' = ${scope.issueId}
      and (${agentWakeupRequests.payload} -> '_paperclipWakeContext' -> 'wakeCommentIds') @> jsonb_build_array((${issueComments.id})::text))`,
  )).limit(1);
  return comment !== undefined;
}

type PersonCommentWaiter = { scope: NativeRunScope; owed: boolean; resolve: () => void };
type Coordinator = Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">;
const personCommentWaiters = new WeakMap<Db, Set<PersonCommentWaiter>>();
const personCommentWakes = new WeakMap<Db, () => void>();

function waitersFor(db: Db) {
  let waiters = personCommentWaiters.get(db);
  if (!waiters) personCommentWaiters.set(db, waiters = new Set());
  return waiters;
}

export function registerPersonCommentWaitWork(db: Db, coordinator: Coordinator, read = personCommentedDuringNativeRun) {
  const waiters = waitersFor(db);
  const worker = coordinator.register(DELIVERY_QUEUES.nativeProviderTurnWaits, {
    retryMs: 5_000,
    runDuringDrain: true,
    async run(signal) {
      const failures: unknown[] = [];
      for (const waiter of [...waiters]) {
        if (signal.aborted) return;
        if (!waiter.owed) continue;
        waiter.owed = false;
        try {
          if (await read(db, waiter.scope) && waiters.delete(waiter)) waiter.resolve();
        } catch (error) {
          waiter.owed = true;
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    },
    async hasPending() {
      return [...waiters].some(waiter => waiter.owed);
    },
  });
  personCommentWakes.set(db, worker.wake);
  const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, () => {
    if (!waiters.size) return;
    for (const waiter of waiters) waiter.owed = true;
    worker.wake();
  });
  const stop = () => {
    unsubscribe();
    if (personCommentWakes.get(db) === worker.wake) personCommentWakes.delete(db);
  };
  return { ...worker, stop };
}

export function awaitPersonCommentDuringNativeRun(db: Db, scope: NativeRunScope, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const waiters = waitersFor(db);
    const abort = () => {
      waiters.delete(waiter);
      reject(signal.reason);
    };
    const waiter: PersonCommentWaiter = { scope, owed: true, resolve: () => {
      signal.removeEventListener("abort", abort);
      resolve();
    } };
    signal.addEventListener("abort", abort, { once: true });
    waiters.add(waiter);
    personCommentWakes.get(db)?.();
  });
}

export async function nativeProviderTurnWaitOptions(db: Db, scope: NativeRunScope): Promise<ProviderTurnWaitOptions> {
  return {
    startedAtMs: await nativeProviderTurnWaitStartedAt(db, scope),
    onWait: ({ signal }) => awaitPersonCommentDuringNativeRun(db, scope, signal),
  };
}
