import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { chatActions, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { notifyVoiceReplies } from "./voice-reply-notifications.js";
import { VOICE_REPLY_ACTION_KIND, VOICE_REPLY_DISPATCH_TIMEOUT_MS } from "./voice-reply-policy.js";

/** Expired dispatch intent is uncertainty, never permission to repeat provider I/O. */
export async function recoverVoiceReplyDispatches(db: Db, scope: {
  actionId?: string; sessionId?: string; companyId?: string; endpointId?: string;
} = {}) {
  const cutoff = new Date(Date.now() - VOICE_REPLY_DISPATCH_TIMEOUT_MS);
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.select({ id: chatActions.id, endpointId: chatActions.endpointId, companyId: chatActions.companyId, updatedAt: chatActions.updatedAt }).from(chatActions)
      .where(and(eq(chatActions.kind, VOICE_REPLY_ACTION_KIND), eq(chatActions.status, "dispatching"),
        lt(chatActions.updatedAt, cutoff),
        cursor ? gt(chatActions.id, cursor) : undefined,
        scope.actionId ? eq(chatActions.id, scope.actionId) : undefined,
        scope.companyId ? eq(chatActions.companyId, scope.companyId) : undefined,
        scope.endpointId ? eq(chatActions.endpointId, scope.endpointId) : undefined,
        scope.sessionId ? sql`${chatActions.payload}->>'sessionId' = ${scope.sessionId}` : undefined))
      .orderBy(asc(chatActions.id)).limit(100);
    for (const row of rows) {
      const changed = await db.transaction(async tx => {
        await notifyVoiceReplies(tx, { kind: "endpoint", id: row.endpointId });
        return tx.update(chatActions).set({ status: "unknown", result: { errorCode: "message_delivery_unknown" }, updatedAt: new Date() })
          .where(and(eq(chatActions.id, row.id), eq(chatActions.status, "dispatching"), lt(chatActions.updatedAt, cutoff))).returning({ id: chatActions.id });
      });
      if (changed.length) logger.warn({ event: "voice.reply.push.abandoned", companyId: row.companyId, endpointId: row.endpointId,
        actionId: row.id, outcomeUnknown: true }, "Speko dispatch intent expired without a durable receipt; no resend");
    }
    if (rows.length < 100) return;
    cursor = rows[rows.length - 1].id;
  }
}
