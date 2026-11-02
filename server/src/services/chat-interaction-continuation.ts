import { agentWakeupRequests, connectionIntentDeliveries, issueThreadInteractions, type Db } from "@paperclipai/db";
import { and, eq, ne, or, inArray, sql } from "drizzle-orm";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

// Item reviews may resume after a partial decision. Their existing wake key is
// windowed, so an interaction/status key cannot prove this continuation. Match
// the server-owned wake to saved decisions before following its source run.
export async function resolveItemVerdictContinuationWake(db: Db, input: {
  companyId: string; issueId: string; interactionId: string; sourceRunId: string;
  runId: string; agentId: string; result: unknown;
}): Promise<{ id: string } | null> {
  const result = record(input.result);
  if (result.outcome !== "resolved" || !Array.isArray(result.items)) return null;
  const savedIds = new Set(result.items.map(item => record(item).id));
  const prefix = `request_item_verdicts:${input.issueId}:${input.interactionId}:`;
  const wakes = await db.select({ id: agentWakeupRequests.id,
    key: agentWakeupRequests.idempotencyKey, payload: agentWakeupRequests.payload,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.runId, input.runId),
    eq(agentWakeupRequests.source, "automation"),
    eq(agentWakeupRequests.reason, "issue_commented"),
    ne(agentWakeupRequests.status, "skipped"),
  ));
  return wakes.find(wake => {
    const payload = record(wake.payload);
    const ids = payload.newlyResolvedItemIds;
    return wake.key?.startsWith(prefix) && /^\d+$/.test(wake.key.slice(prefix.length)) &&
      payload.issueId === input.issueId && payload.interactionId === input.interactionId &&
      payload.sourceRunId === input.sourceRunId && payload.interactionKind === "request_item_verdicts" &&
      payload.mutation === "interaction" && Array.isArray(ids) && ids.length > 0 &&
      ids.every(id => typeof id === "string" && savedIds.has(id));
  }) ?? null;
}

export async function resolveConnectionIntentContinuationSource(db: Db, input: {
  companyId: string; issueId: string; interactionId: string; runId: string; agentId: string;
}): Promise<string | null> {
  const [receipt] = await db.select({ sourceRunId: issueThreadInteractions.sourceRunId })
    .from(issueThreadInteractions)
    .innerJoin(connectionIntentDeliveries, and(
      eq(connectionIntentDeliveries.companyId, issueThreadInteractions.companyId),
      eq(connectionIntentDeliveries.interactionId, issueThreadInteractions.id),
    ))
    .innerJoin(agentWakeupRequests, and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.runId, input.runId),
      eq(agentWakeupRequests.source, "automation"),
      eq(agentWakeupRequests.reason, "issue_commented"),
      ne(agentWakeupRequests.status, "skipped"),
      sql`${agentWakeupRequests.idempotencyKey} = 'connection-intent:' || ${issueThreadInteractions.id}::text || ':' || ${issueThreadInteractions.status}`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      sql`${agentWakeupRequests.payload}->>'interactionId' = ${input.interactionId}`,
      sql`${agentWakeupRequests.payload}->>'interactionKind' = 'connection_intent'`,
      sql`${agentWakeupRequests.payload}->>'interactionStatus' = ${issueThreadInteractions.status}`,
    ))
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.id, input.interactionId),
      eq(issueThreadInteractions.kind, "connection_intent"),
      or(inArray(issueThreadInteractions.status, ["accepted", "rejected"]), and(
        eq(issueThreadInteractions.status, "expired"),
        sql`${issueThreadInteractions.result}->>'outcome' = 'expired'`,
        sql`jsonb_typeof(${issueThreadInteractions.result}->'connectionId') = 'string'`,
      )),
    )).limit(1);
  return receipt?.sourceRunId ?? null;
}
