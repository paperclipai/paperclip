import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

export const userSidebarPreferences = pgTable(
  "user_sidebar_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    companyOrder: jsonb("company_order").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_sidebar_preferences_user_uq").on(table.userId),
  }),
);
