import { notifyChatCompanyConfiguration } from "./chat-channels/configuration-work-notifications.js";
import { chatCompanyDeletion } from "./chat-channels/company-deletion.js";
import { notifyToolConnectionHealth } from "./tool-connection-health-notifications.js";
import { notifyCompanyRetentionWork } from "./retention-work-notifications.js";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { agentObservabilityService } from "./agent-observability.js";
import { withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import type { Db } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { createAgentLifecycle, processAgentLifecycle } from "./agent-lifecycle.js";
import { requestRestorePointDeletion } from "./git-restore-point-ledger.js";
import { agentLifecycleCompanyDeletion } from "../modules/agent-lifecycle/company-deletion.js";
import {
  companies,
  agents,
  companyLogos,
  assets,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  issues,
  issueComments,
  projects,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  runIdentityContexts,
  heartbeatRunEvents,
  costEvents,
  decisionInvocations,
  financeEvents,
  budgetPolicies,
  budgetIncidents,
  issueReadStates,
  approvalComments,
  approvals,
  activityLog,
  companySecrets,
  joinRequests,
  invites,
  principalPermissionGrants,
  companyMemberships,
  companySkills,
  cases,
  documents,
  routineRuns,
  routineTriggers,
  routineRevisions,
  routines,
} from "@paperclipai/db";

export async function deleteCompany(db: Db, id: string) {
  const lifecycle = createAgentLifecycle(db);
  const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, id));
  for (const agent of companyAgents) {
    await lifecycle.terminateAgent(agent.id);
    await processAgentLifecycle(db, agent.id);
  }
  return withAccountHomeSecretMutationLock(undefined, id, () => db.transaction(async (tx) => {
        // Exclude accounting writers before taking child locks. KEY SHARE must
        // remain compatible: native writers can already hold a child row while
        // saving a company-scoped result. FOR UPDATE would deadlock that save.
        const [existing] = await tx.select({ id: companies.id }).from(companies)
          .where(eq(companies.id, id)).for("no key update");
        if (!existing) return null;
        await notifyChatCompanyConfiguration(tx, id);
        await chatCompanyDeletion.deleteCompanyData(tx, id);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillSourceSync);
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.secretProposalExpiry, id);
        await notifyToolReviewChange(tx, id);
        await agentObservabilityService(tx as unknown as Db).removeForCompanyDeletion(id);
        // Finance can reference costs and both can reference runs. Incidents
        // reference policies and approvals; delete these dependents first.
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx.delete(decisionInvocations).where(eq(decisionInvocations.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
        // Cases retain task and agent references. Their dependent handoffs and
        // access sources cascade here before those task/agent records are removed.
        await tx.delete(cases).where(eq(cases.companyId, id));
        // Delete from child tables in dependency order
        const companyRunIds = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, id));

        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, id));
        if (companyRunIds.length > 0) {
          await tx
            .delete(heartbeatRunEvents)
            .where(inArray(heartbeatRunEvents.runId, companyRunIds.map((run) => run.id)));
        }
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, id));
        await tx.delete(activityLog).where(eq(activityLog.companyId, id));
        await tx.delete(runIdentityContexts).where(eq(runIdentityContexts.companyId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.companyId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, id));
        // Match receipt completion and comment deletion: task before comment.
        await tx.select({ id: issues.id }).from(issues)
          .where(eq(issues.companyId, id)).orderBy(issues.id).for("no key update");
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
        await notifyCompanyRetentionWork(tx, id);
        await tx.delete(approvals).where(eq(approvals.companyId, id));
        await tx.delete(companySecrets).where(eq(companySecrets.companyId, id));
        await tx.delete(joinRequests).where(eq(joinRequests.companyId, id));
        await tx.delete(invites).where(eq(invites.companyId, id));
        await tx.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, id));
        await tx.delete(companyMemberships).where(eq(companyMemberships.companyId, id));
        await tx.delete(companySkills).where(eq(companySkills.companyId, id));
        await tx.delete(routineRuns).where(eq(routineRuns.companyId, id));
        await tx.delete(routineTriggers).where(eq(routineTriggers.companyId, id));
        await tx.delete(routineRevisions).where(eq(routineRevisions.companyId, id));
        await tx.delete(routines).where(eq(routines.companyId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.companyId, id));
        await tx.delete(documents).where(eq(documents.companyId, id));
        await tx.delete(issues).where(eq(issues.companyId, id));
        await tx.delete(companyLogos).where(eq(companyLogos.companyId, id));
        await tx.delete(assets).where(eq(assets.companyId, id));
        await tx.delete(goals).where(eq(goals.companyId, id));
        await requestRestorePointDeletion(tx, { companyId: id });
        await tx.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, id));
        await tx.delete(projects).where(eq(projects.companyId, id));
        await agentLifecycleCompanyDeletion.deleteCompanyData(tx, id);
        await notifyToolConnectionHealth(tx, id);
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      }));
}
