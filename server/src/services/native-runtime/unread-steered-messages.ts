import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { unreadSteeredMessageIds } from "../../vendor/paperclip-runner/index.js";
import { queuedInteractionSteeringBody } from "../queued-interaction-response.js";

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/**
 * Steered messages a restart lost before the model read them, oldest first.
 * The run log is the durable record of both facts: the provider's steering
 * acknowledgement and the userMessage item or completed turn that shows the
 * model read it. Only events the native transport validated count.
 */
export async function readUnreadSteeredMessages(
  db: Db,
  input: { companyId: string; runId: string; issueId: string },
): Promise<Array<{ id: string; text: string }>> {
  const rows = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      turnId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId'`,
      itemId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId'`,
      kind,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId),
      isNotNull(heartbeatRunEvents.sourceEventId),
      or(
        eq(heartbeatRunEvents.eventType, "turn.completed"),
        and(eq(heartbeatRunEvents.eventType, "item.completed"), sql`${kind} = 'steering_acknowledgement'`),
        and(eq(heartbeatRunEvents.eventType, "item.started"), sql`${kind} = 'userMessage'`),
      ),
    ))
    .orderBy(asc(heartbeatRunEvents.seq));
  const ids = unreadSteeredMessageIds(rows);
  if (ids.length === 0) return [];
  const uuids = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (uuids.length === 0) return [];
  const texts = new Map<string, string>();
  const comments = await db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, uuids),
    ));
  for (const comment of comments) texts.set(comment.id, comment.body);
  const remaining = uuids.filter((id) => !texts.has(id));
  if (remaining.length > 0) {
    // A steered interaction response uses the interaction id.
    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        inArray(issueThreadInteractions.id, remaining),
      ));
    for (const interaction of interactions) texts.set(interaction.id, queuedInteractionSteeringBody(interaction));
  }
  return ids.flatMap((id) => {
    const text = texts.get(id);
    return text === undefined ? [] : [{ id, text }];
  });
}
