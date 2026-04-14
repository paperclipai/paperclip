import { pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

const supportedLocales = ["en", "zh-CN", "ja-JP", "es-ES", "fr-FR", "de-DE"] as const;

export const userPreferenceLocale = pgEnum("user_preference_locale", [...supportedLocales] as [string, ...string[]]);

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  locale: userPreferenceLocale("locale").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
