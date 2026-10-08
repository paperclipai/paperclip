import type { Db } from "@paperclipai/db";
import type { BudgetServiceHooks } from "./budgets.js";
import { agentConfiguration } from "../modules/agent-lifecycle/index.js";

/** Read agents and change configuration. Lifecycle commands have a separate entry point. */
export function agentService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  return agentConfiguration(db, budgetHooks);
}

export { hasAgentShortnameCollision, deduplicateAgentName } from "../modules/agent-lifecycle/index.js";
