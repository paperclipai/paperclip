import { and, asc, eq, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { SpekoProviderError, type createSpekoProvider } from "./speko-provider.js";
import type { VoiceSessionRow } from "./voice-session-store.js";

const collecting = new WeakMap<Db, Set<string>>();
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Post-call inspection only. One partial and one final snapshot on success,
 * at most three attempts after failure/restart. Never sends or replays speech. */
export async function captureVoiceDeliveryDiagnostics(db: Db, session: VoiceSessionRow, client: ReturnType<typeof createSpekoProvider>, reportComplete: boolean) {
  if (!session.providerSessionId || !["inbound_phone", "outbound_phone"].includes(session.mode)) return;
  const busy = collecting.get(db) ?? new Set<string>();
  collecting.set(db, busy);
  if (busy.has(session.id)) return;
  busy.add(session.id);
  try {
    const actions = await db.select().from(chatActions).where(and(
      eq(chatActions.companyId, session.companyId), eq(chatActions.endpointId, session.endpointId),
      eq(chatActions.kind, "speko_voice_reply_push"), eq(chatActions.status, "completed"),
      sql`${chatActions.payload}->>'sessionId' = ${session.id}`,
    )).orderBy(asc(chatActions.createdAt)).limit(100);
    const pending = actions.filter(action => {
      const prior = record(action.result?.deliveryDiagnostics);
      return typeof action.result?.messageId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(action.result.messageId)
        && Number(prior.attempts ?? 0) < 3 && !prior.final
        && (prior.state !== "collected" || reportComplete);
    });
    if (!pending.length) return;
    const sampledAt = new Date().toISOString();
    const deliveries = pending.map(action => {
      const previous = record(action.result?.deliveryDiagnostics);
      const value = action.result?.acceptedAt ?? previous.acceptedAt;
      return {messageId: action.result!.messageId as string,
        acceptedAt: typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : action.updatedAt.toISOString()};
    });
    // Commit the attempt before network I/O so repeated failures/restarts are bounded.
    for (const [index, action] of pending.entries()) {
      const attempt = {state: "collecting", attempts: Number(record(action.result?.deliveryDiagnostics).attempts ?? 0) + 1,
        acceptedAt: deliveries[index]!.acceptedAt, sampledAt, final: false};
      await db.update(chatActions).set({result: sql`${chatActions.result} || ${JSON.stringify({deliveryDiagnostics: attempt})}::jsonb`})
        .where(and(eq(chatActions.companyId, session.companyId), eq(chatActions.id, action.id), eq(chatActions.status, "completed")));
    }
    let summary;
    let failure: {errorCode: string; httpStatus: number | null} | undefined;
    try { summary = await client.callDeliveryDiagnostics(session.providerSessionId, deliveries); }
    catch (error) { failure = {errorCode: error instanceof SpekoProviderError ? error.code : "diagnostics_unavailable", httpStatus: error instanceof SpekoProviderError ? error.httpStatus ?? null : null}; }
    const common = {companyId: session.companyId, endpointId: session.endpointId, issueId: session.issueId,
      sessionId: session.id, providerSessionId: session.providerSessionId, sessionState: session.state, generation: session.generation};
    for (const [index, action] of pending.entries()) {
      const attempts = Number(record(action.result?.deliveryDiagnostics).attempts ?? 0) + 1;
      const {messages: _messages, ...callSummary} = summary ?? {messages: []};
      const snapshot = {state: failure ? "failed" : "collected", attempts, sampledAt,
        acceptedAt: deliveries[index]!.acceptedAt, final: !failure && reportComplete && summary?.transcriptComplete === true,
        ...(failure ?? {}), ...callSummary, message: summary?.messages[index] ?? null};
      await db.update(chatActions).set({result: sql`${chatActions.result} || ${JSON.stringify({deliveryDiagnostics: snapshot})}::jsonb`})
        .where(and(eq(chatActions.companyId, session.companyId), eq(chatActions.id, action.id), eq(chatActions.status, "completed")));
      const fields = {...common, actionId: action.id, publicationId: action.payload.publicationId,
        replyId: action.payload.replyId, messageId: deliveries[index]!.messageId, diagnostics: snapshot};
      if (failure) logger.warn({event: "voice.reply.push.diagnostics_failed", ...fields}, "Speko post-call diagnostic read failed; reply acceptance is unchanged");
      else logger.info({event: "voice.reply.push.call_diagnostics", ...fields}, "Captured Speko message acceptance, worker configuration and subsequent transcript activity; playback unconfirmed");
    }
  } catch {
    // Diagnostics must never prevent transcript/history reconciliation.
    logger.warn({event: "voice.reply.push.diagnostics_failed", companyId: session.companyId, endpointId: session.endpointId,
      sessionId: session.id, providerSessionId: session.providerSessionId, errorCode: "diagnostics_persistence_unavailable"}, "Could not retain Speko delivery diagnostics");
  } finally { busy.delete(session.id); }
}
