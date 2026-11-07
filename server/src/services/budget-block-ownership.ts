import { and, eq } from "drizzle-orm";
import { budgetPolicies, type Db } from "@paperclipai/db";
import { policyBlocks } from "./budgets.js";

/** A reached hard stop (spend at the limit, or blocked unpriced usage) is a
 * board decision. Any other budget block (completed runs awaiting accounting,
 * a native run recovering its accounting, a hold awaiting reconciliation)
 * clears by itself. Read only: the admission check already reconciled. */
export async function isBoardOwnedBudgetBlock(
  db: Db,
  companyId: string,
  block: { scopeType: string; scopeId: string },
) {
  const policies = await db.select().from(budgetPolicies).where(and(
    eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, block.scopeType),
    eq(budgetPolicies.scopeId, block.scopeId), eq(budgetPolicies.isActive, true)));
  for (const policy of policies) if (await policyBlocks(db, policy)) return true;
  return false;
}
