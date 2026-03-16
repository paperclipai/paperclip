import type { Db } from "@paperclipai/db";
import { agentConversations } from "@paperclipai/db";
import { eq, desc } from "drizzle-orm";

export interface ChatMessage {
  id: string;
  agentId: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

export function agentChatService(db: Db) {
  return {
    /**
     * Get all messages for an agent
     */
    async getMessages(agentId: string, limit: number = 100): Promise<ChatMessage[]> {
      const messages = await db
        .select()
        .from(agentConversations)
        .where(eq(agentConversations.agentId, agentId as any))
        .orderBy(desc(agentConversations.createdAt))
        .limit(limit);

      return messages.map((m) => ({
        id: m.id,
        agentId: m.agentId,
        role: m.role as "user" | "assistant",
        content: m.content,
        metadata: m.metadata as Record<string, any> | undefined,
        createdAt: m.createdAt,
      }));
    },

    /**
     * Save a message to the conversation
     */
    async saveMessage(
      agentId: string,
      role: "user" | "assistant",
      content: string,
      metadata?: Record<string, any>
    ): Promise<ChatMessage> {
      const [inserted] = await db
        .insert(agentConversations)
        .values({
          agentId: agentId as any,
          role,
          content,
          metadata,
        })
        .returning();

      return {
        id: inserted.id,
        agentId: inserted.agentId,
        role: inserted.role as "user" | "assistant",
        content: inserted.content,
        metadata: inserted.metadata as Record<string, any> | undefined,
        createdAt: inserted.createdAt,
      };
    },

    /**
     * Clear conversation history for an agent
     */
    async clearMessages(agentId: string): Promise<void> {
      await db.delete(agentConversations).where(eq(agentConversations.agentId, agentId as any));
    },
  };
}
