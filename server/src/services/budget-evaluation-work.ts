import { sql } from "drizzle-orm";
import { budgetEvaluationWork, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type BudgetEvaluationInput = { companyId: string; agentId?: string | null; projectId?: string | null };

/** Call only for an actual committed exposure change, on that change's tx. */
export async function queueBudgetEvaluation(tx: Db, input: BudgetEvaluationInput): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.budgetEnforcement, input.companyId);
  await tx.insert(budgetEvaluationWork).values(input);
}

export function pendingBudgetEvaluationWorkQuery() {
  return sql`SELECT 1 FROM ${budgetEvaluationWork}`;
}

export async function hasPendingBudgetEvaluation(db: Db): Promise<boolean> {
  const [row] = await db.select({ id: budgetEvaluationWork.id }).from(budgetEvaluationWork).limit(1);
  return Boolean(row);
}
