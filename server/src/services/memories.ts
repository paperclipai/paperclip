import { eq, and, ilike, desc, or, isNull, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { memories } from "@paperclipai/db";

export function memoryService(db: Db) {
  return {
    list: (
      companyId: string,
      filters?: {
        scopeType?: string;
        scopeId?: string;
        category?: string;
        q?: string;
        limit?: number;
      },
    ) => {
      const conditions: SQL[] = [eq(memories.companyId, companyId)];
      if (filters?.scopeType) conditions.push(eq(memories.scopeType, filters.scopeType));
      if (filters?.scopeId) conditions.push(eq(memories.scopeId, filters.scopeId));
      if (filters?.category) conditions.push(eq(memories.category, filters.category));
      if (filters?.q) conditions.push(ilike(memories.content, `%${filters.q}%`));

      const limit = Math.min(filters?.limit ?? 50, 100);

      return db
        .select()
        .from(memories)
        .where(and(...conditions))
        .orderBy(desc(memories.confidence), desc(memories.createdAt))
        .limit(limit);
    },

    getById: (id: string) =>
      db
        .select()
        .from(memories)
        .where(eq(memories.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof memories.$inferInsert, "companyId">) =>
      db
        .insert(memories)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    remove: (id: string) =>
      db
        .delete(memories)
        .where(eq(memories.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    forInjection: (
      companyId: string,
      opts?: { scopeIds?: string[]; limit?: number },
    ) => {
      const limit = Math.min(opts?.limit ?? 20, 100);
      const scopeIds = opts?.scopeIds ?? [];

      const scopeCondition =
        scopeIds.length > 0
          ? or(
              eq(memories.scopeType, "company"),
              ...scopeIds.map((sid) => eq(memories.scopeId, sid)),
            )
          : eq(memories.scopeType, "company");

      return db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), scopeCondition!))
        .orderBy(desc(memories.confidence), desc(memories.createdAt))
        .limit(limit);
    },
  };
}
