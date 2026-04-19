import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  real,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const healthScores = pgTable(
  "health_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    scoredAt: timestamp("scored_at", { withTimezone: true }).notNull(),
    overallScore: integer("overall_score").notNull(),
    colorTier: text("color_tier").notNull().default("green"),
    aqiComponent: real("aqi_component"),
    uvComponent: real("uv_component"),
    heatStressComponent: real("heat_stress_component"),
    greenspaceComponent: real("greenspace_component"),
    confidenceFlag: boolean("confidence_flag").notNull().default(true),
    partialSignals: text("partial_signals").array(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userScoredAtIdx: index("health_scores_user_scored_at_idx").on(table.userId, table.scoredAt),
    companyScoredAtIdx: index("health_scores_company_scored_at_idx").on(table.companyId, table.scoredAt),
  }),
);
