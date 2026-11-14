import { and, desc, eq, lt, sql, type SQLWrapper } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { publicNativeChatProgressText } from "../../safe-native-chat-progress.js";
import { createRunSecretRedactionRegistry } from "../../run-secret-redaction.js";
import type { NativeProgressPolicy } from "../../chat-native-progress-policy.js";
import { CONTEXTUAL_FAST_RESPONSE_ACKNOWLEDGEMENT } from "../progress-reasons.js";

export function publicProgressEvent(event: { eventType: SQLWrapper; payload: SQLWrapper; runId: SQLWrapper }) {
  return sql<boolean>`coalesce((${event.eventType} = 'item.completed'
    and ${event.payload}->'prpEvent'->>'schema' = 'paperclip.prp.event.v1'
    and ${event.payload}->'prpEvent'->>'eventType' = 'item.completed'
    and ${event.payload}->'prpEvent'->>'runId' = ${event.runId}::text
    and ${event.payload}->'prpEvent'->'payload'->>'kind' = 'agentMessage'
    and ${event.payload}->'prpEvent'->'payload'->>'channel' = 'progress'
    and jsonb_typeof(${event.payload}->'prpEvent'->'payload'->'text') = 'string'), false)`;
}

async function latestPublicProgress(db: Pick<Db, "select">, scope: { companyId: string; runId: string }, signal?: AbortSignal) {
  const redact = await createRunSecretRedactionRegistry(db as Db).redactorForRun(scope.companyId, scope.runId);
  let beforeSeq: number | undefined;
  for (;;) {
    signal?.throwIfAborted();
    const events = await db.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.runId),
        publicProgressEvent(heartbeatRunEvents), beforeSeq === undefined ? undefined : lt(heartbeatRunEvents.seq, beforeSeq)))
      .orderBy(desc(heartbeatRunEvents.seq)).limit(50);
    for (const event of events) {
      const text = publicNativeChatProgressText("item.completed", redact(event.payload), scope.runId);
      if (text) return { seq: event.seq, text };
    }
    if (events.length < 50) return null;
    beforeSeq = events[events.length - 1].seq;
  }
}

export const slackNativeProgressPolicy = {
  latestPublicNote: latestPublicProgress,
  additionalBaseEligibility: (base: { state: SQLWrapper; redactedError: SQLWrapper }) =>
    and(eq(base.state, "cancelled"), eq(base.redactedError, CONTEXTUAL_FAST_RESPONSE_ACKNOWLEDGEMENT)),
  acceptsBase: (base, hasPublicNote) => ["pending", "retry", "streaming", "published"].includes(base.state) ||
    (hasPublicNote && base.state === "cancelled" && base.redactedError === CONTEXTUAL_FAST_RESPONSE_ACKNOWLEDGEMENT),
  nextDelivery: ({ base, previous, now }) => {
    if (previous.some(row => ["pending", "retry", "streaming", "delivery_unknown"].includes(row.state)) ||
      !["published", "cancelled"].includes(base.state)) return { ready: false };
    const lastProgressAt = Math.max(base.createdAt.getTime(), ...previous.map(row =>
      Math.max(row.createdAt.getTime(), row.publishedAt?.getTime() ?? 0)));
    const dueAt = previous.length ? lastProgressAt + 30_000 : base.createdAt.getTime() + 10_000;
    return now < dueAt ? { ready: false, dueAt } : { ready: true };
  },
} satisfies NativeProgressPolicy & { additionalBaseEligibility: (base: { state: SQLWrapper; redactedError: SQLWrapper }) => SQLWrapper | undefined };
