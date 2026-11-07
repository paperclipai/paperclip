import type { IdleMcpInspectionBudget } from "./idle-wake-proof.js";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { mcpEventDeliveries as deliveries, mcpEventSubscriptions as subscriptions, type Db } from "@paperclipai/db";
import type { DeadlineReconciliationSnapshot } from "../deadline-reconciliation.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "../idle-deadline-types.js";

export interface IdleMcpEventDeadlineRow {
  id: string;
  subscriptionId: string;
  companyId: string;
  grantId: string;
  taskId: string | null;
  bindingId: string | null;
  subscriptionExpiresAt: Date;
  subscriptionStoppedAt: Date | null;
  nextAttemptAt: Date;
  attempts: number;
  outcome: string | null;
  sourceMatches: boolean;
}
export interface IdleMcpEventScheduleProof extends IdleDeadlineSnapshot {
  deliveryIds: string[];
}
export interface IdleMcpEventScheduleInput {
  budget?: IdleMcpInspectionBudget;
  now: number;
  coveredGrantIds: readonly string[];
  personal: DeadlineReconciliationSnapshot;
  dot: DeadlineReconciliationSnapshot;
}



export function projectIdleMcpEventSchedule(rows: IdleMcpEventDeadlineRow[], input: IdleMcpEventScheduleInput): IdleMcpEventScheduleProof {
  input.budget?.check();
  const state: unknown[] = [], deadlines: number[] = [], deliveryIds: string[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [], deliveryIds: [] });
  if (!Number.isFinite(input.now) || rows.length > idleDeadlineRowLimit) return blocked();
  const grants = new Set(input.coveredGrantIds);
  for (const row of rows) {
    input.budget?.check();
    const owner = row.taskId !== null && row.bindingId === null ? input.personal
      : row.bindingId !== null && row.taskId === null ? input.dot : undefined;
    if (!owner?.reconciled || !owner.revision || !grants.has(row.grantId) || row.sourceMatches !== true
      || row.subscriptionStoppedAt !== null || row.subscriptionExpiresAt.getTime() <= input.now
      || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts >= 6
      || !(row.outcome === "network_error" || row.outcome === "http_408" || row.outcome === "http_429" || /^http_5[0-9][0-9]$/.test(row.outcome ?? ""))
      || !isFutureIdleDeadline(row.nextAttemptAt.getTime(), input.now)) return blocked();
    state.push([row.id, row.subscriptionId, row.companyId, row.grantId, row.taskId, row.bindingId,
      row.subscriptionExpiresAt.toISOString(), row.nextAttemptAt.toISOString(), row.attempts, row.outcome, owner.revision]);
    deadlines.push(row.nextAttemptAt.getTime());
    deliveryIds.push(row.id);
  }
  return { blocked: false, state: [input.personal, input.dot, state], deadlines, deliveryIds };
}

export async function readIdleMcpEventSchedule(tx: Pick<Db, "select">, input: IdleMcpEventScheduleInput): Promise<IdleMcpEventScheduleProof> {
  await input.budget?.beforeRead();
  const rows = await tx.select({ id: deliveries.id, subscriptionId: subscriptions.id,
    companyId: subscriptions.companyId, grantId: subscriptions.grantId, taskId: subscriptions.taskId, bindingId: subscriptions.bindingId,
    subscriptionExpiresAt: subscriptions.expiresAt, subscriptionStoppedAt: subscriptions.stoppedAt,
    nextAttemptAt: deliveries.nextAttemptAt, attempts: deliveries.attempts, outcome: deliveries.outcome,
    sourceMatches: sql<boolean>`((
      ${deliveries.activityId} IS NOT NULL AND ${deliveries.mailboxItemId} IS NULL
      AND ${subscriptions.taskId} IS NOT NULL AND ${subscriptions.bindingId} IS NULL
      AND EXISTS (SELECT 1 FROM activity_log a WHERE a.id = ${deliveries.activityId}
        AND a.company_id = ${subscriptions.companyId} AND a.entity_type = 'issue' AND a.entity_id = ${subscriptions.taskId}::text)
    ) OR (
      ${deliveries.mailboxItemId} IS NOT NULL AND ${deliveries.activityId} IS NULL
      AND ${subscriptions.bindingId} IS NOT NULL AND ${subscriptions.taskId} IS NULL
      AND EXISTS (SELECT 1 FROM dot_mailbox_items m WHERE m.id = ${deliveries.mailboxItemId}
        AND m.company_id = ${subscriptions.companyId} AND m.binding_id = ${subscriptions.bindingId})
    ))`,
  }).from(deliveries).innerJoin(subscriptions, eq(subscriptions.id, deliveries.subscriptionId))
    .where(isNull(deliveries.finishedAt)).orderBy(asc(deliveries.id)).limit(idleDeadlineRowLimit + 1);
  return projectIdleMcpEventSchedule(rows, input);
}
