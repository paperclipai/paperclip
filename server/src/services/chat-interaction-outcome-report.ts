import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { heartbeatRunEvents, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";

/** Run event: the conversation agent read a declined tool action after the person declined it. */
export const DECLINED_INTERACTION_READ_EVENT = "chat_interaction.declined_read";
const MAX_INTERACTIONS = 20;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Connection = Db | Tx;
type InteractionRow = { id: string; kind: string; status: string; payload: unknown; resolvedAt?: Date | null };

/** A declined tool action is a pure outcome: its continuation only tells the person, with no
 * input to act on. Answers, plan reviews and accepted actions always keep their own turn. */
function declinedToolAction(row: InteractionRow) {
  const payload = row.payload && typeof row.payload === "object" ? row.payload as Record<string, unknown> : {};
  return row.kind === "request_confirmation" && row.status === "rejected" && !!payload.toolAction;
}

/** Records the declined tool actions the conversation agent read in its own conversation. The
 * decline continuation uses this to recognize a decline that an earlier reply reported. */
export async function recordDeclinedInteractionRead(db: Db, input: {
  companyId: string; agentId: string; runId: string;
  issue: { id: string; companyId: string; conversationAgentId?: string | null };
  interactions: InteractionRow[];
}) {
  if (input.issue.companyId !== input.companyId || input.issue.conversationAgentId !== input.agentId) return;
  // Record every decline the run was shown; a later decline must never lose its receipt.
  const declined = input.interactions.filter(declinedToolAction);
  if (declined.length === 0) return;
  const recorded = await db.select({ interactionId: sql<string>`${heartbeatRunEvents.payload}->>'interactionId'` })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
      eq(heartbeatRunEvents.eventType, DECLINED_INTERACTION_READ_EVENT)));
  const seen = new Set(recorded.map(row => row.interactionId));
  for (const row of declined) {
    if (seen.has(row.id)) continue;
    await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId: input.agentId,
      eventType: DECLINED_INTERACTION_READ_EVENT, stream: "system", level: "info",
      payload: { issueId: input.issue.id, interactionId: row.id, status: row.status } });
  }
}

function wakeInteractionIds(payload: Record<string, unknown>) {
  const values = Array.isArray(payload.interactionIds) ? payload.interactionIds : [payload.interactionId];
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

/** Returns the earlier reply that already reported every declined tool action this wake would
 * report, or null. Same rule as completions: the same agent replied in this conversation after
 * the decline, from a run that read the action declined before posting that reply. */
export async function earlierDeclinedOutcomeReply(tx: Connection, input: {
  companyId: string; issueId: string; agentId: string; payload: Record<string, unknown>;
}): Promise<string | null> {
  if (input.payload.mutation !== "interaction") return null;
  const interactionIds = wakeInteractionIds(input.payload);
  if (interactionIds.length === 0 || interactionIds.length > MAX_INTERACTIONS) return null;
  // A tool-action batch lists at most eight outcomes inline; when more were recorded, the
  // omitted ones may be unreported, so the wake must keep its turn.
  const outcomeCount = input.payload.toolActionOutcomeCount;
  if (typeof outcomeCount === "number" && outcomeCount > interactionIds.length) return null;
  const [conversation] = await tx.select({ conversationAgentId: issues.conversationAgentId }).from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (conversation?.conversationAgentId !== input.agentId) return null;
  const rows = await tx.select({ id: issueThreadInteractions.id, kind: issueThreadInteractions.kind, status: issueThreadInteractions.status,
    payload: issueThreadInteractions.payload, resolvedAt: issueThreadInteractions.resolvedAt })
    .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId), inArray(issueThreadInteractions.id, interactionIds)));
  if (rows.length !== interactionIds.length || !rows.every(row => declinedToolAction(row) && row.resolvedAt)) return null;
  let reply: string | null = null;
  for (const row of rows) {
    const resolvedAt = row.resolvedAt!;
    const readDecline = sql`exists (select 1 from ${heartbeatRunEvents} declined_read
      where declined_read.company_id = ${input.companyId} and declined_read.run_id = ${issueComments.createdByRunId}
        and declined_read.event_type = ${DECLINED_INTERACTION_READ_EVENT} and declined_read.payload->>'interactionId' = ${row.id}
        and declined_read.created_at >= ${resolvedAt.toISOString()}::timestamptz and declined_read.created_at <= ${issueComments.createdAt})`;
    const [earlier] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorAgentId, input.agentId), isNull(issueComments.deletedAt), isNotNull(issueComments.createdByRunId),
      gte(issueComments.createdAt, resolvedAt), readDecline,
    )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)).limit(1);
    if (!earlier) return null;
    reply ??= earlier.id;
  }
  return reply;
}
