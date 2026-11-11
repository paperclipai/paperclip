import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { chatActions, chatPublications, chatVoiceReplies } from "@paperclipai/db";
import type { VoiceSessionRow, VoiceTransaction } from "./voice-session-store.js";
import { planVoiceReply, VOICE_REPLY_ACTION_KIND, VOICE_REPLY_DISPATCH_TIMEOUT_MS } from "./voice-reply-policy.js";

/** Read the ordered delivery barrier under the caller's existing session lock. */
export async function readVoiceReplyState(
  tx: VoiceTransaction,
  session: Pick<VoiceSessionRow, "id" | "companyId" | "endpointId" | "conversationId" | "issueId">,
) {
  const [inFlight] = await tx.select({ updatedAt: chatActions.updatedAt }).from(chatActions)
    .where(and(eq(chatActions.companyId, session.companyId), eq(chatActions.endpointId, session.endpointId),
      eq(chatActions.kind, VOICE_REPLY_ACTION_KIND), eq(chatActions.status, "dispatching"),
      sql`${chatActions.payload}->>'sessionId' = ${session.id}`))
    .orderBy(asc(chatActions.updatedAt)).limit(1);
  if (inFlight) return { kind: "in_flight" as const, retryAt: inFlight.updatedAt.getTime() + VOICE_REPLY_DISPATCH_TIMEOUT_MS + 1 };
  const [row] = await tx.select({ reply: chatVoiceReplies, payload: chatPublications.payload }).from(chatVoiceReplies)
    .innerJoin(chatPublications, and(eq(chatPublications.id, chatVoiceReplies.publicationId), eq(chatPublications.companyId, session.companyId)))
    .where(and(eq(chatVoiceReplies.companyId, session.companyId), eq(chatVoiceReplies.sessionId, session.id), isNull(chatVoiceReplies.deliveredAt),
      eq(chatPublications.endpointId, session.endpointId), eq(chatPublications.conversationId, session.conversationId),
      eq(chatPublications.issueId, session.issueId), eq(chatPublications.state, "published")))
    .orderBy(asc(chatVoiceReplies.cursor)).limit(1);
  if (!row || typeof row.payload.text !== "string" || !row.payload.text.trim()) return { kind: "blocked" as const };
  const questionNotification = typeof row.payload.interactionId === "string";
  const saved = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, session.companyId),
    eq(chatActions.endpointId, session.endpointId), eq(chatActions.kind, VOICE_REPLY_ACTION_KIND),
    sql`${chatActions.payload}->>'replyId' = ${row.reply.id}`)).for("update");
  return { kind: "reply" as const, reply: row.reply, questionNotification,
    plan: planVoiceReply({ replyId: row.reply.id, text: row.payload.text, questionNotification, actions: saved, now: Date.now() }) };
}
