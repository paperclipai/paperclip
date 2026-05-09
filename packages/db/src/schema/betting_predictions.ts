import { pgTable, uuid, text, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { bettingMatches } from "./betting_matches.js";

export const bettingPredictions = pgTable(
  "betting_predictions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    matchId: uuid("match_id").notNull().references(() => bettingMatches.id),
    agentId: uuid("agent_id").references(() => agents.id),
    prediction: text("prediction").notNull(),
    confidence: doublePrecision("confidence").notNull(),
    expectedValue: doublePrecision("expected_value"),
    targetOdds: doublePrecision("target_odds"),
    reasoning: text("reasoning"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("betting_predictions_company_created_idx").on(table.companyId, table.createdAt),
    matchIdx: index("betting_predictions_match_idx").on(table.matchId),
  }),
);
