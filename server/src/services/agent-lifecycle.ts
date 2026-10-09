import type { Db } from "@paperclipai/db";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, deliverBudgetEnforcement, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent, initializePrimaryAgent } from "./primary-agent.js";
import { agentIdentityService } from "./agent-identity.js";
import { deleteAgentDependencies } from "./agent-deletion.js";
import { agentConfigurationService } from "./agent-configuration.js";
import { assertClaudeOAuthBindingInvariant, secretService } from "./secrets.js";
import { agentCredentialService } from "./agent-credentials.js";
import { trackIdleWork } from "./task-admission.js";

export { scheduleAgentLifecycle } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function createAgentLifecycleEffects(hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    transaction: withAccountingTransaction,
    deleteDependencies: deleteAgentDependencies,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId, isActive) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive, windowKind: "calendar_month_utc",
      }, userId),
    enforceBudget: (db, companyId) => deliverBudgetEnforcement(db, hooks, companyId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    initializePrimary: initializePrimaryAgent,
    ensureIdentity: (db, companyId, agentId) => agentIdentityService(db).ensureAgentIdentity(companyId, agentId),
    updateConfiguration: (db, id, data, options, publications) => agentConfigurationService(db, hooks).update(id, data, options, publications),
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
