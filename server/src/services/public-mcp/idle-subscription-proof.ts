import { createHash } from "node:crypto";
import { asc, isNull, sql } from "drizzle-orm";
import { mcpEventSubscriptions, type Db } from "@paperclipai/db";
import { ISSUE_STATUSES } from "@paperclipai/shared";
import type { DeadlineReconciliationSnapshot } from "../deadline-reconciliation.js";
import type { IdleMcpInspectionBudget, IdleMcpWakeProof } from "./idle-wake-proof.js";

type Subscription = typeof mcpEventSubscriptions.$inferSelect;
export interface IdleMcpSubscriptionProof {
  blocked: boolean;
  subscriptionIds: string[];
  generation: string;
}
export interface IdleMcpSubscriptionProofInput {
  budget?: IdleMcpInspectionBudget;
  now: number;
  ingress: IdleMcpWakeProof;
  personal: DeadlineReconciliationSnapshot;
  dot: DeadlineReconciliationSnapshot;


  inspectDestination: (subscription: Subscription) => Promise<boolean>;
}



export async function readIdleMcpSubscriptionProof(tx: Pick<Db, "select">, input: IdleMcpSubscriptionProofInput): Promise<IdleMcpSubscriptionProof> {
  await input.budget?.beforeRead();
  const rows = await tx.select({ subscription: mcpEventSubscriptions,
    taskMatches: sql<boolean>`EXISTS (SELECT 1 FROM issues i WHERE i.id = ${mcpEventSubscriptions.taskId}
      AND i.company_id = ${mcpEventSubscriptions.companyId})`,
  }).from(mcpEventSubscriptions).where(isNull(mcpEventSubscriptions.stoppedAt)).orderBy(asc(mcpEventSubscriptions.id)).limit(1001);
  return projectIdleMcpSubscriptionProof(rows, input);
}

export async function projectIdleMcpSubscriptionProof(rows: { subscription: Subscription; taskMatches: boolean }[], input: IdleMcpSubscriptionProofInput): Promise<IdleMcpSubscriptionProof> {
  input.budget?.check();
  const state: unknown[] = [], subscriptionIds: string[] = [];
  const result = (blocked: boolean): IdleMcpSubscriptionProof => ({ blocked, subscriptionIds: blocked ? [] : subscriptionIds,
    generation: createHash("sha256").update(JSON.stringify([input.ingress.generation, input.personal, input.dot, state])).digest("hex") });
  if (!Number.isFinite(input.now) || rows.length > 1000) return result(true);
  const grants = new Set(input.ingress.grantIds), bindings = new Set(input.ingress.dotBindingIds);
  for (const { subscription: row, taskMatches } of rows) {
    input.budget?.check();
    const args = row.arguments;
    const task = row.taskId !== null && row.bindingId === null && taskMatches === true
      && ["paperclip.task.status_changed", "paperclip.task.comment_created", "paperclip.task.document_updated"].includes(row.name);
    const dot = row.bindingId !== null && row.taskId === null && bindings.has(row.bindingId) && row.name === "paperclip.dot.mailbox_updated";
    const owner = task ? input.personal : dot ? input.dot : undefined;
    if (!grants.has(row.grantId) || !owner?.reconciled || !owner.revision || !args || typeof args !== "object" || Array.isArray(args)
      || args.companyId !== row.companyId || args[task ? "taskId" : "bindingId"] !== (task ? row.taskId : row.bindingId)
      || Object.keys(args).some(key => !["companyId", task ? "taskId" : "bindingId", ...(row.name === "paperclip.task.status_changed" ? ["statuses"] : [])].includes(key))
      || (args.statuses !== undefined && (!Array.isArray(args.statuses) || !args.statuses.length || args.statuses.some(status => !ISSUE_STATUSES.includes(status as typeof ISSUE_STATUSES[number]))))
      || !Number.isFinite(row.startsAt.getTime()) || !Number.isFinite(row.expiresAt.getTime()) || row.expiresAt <= row.startsAt
      || !Number.isFinite(row.verifiedAt.getTime()) || row.verifiedAt.getTime() > input.now
      || !Number.isFinite(row.scannedAt.getTime()) || (row.expiresAt.getTime() > input.now && row.scannedAt < row.verifiedAt)
      || !await input.inspectDestination(row)) return result(true);
    input.budget?.check();
    state.push([row.id, row.companyId, row.grantId, row.name, row.taskId, row.bindingId, row.arguments,
      row.verifiedAt, row.startsAt, row.expiresAt, row.scannedAt,
      createHash("sha256").update(JSON.stringify(row.deliveryMaterial)).digest("hex")]);
    subscriptionIds.push(row.id);
  }
  return result(false);
}
