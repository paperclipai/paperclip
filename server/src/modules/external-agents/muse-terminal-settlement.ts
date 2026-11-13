import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, museAgentBindings as bindings, museRunnerAssignments as assignments,
  museRunnerOperations as operations, externalAgentHolds as holds, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../services/delivery-work-notifications.js";

export type ExternalAgentSettlementScope = { companyId: string; bindingId?: string; runId?: string; issueId?: string };



export function notifyExternalAgentSettlement(tx: object, scope?: ExternalAgentSettlementScope) {


  return notifyDeliveryWork(tx, DELIVERY_QUEUES.museMaintenance, scope ? JSON.stringify({
    companyId: scope.companyId, bindingId: scope.bindingId, runId: scope.runId, issueId: scope.issueId,
  }) : "*");
}



export function pendingMuseTerminalAssignmentCondition() {
  const unknown = sql`exists(select 1 from ${operations} where ${operations.assignmentId} = ${assignments.id}
    and ${operations.status} in ('unknown', 'dispatched', 'pending'))`;
  const unsettledHold = sql`exists(select 1 from ${holds} where ${holds.provider} = 'muse'
    and ${holds.assignmentId} = ${assignments.id} and ${holds.companyId} = ${assignments.companyId}
    and ${holds.agentId} = ${assignments.agentId} and ${holds.releasedAt} is null
    and (${heartbeatRuns.status} <> 'succeeded' or ${unknown} or not ${holds.nativeEffectsUnknown}))`;
  return and(inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
    or(inArray(assignments.status, ["offered", "claimed", "accepted"]),
      and(eq(assignments.status, "settled"), isNotNull(assignments.acceptedResultAt),
        or(sql`${assignments.finalizedAt} is distinct from ${heartbeatRuns.finishedAt}`, unsettledHold))));
}

export function pendingMuseTerminalBindings(db: Pick<Db, "selectDistinct">,
  scope?: ExternalAgentSettlementScope, after?: string) {
  return db.selectDistinct({ id: bindings.id, companyId: bindings.companyId, agentId: bindings.agentId })
    .from(bindings)
    .innerJoin(assignments, and(eq(assignments.bindingId, bindings.id), eq(assignments.bindingGeneration, bindings.generation),
      eq(assignments.companyId, bindings.companyId), eq(assignments.agentId, bindings.agentId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, assignments.runId), eq(heartbeatRuns.companyId, assignments.companyId),
      eq(heartbeatRuns.agentId, assignments.agentId)))
    .where(and(pendingMuseTerminalAssignmentCondition(),
      scope ? eq(bindings.companyId, scope.companyId) : undefined,
      scope?.bindingId ? eq(bindings.id, scope.bindingId) : undefined,
      scope?.runId ? eq(assignments.runId, scope.runId) : undefined,
      scope?.issueId ? eq(heartbeatRuns.nativeIssueId, scope.issueId) : undefined,
      after ? gt(bindings.id, after) : undefined))
    .orderBy(asc(bindings.id)).limit(100);
}
