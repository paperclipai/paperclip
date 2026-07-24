import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userPreferences } from "@paperclipai/db";
import type { SupportedCurrency } from "@paperclipai/shared";

export interface UserPreferences {
  preferredCurrency: SupportedCurrency;
}

function toCurrency(code: string | null): SupportedCurrency {
  return (code as SupportedCurrency) ?? "USD";
}

export function userPreferencesService(db: Db) {
  return {
    async getPreferences(userId: string): Promise<{ preferredCurrency: SupportedCurrency }> {
      const row = await db.query.userPreferences.findFirst({
        where: eq(userPreferences.userId, userId),
      });
      return { preferredCurrency: toCurrency(row?.preferredCurrency ?? null) };
    },

    async upsertPreferences(
      userId: string,
      preferredCurrency: SupportedCurrency,
    ): Promise<{ preferredCurrency: SupportedCurrency }> {
      const now = new Date();
      const [row] = await db
        .insert(userPreferences)
        .values({
          userId,
          preferredCurrency,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userPreferences.userId],
          set: {
            preferredCurrency,
            updatedAt: now,
          },
        })
        .returning();
      return { preferredCurrency: toCurrency(row?.preferredCurrency ?? preferredCurrency) };
    },
  };
}