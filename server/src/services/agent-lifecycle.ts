import { notifyMuseContactVerification } from "../modules/external-agents/index.js";
import { notifyBudgetResumeAgentReady } from "./budget-resume-continuation.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { notifyStrandedAgentStatus } from "./live-run-recovery-notifications.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { notifyNativeResponsePresentation } from "./native-response-presentation-notifications.js";
import { notifyChatInboundWakeNotices } from "./chat-inbound-wake-notice-notifications.js";
import { logger } from "../middleware/logger.js";
import { agents, companies, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { persistActivity, type ActivityPublication } from "./activity-log.js";
import * as lifecycle from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { budgetServiceInTransaction, policyBlocks, type BudgetServiceHooks } from "./budgets.js";
import { recordAgentStatusEvent, recordResourceCreationEvent } from "./resource-lifecycle-events.js";
import { clearPrimaryAgent } from "./primary-agent.js";
import { deleteAgentDependencies } from "./agent-deletion.js";
import { lockAgentConfigurationInteractions, prepareAgentConfiguration, completeAgentConfiguration } from "./agent-configuration.js";
import { prepareAgentHire, initializeAgentHire, prepareAgentHireApproval, completeAgentHireApproval } from "./agent-hiring.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { fenceActiveCompanyAgentStopsInTransaction as fenceActiveCompanyStops } from "../modules/agent-lifecycle/index.js";
import { applyAgentPolicyHoldsInTransaction } from "../modules/agent-lifecycle/index.js";
import { trackIdleWork } from "./task-admission.js";
import { environmentService } from "./environments.js";
import { instanceSettingsService } from "./instance-settings.js";
import { pluginEnvironmentRequiresAgent, pluginForAgentEnvironment } from "./plugin-environment-driver.js";
import { isProviderApiSetupDraft } from "./native-runtime/provider-api-placement.js";

export { scheduleAgentLifecycle, processAgentLifecycle } from "../modules/agent-lifecycle/index.js";
export type { LifecycleDriver, LifecycleAgent } from "../modules/agent-lifecycle/index.js";

export function createAgentLifecycleEffects(_hooks: BudgetServiceHooks = {}): lifecycle.LifecycleEffects {
  return {
    async setupRequiresPreparation(db, companyId, environmentId, profile) {
      if (isProviderApiSetupDraft(profile)) return false;
      const id = environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
      const environment = id ? await environmentService(db).getById(id) : null;
      if (!environment || !await pluginEnvironmentRequiresAgent(db, environment)) return false;
      const [company] = await db.select({ requiresApproval: companies.requireBoardApprovalForNewAgents }).from(companies).where(eq(companies.id, companyId));
      if (!company || company.requiresApproval) return false;
      const bound = await environmentService(db).listBoundCompanyIds(environment.id);
      if (bound.length && !bound.includes(companyId)) throw new lifecycle.AgentLifecycleConflict("The environment belongs to another company");
      return true;
    },
    async environmentRequiresNewPlugin(db, environmentId, selectedPluginIds) {
      const id = environmentId ?? (await instanceSettingsService(db).get()).defaultEnvironmentId;
      const environment = id ? await environmentService(db).getById(id) : null;
      const plugin = environment ? await pluginForAgentEnvironment(db, environment) : null;
      return plugin !== null && !selectedPluginIds?.includes(plugin.id);
    },
    notifyWork: tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle),
    leaseHolder: () => currentControllerProcessStamp(),
    beforeConnectionEligibilityRestore: async (tx, companyId, agentId) => {
      await notifyMuseContactVerification(tx, { companyId, agentId });
    },
    async beforeStatusChange(tx, companyId, agentId, before, after) {
      await notifyAttentionRetentionWork(tx, { companyId });
      if (before !== after) {
        await notifyStrandedAgentStatus(tx, { companyId, agentId });
        await notifyRunDispatch(tx, { companyId });
        await notifyDeferredExecutionEligibility(tx, { companyId });
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
      }
      if (!isAgentStatusInvokable(before) && isAgentStatusInvokable(after)) {
        await notifyNativeResponsePresentation(tx, { companyId, agentId });
        await notifyNativeReviewResponse(tx, { companyId, agentId });
        await notifyChatInboundWakeNotices(tx, { companyId });
        await notifyBudgetResumeAgentReady(tx, agentId);
      }
    },
    reportFailure(context, error) {
      const code = lifecycle.lifecycleFailureCode(error);
      logger.warn({ ...context, failureCode: code ?? "unclassified" }, "Agent lifecycle operation failed");
    },
    transaction: withAccountingTransaction,
    deleteDependencies: deleteAgentDependencies,
    policyBlocks,
    setAgentBudget: (db, publications, companyId, agentId, amount, userId, isActive) =>
      budgetServiceInTransaction(db, publications).upsertPolicy(companyId, {
        scopeType: "agent", scopeId: agentId, amount, isActive, windowKind: "calendar_month_utc",
      }, userId),
    recordCreation: (db, companyId, agentId) => recordResourceCreationEvent(db, companyId, "agent", agentId),
    recordStatus: recordAgentStatusEvent,
    clearPrimary: clearPrimaryAgent,
    lockConfigurationInteractions: lockAgentConfigurationInteractions,
    prepareConfiguration: prepareAgentConfiguration,
    completeConfiguration: completeAgentConfiguration,
    prepareHire: prepareAgentHire,
    initializeHire: initializeAgentHire,
    prepareHireApproval: prepareAgentHireApproval,
    completeHireApproval: completeAgentHireApproval,
  };
}

