import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agents, agentApiKeys, agentRuntimeState, agentTaskSessions, agentWakeupRequests, activityLog, approvals,
  budgetIncidents, budgetPolicies, budgetReservations, heartbeatRunEvents, heartbeatRuns, issueExecutionDecisions, issues, issueComments,
  principalPermissionGrants, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { resolvableApprovalStatuses } from "../lib/approval-records.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

export async function deleteAgentDependencies(tx: Db, companyId: string, id: string) {
  const [decisionHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
    eq(budgetReservations.companyId, companyId), eq(budgetReservations.agentId, id),
    eq(budgetReservations.state, "held"), sql`${budgetReservations.decisionInvocationId} is not null`,
  )).limit(1);
  if (decisionHold) throw conflict("Wait for active decisions or resolve their unknown charges in Costs before deleting this agent", {
    code: "agent_decision_accounting_pending",
  });
  await issueThreadInteractionService(tx).cancelPendingForDeletedAddressee(companyId, id);
  await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
  await tx
    .update(issues)
    .set({ assigneeAgentId: null, createdByAgentId: null })
    .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
  await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
  await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
  await tx.delete(activityLog).where(
    or(
      eq(activityLog.agentId, id),
      sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
    ),
  );
  await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
  await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
  await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
  await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
  await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
  await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
  await tx.delete(principalPermissionGrants).where(and(
    eq(principalPermissionGrants.companyId, companyId),
    eq(principalPermissionGrants.principalType, "agent"),
    eq(principalPermissionGrants.principalId, id),
  ));
  // Budget policies and incidents carry the agent id as an unkeyed scope
  // reference; leaving them behind orphans the rows and breaks the budget
  // overview for the whole company. See #3060.
  const incidentApprovals = await tx
    .select({ approvalId: budgetIncidents.approvalId })
    .from(budgetIncidents)
    .where(and(
      eq(budgetIncidents.companyId, companyId),
      eq(budgetIncidents.scopeType, "agent"),
      eq(budgetIncidents.scopeId, id),
    ));
  const approvalIds = incidentApprovals
    .map((row) => row.approvalId)
    .filter((value): value is string => Boolean(value));
  if (approvalIds.length > 0) {
    const now = new Date();
    await tx
      .update(approvals)
      .set({ status: "cancelled", decidedAt: now, updatedAt: now })
      .where(and(
        inArray(approvals.id, approvalIds),
        inArray(approvals.status, resolvableApprovalStatuses),
      ));
  }
  await tx.delete(budgetIncidents).where(and(
    eq(budgetIncidents.companyId, companyId),
    eq(budgetIncidents.scopeType, "agent"),
    eq(budgetIncidents.scopeId, id),
  ));
  await tx.delete(budgetPolicies).where(and(
    eq(budgetPolicies.companyId, companyId),
    eq(budgetPolicies.scopeType, "agent"),
    eq(budgetPolicies.scopeId, id),
  ));
}
