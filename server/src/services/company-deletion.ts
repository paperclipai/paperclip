import type { Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { createAgentLifecycle, scheduleAgentLifecycle } from "./agent-lifecycle.js";
import { assertAgentPurgeAllowed } from "../modules/agent-lifecycle/index.js";
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
    await scheduleAgentLifecycle(db, agent.id);
  }
  return db.transaction(async (tx) => {
        // Exclude accounting writers before taking child locks. KEY SHARE must
        // remain compatible: native writers can already hold a child row while
        // saving a company-scoped result. FOR UPDATE would deadlock that save.
        const [existing] = await tx.select({ id: companies.id }).from(companies)
          .where(eq(companies.id, id)).for("no key update");
        if (!existing) return null;
        const terminalAgents = await tx.select({ lifecycleState: agents.lifecycleState }).from(agents)
          .where(eq(agents.companyId, id)).for("update");
        for (const agent of terminalAgents) assertAgentPurgeAllowed(agent);
        // Finance can reference costs and both can reference runs. Incidents
        // reference policies and approvals; delete these dependents first.
        await tx.delete(financeEvents).where(eq(financeEvents.companyId, id));
        await tx.delete(decisionInvocations).where(eq(decisionInvocations.companyId, id));
        await tx.delete(costEvents).where(eq(costEvents.companyId, id));
        await tx.delete(budgetIncidents).where(eq(budgetIncidents.companyId, id));
        await tx.delete(budgetPolicies).where(eq(budgetPolicies.companyId, id));
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
        await tx.delete(issueComments).where(eq(issueComments.companyId, id));
        await tx.delete(approvalComments).where(eq(approvalComments.companyId, id));
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
        await tx.delete(projects).where(eq(projects.companyId, id));
        await tx.delete(agents).where(and(eq(agents.companyId, id), inArray(agents.lifecycleState, ["terminated", "rejected"])));
        const rows = await tx
          .delete(companies)
          .where(eq(companies.id, id))
          .returning();
        return rows[0] ?? null;
      });
}
