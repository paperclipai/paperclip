import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueFavourites, issues } from "@paperclipai/db";

export function issueFavouriteService(db: Db) {
  return {
    list: async (companyId: string, userId: string) => {
      const rows = await db
        .select({ favourite: issueFavourites, issue: issues })
        .from(issueFavourites)
        .innerJoin(
          issues,
          and(
            eq(issues.id, issueFavourites.issueId),
            eq(issues.companyId, issueFavourites.companyId),
          ),
        )
        .where(and(eq(issueFavourites.companyId, companyId), eq(issueFavourites.userId, userId)))
        .orderBy(desc(issueFavourites.updatedAt));

      return rows.map(({ favourite, issue }) => ({ ...favourite, issue }));
    },

    add: async (companyId: string, userId: string, issueId: string) => {
      const now = new Date();
      const [row] = await db
        .insert(issueFavourites)
        .values({
          companyId,
          userId,
          issueId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueFavourites.companyId, issueFavourites.issueId, issueFavourites.userId],
          set: { updatedAt: now },
        })
        .returning();
      return row;
    },

    remove: async (companyId: string, userId: string, issueId: string) => {
      const [row] = await db
        .delete(issueFavourites)
        .where(
          and(
            eq(issueFavourites.companyId, companyId),
            eq(issueFavourites.userId, userId),
            eq(issueFavourites.issueId, issueId),
          ),
        )
        .returning();
      return row ?? null;
    },
  };
}
