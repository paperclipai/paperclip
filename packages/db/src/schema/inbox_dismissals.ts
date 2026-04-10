import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const inboxDismissals = pgTable(
  "inbox_dismissals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    itemKey: text("item_key").notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("inbox_dismissals_company_user_idx").on(table.companyId, table.userId),
    companyItemIdx: index("inbox_dismissals_company_item_idx").on(table.companyId, table.itemKey),
    companyUserItemUnique: uniqueIndex("inbox_dismissals_company_user_item_idx").on(
      table.companyId,
      table.userId,
      table.itemKey,
    ),
  }),
);
