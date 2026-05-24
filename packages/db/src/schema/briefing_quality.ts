import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const briefingQuality = pgTable(
  "briefing_quality",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    briefingId: text("briefing_id").notNull().unique(),
    overallScore: text("overall_score").notNull(),
    label: text("label").notNull(),
    dimensionScores: jsonb("dimension_scores").notNull().default("[]"),
    gateResults: jsonb("gate_results").notNull().default("[]"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    briefingIdx: index("briefing_quality_briefing_idx").on(table.briefingId),
    labelIdx: index("briefing_quality_label_idx").on(table.label),
  }),
);
