import { pgTable, uuid, text, timestamp, doublePrecision, jsonb, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { bettingPredictions } from "./betting_predictions.js";

export const bettingPlacedBets = pgTable(
  "betting_placed_bets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    predictionId: uuid("prediction_id").references(() => bettingPredictions.id),
    bookmaker: text("bookmaker").notNull(),
    odds: doublePrecision("odds").notNull(),
    stake: doublePrecision("stake").notNull(),
    currency: text("currency").notNull().default("RON"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    executionStatus: text("execution_status").notNull(),
    executionLedger: jsonb("execution_ledger").$type<Record<string, unknown>>(),
    profitLoss: doublePrecision("profit_loss"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPlacedAtIdx: index("betting_placed_bets_company_placed_at_idx").on(table.companyId, table.placedAt),
    idempotencyKeyUniq: unique("betting_placed_bets_idempotency_key_uniq").on(table.idempotencyKey),
  }),
);
