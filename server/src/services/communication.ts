/**
 * Agent communication service — agent-to-agent messaging.
 *
 * Supports direct messages (agent → agent) and broadcast channels.
 * Messages are persisted in the DB with threading and acknowledgement tracking.
 */

import { and, eq, desc, or, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMessages } from "@paperclipai/db";
import { notFound } from "../errors.js";

export function communicationService(db: Db) {
  return {
    /** Send a message */
    send: async (
      companyId: string,
      fromAgentId: string,
      input: {
        channel?: string | null;
        toAgentId?: string | null;
        messageType?: string;
        subject?: string | null;
        body: string;
        payload?: Record<string, unknown>;
        parentMessageId?: string | null;
        referenceType?: string | null;
        referenceId?: string | null;
        priority?: string;
      },
    ) =>
      db
        .insert(agentMessages)
        .values({
          companyId,
          fromAgentId,
          channel: input.channel ?? null,
          toAgentId: input.toAgentId ?? null,
          messageType: input.messageType ?? "text",
          subject: input.subject ?? null,
          body: input.body,
          payload: input.payload ?? null,
          parentMessageId: input.parentMessageId ?? null,
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
          priority: input.priority ?? "normal",
        })
        .returning()
        .then((rows) => rows[0]),

    /** List messages for an agent (inbox: direct + broadcast channels) */
    inbox: (agentId: string, opts?: { channel?: string; limit?: number }) => {
      const conditions = [
        or(
          eq(agentMessages.toAgentId, agentId),
          // Include broadcast messages (no specific recipient) in the same company
          isNull(agentMessages.toAgentId),
        ),
      ];
      if (opts?.channel) {
        conditions.push(eq(agentMessages.channel, opts.channel));
      }
      return db
        .select()
        .from(agentMessages)
        .where(and(...conditions))
        .orderBy(desc(agentMessages.createdAt))
        .limit(opts?.limit ?? 50);
    },

    /** List messages sent by an agent */
    sent: (agentId: string, limit?: number) =>
      db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.fromAgentId, agentId))
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit ?? 50),

    /** List messages in a channel */
    channel: (companyId: string, channel: string, limit?: number) =>
      db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.companyId, companyId),
            eq(agentMessages.channel, channel),
          ),
        )
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit ?? 50),

    /** Get message thread (parent + replies) */
    thread: (parentMessageId: string) =>
      db
        .select()
        .from(agentMessages)
        .where(
          or(
            eq(agentMessages.id, parentMessageId),
            eq(agentMessages.parentMessageId, parentMessageId),
          ),
        )
        .orderBy(agentMessages.createdAt),

    /** Acknowledge a message */
    acknowledge: async (messageId: string) => {
      const existing = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, messageId))
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Message not found");

      return db
        .update(agentMessages)
        .set({
          acknowledged: true,
          acknowledgedAt: new Date(),
        })
        .where(eq(agentMessages.id, messageId))
        .returning()
        .then((rows) => rows[0]);
    },

    /** Get a single message by ID */
    getById: async (id: string) => {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.id, id));
      return rows[0] ?? null;
    },
  };
}
