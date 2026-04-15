import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const boardBriefSnapshots = pgTable(
  "board_brief_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    source: text("source").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    health: text("health").notNull(),
    confidence: text("confidence").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    relatedAlertEventId: uuid("related_alert_event_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyGeneratedIdx: index("board_brief_snapshots_company_generated_idx").on(
      table.companyId,
      table.generatedAt,
    ),
    companySourceGeneratedIdx: index("board_brief_snapshots_company_source_generated_idx").on(
      table.companyId,
      table.source,
      table.generatedAt,
    ),
  }),
);
