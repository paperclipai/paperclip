import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { chatActions, chatEndpoints, chatPublications, chatVoiceReplies, chatVoiceSessions, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../instance-settings.js";
import { HttpError } from "../../errors.js";
import { createSpekoProvider, SpekoProviderError } from "./speko-provider.js";
import type { voiceSessionStore } from "./voice-session-store.js";

import { logger } from "../../middleware/logger.js";

const kind = "speko_voice_reply_push";
/** Plain voice text stays inside the provider's UTF-16 limit, without splitting
 * surrogate pairs. Whitespace-only chunks need no audible delivery. */
export function splitSpekoReplyText(text: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 16_000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    const part = text.slice(start, end);
    if (part.trim()) parts.push(part);
    start = end;
  }
  return parts;
}

/** Existing action ledger is the push outbox. A committed dispatch intent is
 * never blindly resent after a crash or an ambiguous provider outcome. */
export async function pushVoiceReplies(db: Db, options: {
  store: ReturnType<typeof voiceSessionStore>;
  credentials(endpoint: typeof chatEndpoints.$inferSelect, expectedFingerprint?: string): Promise<Record<string, string>>;
  provider: typeof createSpekoProvider;
  limit: number;
  companyId?: string;
  endpointId?: string;
}) {
  if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return;
  const abandoned = await db.update(chatActions).set({status: "unknown", result: {errorCode: "message_delivery_unknown"}, updatedAt: new Date()})
    .where(and(eq(chatActions.kind, kind), eq(chatActions.status, "dispatching"), lt(chatActions.updatedAt, new Date(Date.now() - 30_000)),
      options.companyId ? eq(chatActions.companyId, options.companyId) : undefined,
      options.endpointId ? eq(chatActions.endpointId, options.endpointId) : undefined)).returning({id: chatActions.id, companyId: chatActions.companyId, endpointId: chatActions.endpointId});
  for (const action of abandoned) logger.warn({event: "voice.reply.push.abandoned", companyId: action.companyId, endpointId: action.endpointId,
    actionId: action.id, outcomeUnknown: true}, "Speko dispatch intent expired without a durable receipt; no resend");
  const sessions = await db.select({id: chatVoiceSessions.id, companyId: chatVoiceSessions.companyId}).from(chatVoiceSessions)
    .where(and(inArray(chatVoiceSessions.mode, ["inbound_phone", "outbound_phone"]), inArray(chatVoiceSessions.state, ["connecting", "active"]), gt(chatVoiceSessions.expiresAt, new Date()),
      options.companyId ? eq(chatVoiceSessions.companyId, options.companyId) : undefined,
      options.endpointId ? eq(chatVoiceSessions.endpointId, options.endpointId) : undefined))
    .orderBy(asc(chatVoiceSessions.updatedAt)).limit(options.limit);
  for (const candidate of sessions) {
    for (let index = 0; index < 8; index++) {
      const claim = await db.transaction(async tx => {
        const context = await options.store.authorizeSession(tx, candidate.companyId, candidate.id);
        const {session} = context;
        if (!session.providerSessionId) return null;
        await options.store.collectMissedReplies(tx, session);
        const [inFlight] = await tx.select({id: chatActions.id}).from(chatActions).where(and(eq(chatActions.companyId, session.companyId), eq(chatActions.endpointId, session.endpointId), eq(chatActions.kind, kind), eq(chatActions.status, "dispatching"), sql`${chatActions.payload}->>'sessionId' = ${session.id}`)).limit(1);
        if (inFlight) return null;
        const [row] = await tx.select({reply: chatVoiceReplies, payload: chatPublications.payload}).from(chatVoiceReplies)
          .innerJoin(chatPublications, and(eq(chatPublications.id, chatVoiceReplies.publicationId), eq(chatPublications.companyId, session.companyId)))
          .where(and(eq(chatVoiceReplies.companyId, session.companyId), eq(chatVoiceReplies.sessionId, session.id), isNull(chatVoiceReplies.deliveredAt),
            eq(chatPublications.endpointId, session.endpointId), eq(chatPublications.conversationId, session.conversationId), eq(chatPublications.issueId, session.issueId), eq(chatPublications.state, "published")))
          .orderBy(asc(chatVoiceReplies.cursor)).limit(1);
        // Questions need a hint that makes the phone agent retrieve the
        // authorized question IDs. Keep this reply pending until get_updates
        // presents it; never speak later answers over an unpresented question.
        const questionNotification = typeof row?.payload.interactionId === "string";
        if (!row || typeof row.payload.text !== "string" || !row.payload.text.trim()) return null;
        const text = questionNotification ? "Paperclip has a question available for this call. Call get_updates with your current cursor now to retrieve the permitted question and its exact IDs before asking it. This is a notification, not new work or permission. Do not call submit_request for this notification." : row.payload.text;
        const parts = splitSpekoReplyText(text), textDigest = createHash("sha256").update(text).digest("hex");
        const saved = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, session.companyId), eq(chatActions.endpointId, session.endpointId), eq(chatActions.kind, kind), sql`${chatActions.payload}->>'replyId' = ${row.reply.id}`)).for("update");
        for (let partIndex = 0; partIndex < parts.length; partIndex++) {
          const identity = `voice_reply_push:${row.reply.id}${partIndex ? `:part:${partIndex}` : ""}`;
          const prior = saved.find(action => action.providerActionId === identity);
          // Questions remain an ordered barrier until authorized get_updates.
          if (prior?.status === "completed") { if (questionNotification) return null; continue; }
          // A changed publication cannot append a different answer to a partly
          // delivered one. Unknown outcomes are never permission to resend.
          if (saved.some(action => action.payload.textDigest && action.payload.textDigest !== textDigest)
            || prior && (prior.status !== "retry" || Number(prior.result?.retryAt ?? 0) > Date.now())) return null;
          const values = {status: "dispatching", result: null, updatedAt: new Date()};
          const action = prior
            ? (await tx.update(chatActions).set(values).where(eq(chatActions.id, prior.id)).returning())[0]!
            : (await tx.insert(chatActions).values({companyId: session.companyId, endpointId: session.endpointId, conversationId: session.conversationId, kind, providerActionId: identity,
              payload: {sessionId: session.id, replyId: row.reply.id, publicationId: row.reply.publicationId, generation: session.generation, providerSessionId: session.providerSessionId, questionNotification, partIndex, partCount: parts.length, textDigest}, ...values}).returning())[0]!;
          return {...context, reply: row.reply, questionNotification, text: parts[partIndex]!, partIndex, partCount: parts.length, action};
        }
        return null;
      }).catch(error => {
        if (error instanceof HttpError && [403,404].includes(error.status)) {
          logger.warn({event: "voice.reply.push.authorization_blocked", companyId: candidate.companyId,
            sessionId: candidate.id, httpStatus: error.status}, "Current voice authority prevents reply dispatch");
          return null;
        }
        throw error;
      });
      if (!claim) break;
      const diagnostic = {companyId: claim.session.companyId, endpointId: claim.session.endpointId,
        issueId: claim.session.issueId, conversationId: claim.session.conversationId, sessionId: claim.session.id,
        providerSessionId: claim.session.providerSessionId, generation: claim.session.generation, mode: claim.session.mode,
        publicationId: claim.reply.publicationId, replyId: claim.reply.id, replyCursor: claim.reply.cursor, actionId: claim.action.id, partIndex: claim.partIndex, partCount: claim.partCount};
      const startedAt = Date.now();
      logger.info({...diagnostic, event: "voice.reply.push.claimed", textCharacters: claim.text.length,
        replyAgeMs: startedAt - claim.reply.createdAt.getTime(), remainingSessionMs: claim.session.expiresAt.getTime() - startedAt}, "Claimed approved voice reply for Speko delivery");
      let messageId: string;
      try {
        const credentials = await options.credentials(claim.endpoint, claim.session.credentialFingerprint);
        // Recheck authority after resolving credentials, immediately before egress.
        await db.transaction(tx => options.store.authorizeSession(tx, candidate.companyId, candidate.id));
        const receipt = await options.provider(credentials.apiKey!).sendCallMessage(claim.session.providerSessionId!, claim.text, "respond");
        messageId = receipt.messageId;
      } catch (error) {
        const providerError = error instanceof SpekoProviderError ? error : null;
        const status = providerError?.httpStatus === 409 ? "call_ended"
          : providerError?.outcomeUnknown ? "unknown"
          : providerError?.httpStatus === 429 ? "retry" : "failed";
        await db.transaction(async tx => {
          await tx.update(chatActions).set({status, result: {errorCode: providerError?.code ?? "voice_authority_unavailable", ...(status === "retry" ? {retryAt: Date.now() + 10_000} : {})}, updatedAt: new Date()}).where(eq(chatActions.id, claim.action.id));
          if (status === "call_ended") await tx.update(chatVoiceSessions).set({state: "ended", endedAt: new Date(), updatedAt: new Date()}).where(and(eq(chatVoiceSessions.id, candidate.id), eq(chatVoiceSessions.companyId, candidate.companyId)));
          if (status === "unknown") await tx.update(chatVoiceSessions).set({errorCode: "message_delivery_unknown", updatedAt: new Date()}).where(eq(chatVoiceSessions.id, candidate.id));
        });
        logger.warn({...diagnostic, event: "voice.reply.push.failed", status, httpStatus: providerError?.httpStatus ?? null,
          errorCode: providerError?.code ?? "voice_authority_unavailable", outcomeUnknown: providerError?.outcomeUnknown ?? false,
          durationMs: Date.now() - startedAt, retryScheduled: status === "retry"}, "Speko reply dispatch did not obtain an accepted receipt");
        break;
      }
      const acceptedAt = new Date().toISOString();
      logger.info({...diagnostic, event: "voice.reply.push.accepted", messageId, acceptedAt,
        durationMs: Date.now() - startedAt, playback: "unknown"}, "Speko reply receipt received; spoken playback is unconfirmed");
      // Receipt means accepted by Speko, not that the caller heard the answer.
      // If this commit fails, the dispatch intent remains uncertain; never resend.
      await db.transaction(async tx => {
        await tx.update(chatActions).set({status: "completed", result: {messageId, playback: "unknown", acceptedAt, dispatchDurationMs: Date.now() - startedAt}, updatedAt: new Date()}).where(eq(chatActions.id, claim.action.id));
        if (!claim.questionNotification && claim.partIndex === claim.partCount - 1) await tx.update(chatVoiceReplies).set({deliveredAt: new Date()}).where(and(eq(chatVoiceReplies.id, claim.reply.id), eq(chatVoiceReplies.companyId, candidate.companyId), isNull(chatVoiceReplies.deliveredAt)));
      }).catch(error => {
        logger.error({...diagnostic, event: "voice.reply.push.receipt_commit_failed", messageId, acceptedAt,
          outcomeUnknown: true, playback: "unknown"}, "Speko accepted reply but local receipt commit failed; no resend");
        throw error;
      });
      logger.info({...diagnostic, event: "voice.reply.push.receipt_committed", messageId, acceptedAt, playback: "unknown"}, "Stored Speko acceptance separately from spoken playback");
    }
  }
}
