import { agentWakeupRequests, heartbeatRuns, statusDecisions, statusDecisionEffects, type Db } from "@paperclipai/db";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { boundRunIssueIdSql } from "../run-task-binding.js";

/** Recover conversation provenance from a committed continuation, never from
 * provider-supplied source IDs or the mere presence of a chat on the task. */
export async function readNativeContinuationSource(
  db: Pick<Db, "select">,
  binding: { companyId: string; issueId: string; runId: string },
): Promise<string | null> {
  const source = alias(heartbeatRuns, "continuation_source");
  const dispatch = alias(agentWakeupRequests, "continuation_dispatch");
  const sources = await db.select({ runId: source.id }).from(heartbeatRuns)
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.companyId, binding.companyId),
      or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, heartbeatRuns.id)),
      eq(agentWakeupRequests.agentId, heartbeatRuns.agentId),
      eq(agentWakeupRequests.reason, "issue_status_changed"),
      eq(agentWakeupRequests.status, "coalesced"),
      eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${binding.issueId}`,
      sql`${heartbeatRuns.contextSnapshot}->>'nativeStatusWakeIntentId' = ${agentWakeupRequests.id}::text`,
    ))
    .innerJoin(dispatch, and(
      eq(dispatch.companyId, binding.companyId), eq(dispatch.agentId, heartbeatRuns.agentId),
      eq(dispatch.runId, heartbeatRuns.id), eq(dispatch.reason, "issue_status_changed"),
      eq(dispatch.requestedByActorType, "system"),
      sql`${dispatch.requestedByActorId} = 'native-status-wake-dispatch:' || ${agentWakeupRequests.id}::text`,
      eq(dispatch.idempotencyKey, agentWakeupRequests.idempotencyKey),
      inArray(dispatch.status, ["queued", "claimed", "completed", "coalesced"]),
      sql`${dispatch.payload}->>'issueId' = ${binding.issueId}`,
    ))
    .innerJoin(statusDecisionEffects, and(
      eq(statusDecisionEffects.companyId, binding.companyId), eq(statusDecisionEffects.issueId, binding.issueId),
      eq(statusDecisionEffects.effectKind, "enqueue_continuation"),
      eq(statusDecisionEffects.targetType, "agent_wakeup_request"),
      sql`${statusDecisionEffects.targetId} = ${agentWakeupRequests.id}::text`,
      eq(statusDecisionEffects.deliveryState, "delivered"),
      sql`${statusDecisionEffects.payload}->>'continuationKind' = 'same_agent'`,
      sql`${agentWakeupRequests.payload}->>'continuationKind' = 'same_agent'`,
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, statusDecisionEffects.decisionId), eq(statusDecisions.companyId, binding.companyId),
      eq(statusDecisions.issueId, binding.issueId), eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.reasonCode, "live_continuation_registered"),
      sql`${agentWakeupRequests.idempotencyKey} = 'native-status:' || ${statusDecisions.id}::text || ':continuation'`,
      sql`${agentWakeupRequests.payload}->>'nativeDecisionId' = ${statusDecisions.id}::text`,
    ))
    .innerJoin(source, and(
      eq(source.id, statusDecisions.runId), eq(source.companyId, binding.companyId),
      eq(source.nativeIssueId, binding.issueId), eq(source.runtimeMode, "native"),
      eq(source.agentId, heartbeatRuns.agentId), ne(source.id, heartbeatRuns.id),
      sql`${source.responsibleUserId} is not distinct from ${heartbeatRuns.responsibleUserId}`,
    ))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(boundRunIssueIdSql(), binding.issueId)))
    .groupBy(source.id).limit(2);
  return sources.length === 1 ? sources[0]!.runId : null;
}
