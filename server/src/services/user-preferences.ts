import type { Db } from "@paperclipai/db";
import { authUsers, userPreferences } from "@paperclipai/db";
import type { PatchUserPreferences, SupportedLocale, UserPreferences } from "@paperclipai/shared";
import { eq } from "drizzle-orm";

export function userPreferencesService(db: Db) {
  return {
    get: async (userId: string): Promise<UserPreferences> => {
      const row = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .then((rows) => rows[0] ?? null);

      return {
        locale: (row?.locale as SupportedLocale | null | undefined) ?? null,
      };
    },

    update: async (userId: string, patch: PatchUserPreferences): Promise<UserPreferences> => {
      const existingUser = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null);

      if (!existingUser) {
        return { locale: null };
      }

      if (patch.locale === null) {
        await db.delete(userPreferences).where(eq(userPreferences.userId, userId));
        return { locale: null };
      }

      const now = new Date();
      await db
        .insert(userPreferences)
        .values({
          userId,
          locale: patch.locale,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: {
            locale: patch.locale,
            updatedAt: now,
          },
        });

      return {
        locale: patch.locale,
      };
    },
  };
}
