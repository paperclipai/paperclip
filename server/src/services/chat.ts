import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatRooms, chatMessages, agents } from "@paperclipai/db";

export function chatService(db: Db) {
  return {
    listRooms: async (companyId: string) => {
      return db
        .select()
        .from(chatRooms)
        .where(eq(chatRooms.companyId, companyId))
        .orderBy(desc(chatRooms.updatedAt));
    },

    getRoom: async (roomId: string, companyId: string) => {
      const [room] = await db
        .select()
        .from(chatRooms)
        .where(and(eq(chatRooms.id, roomId), eq(chatRooms.companyId, companyId)));
      return room ?? null;
    },

    getOrCreateDirectRoom: async (companyId: string, agentId: string) => {
      // Check agent exists and belongs to company
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      if (!agent) {
        return { room: null, created: false, error: "agent_not_found" as const };
      }

      // Find existing
      const [existing] = await db
        .select()
        .from(chatRooms)
        .where(
          and(
            eq(chatRooms.companyId, companyId),
            eq(chatRooms.agentId, agentId),
            eq(chatRooms.kind, "direct"),
          ),
        );
      if (existing) {
        return { room: existing, created: false, error: null };
      }

      const [room] = await db
        .insert(chatRooms)
        .values({ companyId, kind: "direct", agentId })
        .returning();
      return { room, created: true, error: null };
    },

    getOrCreateBoardroom: async (companyId: string) => {
      const [existing] = await db
        .select()
        .from(chatRooms)
        .where(and(eq(chatRooms.companyId, companyId), eq(chatRooms.kind, "boardroom")));
      if (existing) {
        return { room: existing, created: false };
      }

      const [room] = await db
        .insert(chatRooms)
        .values({ companyId, kind: "boardroom", title: "Boardroom" })
        .returning();
      return { room, created: true };
    },

    listMessages: async (roomId: string, opts?: { before?: string; limit?: number }) => {
      const MAX_MESSAGE_LIMIT = 200;
      const rawLimit = opts?.limit ?? MAX_MESSAGE_LIMIT;
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), MAX_MESSAGE_LIMIT)
          : MAX_MESSAGE_LIMIT;

      const before = opts?.before?.trim() || null;

      if (!before) {
        return db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.chatRoomId, roomId))
          .orderBy(desc(chatMessages.createdAt))
          .limit(limit);
      }

      // Fetch the cursor message's createdAt for keyset pagination
      const [cursor] = await db
        .select({ createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(eq(chatMessages.id, before));

      if (!cursor) {
        return [];
      }

      return db
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.chatRoomId, roomId),
            lt(chatMessages.createdAt, cursor.createdAt),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit);
    },

    addMessage: async (
      roomId: string,
      body: string,
      opts: { companyId: string; agentId?: string; userId?: string; runId?: string },
    ) => {
      const [message] = await db
        .insert(chatMessages)
        .values({
          chatRoomId: roomId,
          companyId: opts.companyId,
          authorAgentId: opts.agentId,
          authorUserId: opts.userId,
          body,
          runId: opts.runId,
        })
        .returning();

      // Update room timestamp
      await db
        .update(chatRooms)
        .set({ updatedAt: new Date() })
        .where(eq(chatRooms.id, roomId));

      return message;
    },
  };
}
