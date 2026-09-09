import { boolean, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom().notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: text("user_id").notNull(),
    entryDate: text("entry_date").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    moodScore: integer("mood_score"),
    tags: text("tags").array().notNull().default([]),
    isPrivate: boolean("is_private").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userCompanyIdx: index("journal_entries_user_company_idx").on(t.userId, t.companyId),
    dateIdx: index("journal_entries_date_idx").on(t.companyId, t.userId, t.entryDate),
  }),
);
