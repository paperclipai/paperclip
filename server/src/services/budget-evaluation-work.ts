import { and, eq, or, sql } from "drizzle-orm";
import { budgetEvaluationWork, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type BudgetEvaluationInput = { companyId: string; agentId?: string | null; projectId?: string | null };

/** Call only for an actual committed exposure change, on that change's tx. */
export async function queueBudgetEvaluation(tx: Db, input: BudgetEvaluationInput): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.budgetEnforcement, input.companyId);
  await tx.insert(budgetEvaluationWork).values(input);
}

export async function hasPendingBudgetEvaluation(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: budgetEvaluationWork.id }).from(budgetEvaluationWork).limit(1);
  return Boolean(row);
}

/** A completed idle decision does not age. Only unconsumed relevant inputs do. */
export async function oldestBudgetInputAt(db: Db, input: BudgetEvaluationInput): Promise<Date | null> {
  const [row] = await db.select({ oldest: sql<Date | null>`min(${budgetEvaluationWork.createdAt})` }).from(budgetEvaluationWork)
    .where(and(eq(budgetEvaluationWork.companyId, input.companyId), !input.agentId && !input.projectId ? undefined : or(
      input.agentId ? eq(budgetEvaluationWork.agentId, input.agentId) : undefined,
      input.projectId ? eq(budgetEvaluationWork.projectId, input.projectId) : undefined,
    )));
  return row?.oldest ? new Date(row.oldest) : null;
}
