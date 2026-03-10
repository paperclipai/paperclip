import { eq, and, desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMemories } from "@paperclipai/db";

export interface AgentMemoryFilters {
  companyId: string;
  agentId: string;
  category?: string;
}

export function agentMemoryService(db: Db) {
  return {
    list: (filters: AgentMemoryFilters) => {
      const conditions = [
        eq(agentMemories.companyId, filters.companyId),
        eq(agentMemories.agentId, filters.agentId),
      ];
      if (filters.category) {
        conditions.push(eq(agentMemories.category, filters.category));
      }
      return db
        .select()
        .from(agentMemories)
        .where(and(...conditions))
        .orderBy(desc(agentMemories.importance), desc(agentMemories.updatedAt));
    },

    listForCompany: (companyId: string) =>
      db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.companyId, companyId))
        .orderBy(desc(agentMemories.updatedAt)),

    getById: (id: string) =>
      db
        .select()
        .from(agentMemories)
        .where(eq(agentMemories.id, id))
        .then((rows) => rows[0] ?? null),

    upsert: (
      companyId: string,
      agentId: string,
      data: {
        category: string;
        key: string;
        content: string;
        importance?: number;
        sourceRunId?: string | null;
        sourceIssueId?: string | null;
        expiresAt?: Date | null;
      },
    ) =>
      db
        .insert(agentMemories)
        .values({ ...data, companyId, agentId })
        .onConflictDoUpdate({
          target: [
            agentMemories.companyId,
            agentMemories.agentId,
            agentMemories.category,
            agentMemories.key,
          ],
          set: {
            content: data.content,
            importance: data.importance,
            sourceRunId: data.sourceRunId,
            sourceIssueId: data.sourceIssueId,
            expiresAt: data.expiresAt,
            updatedAt: new Date(),
          },
        })
        .returning()
        .then((rows) => rows[0] ?? null),

    update: (
      id: string,
      data: {
        content?: string;
        importance?: number;
        category?: string;
        expiresAt?: Date | null;
      },
    ) =>
      db
        .update(agentMemories)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(agentMemories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(agentMemories)
        .where(eq(agentMemories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    /** Fetch top-N memories by importance for prompt injection, excluding expired ones. */
    topForAgent: (companyId: string, agentId: string, limit = 10) =>
      db
        .select()
        .from(agentMemories)
        .where(
          and(
            eq(agentMemories.companyId, companyId),
            eq(agentMemories.agentId, agentId),
            sql`(${agentMemories.expiresAt} IS NULL OR ${agentMemories.expiresAt} > now())`,
          ),
        )
        .orderBy(desc(agentMemories.importance), desc(agentMemories.updatedAt))
        .limit(limit),
  };
}
