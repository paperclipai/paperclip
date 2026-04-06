import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMessages, agents } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

export function agentMessageService(db: Db, heartbeat?: HeartbeatService) {
  return {
    async send(input: {
      companyId: string;
      fromAgentId: string;
      toAgentId?: string | null;
      broadcastScope?: "team" | "company" | null;
      messageType?: string;
      subject?: string | null;
      body: string;
      metadata?: Record<string, unknown>;
    }) {
      const [msg] = await db
        .insert(agentMessages)
        .values({
          companyId: input.companyId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId ?? null,
          broadcastScope: input.broadcastScope ?? null,
          messageType: input.messageType ?? "general",
          subject: input.subject ?? null,
          body: input.body,
          metadata: input.metadata ?? null,
        })
        .returning();

      if (heartbeat && input.toAgentId) {
        void heartbeat
          .wakeup(input.toAgentId, {
            source: "message",
            triggerDetail: "system",
            reason: `New message from agent: ${input.messageType ?? "general"}`,
            payload: { messageId: msg.id, fromAgentId: input.fromAgentId },
            requestedByActorType: "agent",
            requestedByActorId: input.fromAgentId,
          })
          .catch((err: unknown) => {
            console.error(`[agent-message] Failed to wake recipient ${input.toAgentId}:`, err);
          });
      } else if (heartbeat && input.broadcastScope) {
        const scopeFilter =
          input.broadcastScope === "company"
            ? eq(agents.companyId, input.companyId)
            : and(
                eq(agents.companyId, input.companyId),
                eq(agents.reportsTo, input.fromAgentId),
              );
        const targets = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(scopeFilter!, eq(agents.status, "idle")));

        for (const target of targets) {
          if (target.id === input.fromAgentId) continue;
          void heartbeat
            .wakeup(target.id, {
              source: "message",
              triggerDetail: "system",
              reason: `Broadcast message: ${input.messageType ?? "general"}`,
              payload: { messageId: msg.id, fromAgentId: input.fromAgentId },
              requestedByActorType: "agent",
              requestedByActorId: input.fromAgentId,
            })
            .catch(() => {});
        }
      }

      return msg;
    },

    async listForAgent(companyId: string, agentId: string, options?: { unreadOnly?: boolean }) {
      const conditions = [
        eq(agentMessages.companyId, companyId),
        or(
          eq(agentMessages.toAgentId, agentId),
          and(isNull(agentMessages.toAgentId), eq(agentMessages.broadcastScope, "company")),
        )!,
      ];

      if (options?.unreadOnly) {
        conditions.push(isNull(agentMessages.readAt));
      }

      return db
        .select()
        .from(agentMessages)
        .where(and(...conditions))
        .orderBy(desc(agentMessages.createdAt))
        .limit(100);
    },

    async markRead(messageId: string) {
      const [updated] = await db
        .update(agentMessages)
        .set({ readAt: new Date(), updatedAt: new Date() })
        .where(eq(agentMessages.id, messageId))
        .returning();
      return updated;
    },

    async countUnread(companyId: string, agentId: string): Promise<number> {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.companyId, companyId),
            or(
              eq(agentMessages.toAgentId, agentId),
              and(isNull(agentMessages.toAgentId), eq(agentMessages.broadcastScope, "company")),
            ),
            isNull(agentMessages.readAt),
          ),
        );
      return rows.length;
    },
  };
}
