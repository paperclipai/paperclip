import type { Db } from "@paperclipai/db";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";

export interface BudgetContractResult {
  blocked: boolean;
  scopeType?: string;
  scopeId?: string;
  reason?: string;
}

export interface BudgetContract {
  checkInvocation(
    companyId: string,
    agentId: string,
    context?: { issueId?: string | null; projectId?: string | null },
  ): Promise<BudgetContractResult>;

  cancelWorkForScope(scope: BudgetEnforcementScope): Promise<void>;
}

export function createBudgetContract(
  db: Db,
  hooks: { cancelWorkForScope: (scope: BudgetEnforcementScope) => Promise<void> },
): BudgetContract {
  const budgets = budgetService(db, hooks);

  return {
    async checkInvocation(companyId, agentId, context) {
      const block = await budgets.getInvocationBlock(companyId, agentId, context);
      if (!block) return { blocked: false };

      return {
        blocked: true,
        scopeType: block.scopeType,
        scopeId: block.scopeId,
        reason: block.reason,
      };
    },

    cancelWorkForScope: hooks.cancelWorkForScope,
  };
}
