import type { Db } from "@paperclipai/db";
import type { UpdateAgentOptions } from "../lib/agent-records.js";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, deliverBudgetEnforcement, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent, initializePrimaryAgent } from "./primary-agent.js";
import { agentIdentityService } from "./agent-identity.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { assertClaudeOAuthBindingInvariant, secretService } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { trackIdleWork } from "./task-admission.js";

export { scheduleAgentLifecycle, deleteTerminatedCompanyAgents } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function createAgentLifecycleEffects(hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    transaction: withAccountingTransaction,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive: amount > 0, windowKind: "calendar_month_utc",
      }, userId),
    enforceBudget: (db, companyId) => deliverBudgetEnforcement(db, hooks, companyId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    initializePrimary: initializePrimaryAgent,
    ensureIdentity: (db, companyId, agentId) => agentIdentityService(db).ensureAgentIdentity(companyId, agentId),
    cancelInteractions: (db, companyId, agentId) => issueThreadInteractionService(db).cancelPendingForDeletedAddressee(companyId, agentId),
    normalizeAdapterConfig: (db, companyId, config, adapterType) =>
      secretService(db).normalizeAdapterConfigForPersistence(companyId, config, { adapterType }),
    bindCredentials: (db, input) => agentCredentialService(db).enforceClaudeOAuthBindingClaim(db, {
      companyId: input.companyId, consume: input.consume, environmentId: input.environmentId ?? null,
      claudeLogin: input.claudeLogin, childAdapterConfig: input.adapterConfig,
      decision: assertClaudeOAuthBindingInvariant({ adapterType: input.adapterType,
        nextConfig: input.adapterConfig, priorConfig: input.previousAdapterConfig }),
    }),
    syncSecrets: (db, agent, previousConfig, actor) =>
      agentCredentialService(db).syncAgentSecretBindings(agent, db, previousConfig, actor),
  };
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}) {
  return lifecycle.createAgentLifecycle(db, createAgentLifecycleEffects(hooks));
}

export function updateAgentConfiguration(db: Db, hooks: BudgetServiceHooks,
  ...args: [id: string, data: Parameters<typeof lifecycle.updateAgentConfiguration>[3], options?: UpdateAgentOptions]) {
  return lifecycle.updateAgentConfiguration(db, createAgentLifecycleEffects(hooks), ...args);
}

export function resolveAgentHireApproval(db: Db, id: string, status: "approved" | "rejected", userId: string, note?: string | null) {
  return lifecycle.resolveAgentHireApproval(db, createAgentLifecycleEffects(), id, status, userId, note);
}

export function reconcileAgentPolicyHolds(db: Db, companyId?: string, agentId?: string | null) {
  return lifecycle.reconcileAgentPolicyHolds(db, createAgentLifecycleEffects(), companyId, agentId);
}

function trackedDriver(driver: lifecycle.LifecycleDriver): lifecycle.LifecycleDriver {
  return { ...driver, runHost: agent => trackIdleWork(driver.runHost(agent)),
    runPlugin: (agent, pluginId) => trackIdleWork(driver.runPlugin(agent, pluginId)) };
}

export function configureAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun = () => true) {
  return lifecycle.configureAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

export function startAgentLifecycle(db: Db, driver: lifecycle.LifecycleDriver, canRun: () => boolean) {
  return lifecycle.startAgentLifecycle(db, createAgentLifecycleEffects(), trackedDriver(driver), canRun);
}

export function terminateCompanyAgents(db: Db, companyId: string) {
  return lifecycle.terminateCompanyAgents(db, createAgentLifecycleEffects(), companyId);
}
