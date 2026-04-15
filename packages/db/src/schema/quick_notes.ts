import { pgTable, uuid, text, timestamp, index, jsonb, boolean } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const quickNotes = pgTable(
  "quick_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    text: text("text").notNull(),
    status: text("status").notNull().default("new"), // 'new' | 'researching' | 'has_suggestions' | 'dismissed'
    dismissed: boolean("dismissed").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("quick_notes_company_user_idx").on(table.companyId, table.userId),
    companyCreatedIdx: index("quick_notes_company_created_idx").on(table.companyId, table.createdAt),
  }),
);

export const quickNoteThreads = pgTable(
  "quick_note_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => quickNotes.id, { onDelete: "cascade" }),
    authorType: text("author_type").notNull(), // 'user' | 'agent'
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    noteIdIdx: index("quick_note_threads_note_id_idx").on(table.noteId),
  }),
);
