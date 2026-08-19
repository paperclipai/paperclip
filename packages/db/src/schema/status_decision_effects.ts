import { pgTable, uuid, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { statusDecisions } from "./status_decisions.js";

export const statusDecisionEffects = pgTable("status_decision_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  decisionId: uuid("decision_id").notNull().references(() => statusDecisions.id),
  ordinal: integer("ordinal").notNull(),
  effectKind: text("effect_kind").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  deliveryState: text("delivery_state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  decisionOrdinalUq: uniqueIndex("status_decision_effects_decision_ordinal_uq").on(table.decisionId, table.ordinal),
  idempotencyUq: uniqueIndex("status_decision_effects_company_idempotency_uq")
    .on(table.companyId, table.idempotencyKey),
}));
