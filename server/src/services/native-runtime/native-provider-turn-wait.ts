import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

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

export function awaitPersonCommentDuringNativeRun(db: Db, scope: NativeRunScope, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let checking = false;
    let again = false;
    const stop = () => {
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const check = () => {
      if (checking) {
        again = true;
        return;
      }
      checking = true;
      void personCommentedDuringNativeRun(db, scope).then(found => {
        checking = false;
        if (signal.aborted) return;
        if (found) {
          stop();
          resolve();
        } else if (again) {
          again = false;
          check();
        }
      }, () => {
        checking = false;
      });
    };
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, check);
    signal.addEventListener("abort", abort, { once: true });
    check();
  });
}

export async function nativeProviderTurnWaitOptions(db: Db, scope: NativeRunScope): Promise<ProviderTurnWaitOptions> {
  return {
    startedAtMs: await nativeProviderTurnWaitStartedAt(db, scope),
    onWait: ({ signal }) => awaitPersonCommentDuringNativeRun(db, scope, signal),
  };
}