export function createAgentLifecycle(db: Db, hooks: BudgetServiceHooks = {}) {
  return lifecycle.createAgentLifecycle(db, createAgentLifecycleEffects(hooks));
}

export function initializeImportedAgentConfigurationInTransaction(tx: Db, publications: ActivityPublication[],
  id: string, data: Parameters<typeof lifecycle.initializeImportedAgentConfigurationInTransaction>[4]) {
  return lifecycle.initializeImportedAgentConfigurationInTransaction(tx, createAgentLifecycleEffects(), publications, id, data);
}

export function requestAgentHireInTransaction(tx: Db, publications: ActivityPublication[],
  ...args: Parameters<ReturnType<typeof createAgentLifecycle>["requestHire"]>) {
  return lifecycle.requestAgentHireInTransaction(tx, createAgentLifecycleEffects(), publications, ...args);
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

/** Budget evaluation owns the transaction and supplies the aggregate agent decision. */
/** Pass the transaction's post-commit `publications` so the entry reaches live
 * subscribers after commit; without them it publishes nothing until reload. */
export async function applyAgentBudgetHoldInTransaction(tx: Db, companyId: string, agentId: string, blocked: boolean,
  publications?: ActivityPublication[]) {
  const [before] = await tx.select({ holds: agents.lifecycleHolds }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  const updated = await applyAgentPolicyHoldsInTransaction(tx, createAgentLifecycleEffects(), companyId, agentId, { budget: blocked });
  // A budget pause is a governance stop: record it, and its release, with the
  // reason, in the transaction that applies it.
  const had = before?.holds?.includes("budget") ?? false;
  const has = updated?.lifecycleHolds?.includes("budget") ?? had;
  if (updated && had !== has) {
    const { publication } = await persistActivity(tx, { companyId, actorType: "system", actorId: "budget",
      // Releasing the budget hold resumes the agent only when no other hold
      // (a manual or company pause) still keeps it paused.
      agentId, action: has ? "agent.paused" : updated.lifecycleHolds.length === 0 ? "agent.resumed" : "agent.budget_hold_released",
      entityType: "agent", entityId: agentId,
      details: { reason: "budget", lifecycleState: updated.lifecycleState, holds: updated.lifecycleHolds } });
    if (publication) publications?.push(publication);
  }
  return updated;
}

export function fenceActiveCompanyAgentStopsInTransaction(tx: Db, companyId: string, status: "paused" | "archived") {
  return fenceActiveCompanyStops(tx, createAgentLifecycleEffects(), companyId, status);
}
