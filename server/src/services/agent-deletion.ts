import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agents, agentApiKeys, agentRuntimeState, agentTaskSessions, agentWakeupRequests, activityLog,
  budgetReservations, heartbeatRunEvents, heartbeatRuns, issueExecutionDecisions, issues, issueComments,
  principalPermissionGrants, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { agentRecordQueries } from "../lib/agent-records.js";
import { readBuiltInAgentMarker } from "../lib/built-in-agent-metadata.js";
import { assertAgentPurgeAllowed } from "../modules/agent-lifecycle/index.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

export async function deleteAgent(db: Db, id: string) {
  const { getById, normalizeAgentRow } = agentRecordQueries(db);
  const existing = await getById(id);
  if (!existing) return null;
  const builtInMarker = readBuiltInAgentMarker(existing.metadata);
  if (builtInMarker) {
    throw conflict("Built-in agents cannot be deleted; pause them instead", {
      code: "built_in_agent_undeletable",
      key: builtInMarker.key,
      featureKeys: builtInMarker.featureKeys,
    });
  }

  return withAccountingTransaction(db, existing.companyId, async (tx) => {
    const [decisionHold] = await tx.select({ id: budgetReservations.id }).from(budgetReservations).where(and(
      eq(budgetReservations.companyId, existing.companyId), eq(budgetReservations.agentId, id),
      eq(budgetReservations.state, "held"), sql`${budgetReservations.decisionInvocationId} is not null`,
    )).limit(1);
    if (decisionHold) throw conflict("Wait for active decisions or resolve their unknown charges in Costs before deleting this agent", {
      code: "agent_decision_accounting_pending",
    });
    const [current] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
    if (!current) return null;
    assertAgentPurgeAllowed(current);
    await issueThreadInteractionService(tx).cancelPendingForDeletedAddressee(existing.companyId, id);
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
      eq(principalPermissionGrants.companyId, existing.companyId),
      eq(principalPermissionGrants.principalType, "agent"),
      eq(principalPermissionGrants.principalId, id),
    ));
    const deleted = await tx
      .delete(agents)
      .where(and(eq(agents.id, id), inArray(agents.lifecycleState, ["terminated", "rejected"])))
      .returning()
      .then((rows) => rows[0] ?? null);
    return deleted ? normalizeAgentRow(deleted) : null;
  });

}
