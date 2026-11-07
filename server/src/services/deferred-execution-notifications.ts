import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type DeferredExecutionScope = { companyId: string; requestId?: string };
export type DeferredReceiptRecoveryOptions = {
  companyId?: string;
  requestId?: string;
  onError?: (error: unknown) => void;
};

function hint(scope: DeferredExecutionScope) {
  return JSON.stringify({ companyId: scope.companyId, requestId: scope.requestId });
}

export async function notifyDeferredExecutionWork(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.deferredExecutionReceipts, hint(scope));
}

export async function notifyNativeStatusWakeWork(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusWakeIntents, hint(scope));
}

export async function notifyTaskRetrySettlement(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.taskRetryReceiptSettlement, hint(scope));
}

export async function notifyDeferredExecutionEligibility(tx: object, scope?: { companyId: string }) {
  // Only an actual continuation obligation may wake this passive worker.
  // Empty eligibility hints during idle drain must not keep maintenance active.
  const pending = await (tx as Pick<Db, "execute">).execute<{ pendingPreparationContinuation: boolean }>(sql`
    select exists (select 1 from issue_recovery_actions
      where evidence ? 'systemRecovery' and evidence#>>'{systemRecovery,state}' = 'complete'
        and evidence->>'bootstrapPreparationSettledAt' is not null
        and coalesce(evidence->>'bootstrapPreparationContinuation', 'pending') in ('pending', 'deferred')
        ${scope ? sql`and company_id = ${scope.companyId}::uuid` : sql``}
    ) as "pendingPreparationContinuation"`);
  if (pending[0]?.pendingPreparationContinuation === true)
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery, scope ? JSON.stringify({ companyId: scope.companyId }) : "*");
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeProcessSessions, scope ? JSON.stringify({ companyId: scope.companyId }) : "*");
  if (scope) {
    await notifyDeferredExecutionWork(tx, scope);
    await notifyNativeStatusWakeWork(tx, scope);
  } else {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.deferredExecutionReceipts, "*");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusWakeIntents, "*");
  }
}
