import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyKnowledge } from "@paperclipai/db";

export function companyKnowledgeService(db: Db) {
  return {
    list: (companyId: string) =>
      db.select().from(companyKnowledge).where(eq(companyKnowledge.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(companyKnowledge)
        .where(eq(companyKnowledge.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof companyKnowledge.$inferInsert, "companyId">) =>
      db
        .insert(companyKnowledge)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof companyKnowledge.$inferInsert>) =>
      db
        .update(companyKnowledge)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(companyKnowledge.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(companyKnowledge)
        .where(eq(companyKnowledge.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
