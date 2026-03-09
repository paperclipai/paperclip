import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals } from "@paperclipai/db";

export function goalService(db: Db) {
  return {
    list: (companyId: string, level?: string, status?: string) => {
      const conditions = [eq(goals.companyId, companyId)];
      if (level) conditions.push(eq(goals.level, level));
      if (status) conditions.push(eq(goals.status, status));

      return db.select().from(goals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
