import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { deployments } from "@paperclipai/db";

export function deploymentService(db: Db) {
  return {
    list: (companyId: string) =>
      db
        .select()
        .from(deployments)
        .where(eq(deployments.companyId, companyId))
        .orderBy(desc(deployments.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(deployments)
        .where(eq(deployments.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof deployments.$inferInsert, "companyId">) =>
      db
        .insert(deployments)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof deployments.$inferInsert>) =>
      db
        .update(deployments)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(deployments.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
