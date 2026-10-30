import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { notifyUnsafeWorkspaceExportRecovery } from "./unsafe-workspace-export-notifications.js";
import { notifyCancelledWorkspacePreservation } from "./cancelled-workspace-preservation-notifications.js";
import { notifyInstructionCollection } from "./instruction-collection-notifications.js";
import { notifyDirectoryCleanup } from "./directory-cleanup-notifications.js";
import { notifyInstructionCommit } from "./instruction-commit-notifications.js";
import { notifyScheduledRetryCancellation } from "./scheduled-retry-cancellation-notifications.js";
import { and, eq, or, sql } from "drizzle-orm";
import { agents, agentApiKeys, agentRuntimeState, agentTaskSessions, agentWakeupRequests, activityLog,
  budgetReservations, heartbeatRunEvents, heartbeatRuns, issueExecutionDecisions, issues, issueComments,
  caseHandoffs, principalPermissionGrants, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

export async function deleteAgentDependencies(tx: Db, companyId: string, id: string) {
  const [retainedHandoff] = await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, companyId), or(eq(caseHandoffs.fromAgentId, id), eq(caseHandoffs.toAgentId, id)),
  )).limit(1);
  if (retainedHandoff) throw conflict("Saved case handoff history requires this agent record. Keep the agent terminated instead of permanently deleting it", {
    code: "agent_case_history_retained",
  });
  const [decisionHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
    eq(budgetReservations.companyId, companyId), eq(budgetReservations.agentId, id),
    eq(budgetReservations.state, "held"), sql`${budgetReservations.decisionInvocationId} is not null`,
  )).limit(1);
  if (decisionHold) throw conflict("Wait for active decisions or resolve their unknown charges in Costs before deleting this agent", {
    code: "agent_decision_accounting_pending",
  });
  const [classifierHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
    eq(budgetReservations.companyId, companyId), eq(budgetReservations.agentId, id),
    eq(budgetReservations.state, "held"), sql`${budgetReservations.promptInjectionInvocationId} is not null`,
  )).limit(1);
  if (classifierHold) throw conflict("Wait for active prompt injection checks or resolve their unknown charges in Costs before deleting this agent", {
    code: "agent_prompt_injection_accounting_pending",
  });
  await notifyExternalConversationSettlement(tx, { companyId });
  await issueThreadInteractionService(tx).cancelPendingForDeletedAddressee(companyId, id);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
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
  await notifyScheduledRetryCancellation(tx, { companyId: companyId });
  await notifyInstructionCommit(tx, { companyId: companyId });
  await notifyDirectoryCleanup(tx, { companyId: companyId });
  await notifyInstructionCollection(tx, { companyId: companyId });
  await notifyCancelledWorkspacePreservation(tx, { companyId: companyId });
  await notifyUnsafeWorkspaceExportRecovery(tx, { companyId });
  await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
  await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
  await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
  await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
  await tx.delete(principalPermissionGrants).where(and(
    eq(principalPermissionGrants.companyId, companyId),
    eq(principalPermissionGrants.principalType, "agent"),
    eq(principalPermissionGrants.principalId, id),
  ));
}
