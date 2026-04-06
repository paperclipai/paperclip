import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { artifacts } from "@paperclipai/db";

export function artifactService(db: Db) {
  return {
    list: (companyId: string, issueId?: string) => {
      const conditions = [eq(artifacts.companyId, companyId)];
      if (issueId) {
        conditions.push(eq(artifacts.issueId, issueId));
      }
      return db
        .select()
        .from(artifacts)
        .where(and(...conditions))
        .orderBy(desc(artifacts.createdAt));
    },

    getById: (id: string) =>
      db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof artifacts.$inferInsert, "companyId">) =>
      db
        .insert(artifacts)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<Omit<typeof artifacts.$inferInsert, "id" | "companyId" | "createdAt">>) =>
      db
        .update(artifacts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(artifacts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(artifacts)
        .where(eq(artifacts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
