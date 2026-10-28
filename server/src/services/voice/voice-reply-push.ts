import { notifyVoiceInbound } from "./voice-inbound-notifications.js";
import { notifyVoiceReplies } from "./voice-reply-notifications.js";
import { recoverVoiceReplyDispatches } from "./voice-reply-dispatch-recovery.js";
import { notifyVoiceRecovery } from "./voice-recovery-notifications.js";
import { VOICE_REPLY_ACTION_KIND } from "./voice-reply-policy.js";
import { readVoiceReplyState } from "./voice-reply-state.js";
export { splitSpekoReplyText } from "./voice-reply-policy.js";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { chatActions, chatEndpoints, chatVoiceReplies, chatVoiceSessions, type Db } from "@paperclipai/db";
import { instanceSettingsService } from "../instance-settings.js";
import { HttpError } from "../../errors.js";
import { createSpekoProvider, SpekoProviderError } from "./speko-provider.js";
import type { voiceSessionStore } from "./voice-session-store.js";

import { logger } from "../../middleware/logger.js";

const kind = VOICE_REPLY_ACTION_KIND;
/** Existing action ledger is the push outbox. A committed dispatch intent is
 * never blindly resent after a crash or an ambiguous provider outcome. */
export async function pushVoiceReplies(db: Db, options: {
  store: ReturnType<typeof voiceSessionStore>;
  credentials(endpoint: typeof chatEndpoints.$inferSelect, expectedFingerprint?: string): Promise<Record<string, string>>;
  provider: typeof createSpekoProvider;
  limit: number;
  companyId?: string;
  endpointId?: string;
  sessionId?: string;
  recoverDispatches?: boolean;
}) {
  if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return;
  if (options.recoverDispatches !== false) await recoverVoiceReplyDispatches(db, options);
  const sessions = await db.select({id: chatVoiceSessions.id, companyId: chatVoiceSessions.companyId}).from(chatVoiceSessions)
    .where(and(options.sessionId ? eq(chatVoiceSessions.id, options.sessionId) : undefined, inArray(chatVoiceSessions.mode, ["inbound_phone", "outbound_phone"]), inArray(chatVoiceSessions.state, ["connecting", "active"]), gt(chatVoiceSessions.expiresAt, new Date()),
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
        const state = await readVoiceReplyState(tx, session);
        if (state.kind !== "reply" || state.plan.kind !== "dispatch") return null;
        const { reply, questionNotification, plan } = state;
        await notifyVoiceReplies(tx, { kind: "session", id: session.id });
        const values = { status: "dispatching", result: null, updatedAt: new Date() };
        const action = plan.priorActionId
          ? (await tx.update(chatActions).set(values).where(eq(chatActions.id, plan.priorActionId)).returning())[0]!
          : (await tx.insert(chatActions).values({ companyId: session.companyId, endpointId: session.endpointId, conversationId: session.conversationId, kind, providerActionId: plan.identity,
              payload: { sessionId: session.id, replyId: reply.id, publicationId: reply.publicationId, generation: session.generation, providerSessionId: session.providerSessionId,
                questionNotification, partIndex: plan.partIndex, partCount: plan.partCount, textDigest: plan.textDigest }, ...values }).returning())[0]!;
        return { ...context, reply, questionNotification, text: plan.text, partIndex: plan.partIndex, partCount: plan.partCount, action };
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
          await notifyVoiceReplies(tx, { kind: "session", id: candidate.id });
          await tx.update(chatActions).set({status, result: {errorCode: providerError?.code ?? "voice_authority_unavailable", ...(status === "retry" ? {retryAt: Date.now() + 10_000} : {})}, updatedAt: new Date()}).where(eq(chatActions.id, claim.action.id));
          if (status === "call_ended" || status === "unknown") await notifyVoiceRecovery(tx, { kind: "session", id: candidate.id });
          if (status === "call_ended") await notifyVoiceInbound(tx, { kind: "session", id: candidate.id });
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
        await notifyVoiceReplies(tx, { kind: "session", id: candidate.id });
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
