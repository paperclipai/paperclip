import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

export interface MemoryEntrySource {
  kind: string;
  id: string;
}

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    key: text("key").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    tags: jsonb("tags").$type<string[]>().default([]),
    source: jsonb("source").$type<MemoryEntrySource | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedAtIdx: index("memory_entries_company_created_at_idx").on(table.companyId, table.createdAt),
    companyProjectIdx: index("memory_entries_company_project_idx").on(table.companyId, table.projectId),
    // Enforces upsert-by-key: reads by key (get/search/browse) resolve to
    // exactly one current row per (company_id, key) instead of the most
    // recent of a growing set of duplicate-key rows.
    companyKeyUq: uniqueIndex("memory_entries_company_key_uq").on(table.companyId, table.key),
  }),
);
