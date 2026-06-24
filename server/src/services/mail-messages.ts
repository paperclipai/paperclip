import { and, desc, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { mailMessages } from "@paperclipai/db";
import type { MailInboxQuery, MailMessage } from "@paperclipai/shared";
import { notFound } from "../errors.js";

const MAX_SEND_ATTEMPTS = 5;

export interface EnqueueOutboundInput {
  addressId: string;
  agentId: string;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  inReplyTo?: string | null;
}

export interface RecordInboundInput {
  addressId: string;
  agentId: string | null;
  fromAddr: string;
  toAddrs: string[];
  ccAddrs?: string[];
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
  headers?: Record<string, string>;
  messageId?: string | null;
  inReplyTo?: string | null;
}

type MailMessageRow = typeof mailMessages.$inferSelect;

function toMailMessage(row: MailMessageRow): MailMessage {
  return {
    id: row.id,
    companyId: row.companyId,
    addressId: row.addressId,
    agentId: row.agentId,
    direction: row.direction as MailMessage["direction"],
    messageId: row.messageId,
    inReplyTo: row.inReplyTo,
    fromAddr: row.fromAddr,
    toAddrs: row.toAddrs ?? [],
    ccAddrs: row.ccAddrs ?? [],
    subject: row.subject,
    textBody: row.textBody,
    htmlBody: row.htmlBody,
    status: row.status as MailMessage["status"],
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function mailMessageService(db: Db) {
  return {
    /** Store a parsed inbound message (called by the SMTP listener). */
    recordInbound: async (companyId: string, input: RecordInboundInput): Promise<MailMessage> => {
      const row = await db
        .insert(mailMessages)
        .values({
          companyId,
          addressId: input.addressId,
          agentId: input.agentId,
          direction: "inbound",
          status: "received",
          fromAddr: input.fromAddr,
          toAddrs: input.toAddrs,
          ccAddrs: input.ccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          headers: input.headers ?? {},
          messageId: input.messageId ?? null,
          inReplyTo: input.inReplyTo ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailMessage(row);
    },

    listInbox: async (
      companyId: string,
      agentId: string,
      query: MailInboxQuery = {},
    ): Promise<MailMessage[]> => {
      const conditions = [
        eq(mailMessages.companyId, companyId),
        eq(mailMessages.agentId, agentId),
        eq(mailMessages.direction, "inbound"),
      ];
      if (query.status) conditions.push(eq(mailMessages.status, query.status));
      if (query.since) conditions.push(gt(mailMessages.createdAt, new Date(query.since)));
      const rows = await db
        .select()
        .from(mailMessages)
        .where(and(...conditions))
        .orderBy(desc(mailMessages.createdAt))
        .limit(query.limit ?? 50);
      return rows.map(toMailMessage);
    },

    getById: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .select()
        .from(mailMessages)
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    /** Queue an outbound message for the worker to deliver (phase 2). */
    enqueueOutbound: async (companyId: string, input: EnqueueOutboundInput): Promise<MailMessage> => {
      const row = await db
        .insert(mailMessages)
        .values({
          companyId,
          addressId: input.addressId,
          agentId: input.agentId,
          direction: "outbound",
          status: "queued",
          fromAddr: input.fromAddr,
          toAddrs: input.toAddrs,
          ccAddrs: input.ccAddrs ?? [],
          subject: input.subject ?? null,
          textBody: input.textBody ?? null,
          htmlBody: input.htmlBody ?? null,
          inReplyTo: input.inReplyTo ?? null,
          nextAttemptAt: new Date(),
        })
        .returning()
        .then((rows) => rows[0]);
      return toMailMessage(row);
    },

    /** Claim due outbound messages, atomically marking them `sending`. */
    claimDueOutbound: async (now: Date, limit: number): Promise<MailMessageRow[]> => {
      const due = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.direction, "outbound"),
            inArray(mailMessages.status, ["queued", "failed"]),
            or(isNull(mailMessages.nextAttemptAt), lte(mailMessages.nextAttemptAt, now)),
          ),
        )
        .limit(limit);
      if (due.length === 0) return [];
      const ids = due.map((d) => d.id);
      return db
        .update(mailMessages)
        .set({ status: "sending", updatedAt: new Date() })
        .where(and(inArray(mailMessages.id, ids), inArray(mailMessages.status, ["queued", "failed"])))
        .returning();
    },

    markSent: async (id: string): Promise<void> => {
      await db
        .update(mailMessages)
        .set({ status: "sent", sentAt: new Date(), error: null, updatedAt: new Date() })
        .where(eq(mailMessages.id, id));
    },

    /** Mark a send attempt failed: retry with backoff, or give up after the cap. */
    markFailed: async (id: string, message: string): Promise<void> => {
      const row = await db
        .select({ attempts: mailMessages.attempts })
        .from(mailMessages)
        .where(eq(mailMessages.id, id))
        .then((rows) => rows[0]);
      const attempts = (row?.attempts ?? 0) + 1;
      const giveUp = attempts >= MAX_SEND_ATTEMPTS;
      const backoffMs = Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** attempts);
      await db
        .update(mailMessages)
        .set({
          // "bounced" is terminal (not re-claimed); "failed" retries after the backoff.
          status: giveUp ? "bounced" : "failed",
          attempts,
          error: message.slice(0, 500),
          nextAttemptAt: giveUp ? null : new Date(Date.now() + backoffMs),
          updatedAt: new Date(),
        })
        .where(eq(mailMessages.id, id));
    },

    markRead: async (companyId: string, id: string): Promise<MailMessage> => {
      const row = await db
        .update(mailMessages)
        .set({ status: "read", readAt: new Date(), updatedAt: new Date() })
        .where(and(eq(mailMessages.id, id), eq(mailMessages.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Message not found");
      return toMailMessage(row);
    },

    /**
     * Compact unread-inbox digest injected into an agent's run context, so the
     * agent notices and can act on new mail without polling.
     */
    buildRunEmailSummary: async (companyId: string, agentId: string): Promise<string> => {
      const rows = await db
        .select()
        .from(mailMessages)
        .where(
          and(
            eq(mailMessages.companyId, companyId),
            eq(mailMessages.agentId, agentId),
            eq(mailMessages.direction, "inbound"),
            eq(mailMessages.status, "received"),
          ),
        )
        .orderBy(desc(mailMessages.createdAt))
        .limit(10);
      if (rows.length === 0) return "";
      const lines = rows.map((r) => {
        const subject = (r.subject ?? "(no subject)").slice(0, 120);
        return `- from ${r.fromAddr} | ${subject} | id ${r.id}`;
      });
      return [
        `You have ${rows.length} unread email${rows.length === 1 ? "" : "s"}:`,
        ...lines,
        "API (Authorization: Bearer $PAPERCLIP_API_KEY, base $PAPERCLIP_API_URL/api):",
        "- read: GET /agents/$PAPERCLIP_AGENT_ID/email/inbox and /agents/$PAPERCLIP_AGENT_ID/email/messages/<id>",
        "- your addresses: GET /agents/$PAPERCLIP_AGENT_ID/email/addresses (use an id as fromAddressId)",
        '- reply/send: POST /agents/$PAPERCLIP_AGENT_ID/email/send {"fromAddressId":"<id>","to":["..."],"subject":"...","text":"...","inReplyTo":"<messageId of the email you reply to>"}',
        "- mark read: POST /agents/$PAPERCLIP_AGENT_ID/email/messages/<id>/read",
      ].join("\n");
    },
  };
}
