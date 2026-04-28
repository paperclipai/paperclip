import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const rt2SettlementGovernance = pgTable(
  "rt2_settlement_governance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    workProductId: uuid("work_product_id").notNull(),
    taskIssueId: uuid("task_issue_id").notNull(),
    ownerActorId: text("owner_actor_id").notNull(),
    ownerActorType: text("owner_actor_type").notNull(),
    proposedPriceGold: integer("proposed_price_gold").notNull(),
    finalPriceGold: integer("final_price_gold"),
    rationale: text("rationale").notNull(),
    negotiationComments: jsonb("negotiation_comments").$type<Array<{
      actorId: string;
      actorType: "user" | "agent" | "system";
      comment: string;
      createdAt: string;
    }>>().notNull().default([]),
    status: text("status").notNull().default("proposed"),
    approvalRequired: integer("approval_required").notNull().default(0),
    approvalGateReason: text("approval_gate_reason"),
    riskLevel: text("risk_level").notNull().default("low"),
    antiGamingSignals: jsonb("anti_gaming_signals").$type<Array<{
      key: string;
      label: string;
      severity: "info" | "warning" | "critical";
      evidence: string;
    }>>().notNull().default([]),
    approverId: text("approver_id"),
    decisionReason: text("decision_reason"),
    ledgerEntryId: uuid("ledger_entry_id"),
    pnlPeriod: text("pnl_period"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyWorkProductUq: uniqueIndex("rt2_settlement_company_work_product_uq").on(table.companyId, table.workProductId),
    companyStatusIdx: index("rt2_settlement_company_status_idx").on(table.companyId, table.status),
    workProductIdx: index("rt2_settlement_work_product_idx").on(table.companyId, table.workProductId),
    ownerIdx: index("rt2_settlement_owner_idx").on(table.companyId, table.ownerActorId, table.ownerActorType),
  }),
);

export const rt2SettlementThresholds = pgTable(
  "rt2_settlement_thresholds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    highValueGold: integer("high_value_gold").notNull().default(1000),
    selfReviewCriticalCount: integer("self_review_critical_count").notNull().default(2),
    goldFarmingEarnedCount: integer("gold_farming_earned_count").notNull().default(5),
    goldFarmingWarningGold: integer("gold_farming_warning_gold").notNull().default(1500),
    goldFarmingWarningMultiplier: integer("gold_farming_warning_multiplier").notNull().default(3),
    goldFarmingCriticalGold: integer("gold_farming_critical_gold").notNull().default(2500),
    goldFarmingCriticalMultiplier: integer("gold_farming_critical_multiplier").notNull().default(5),
    qualityBiasAutoScore: integer("quality_bias_auto_score").notNull().default(98),
    evaluationWindowDays: integer("evaluation_window_days").notNull().default(30),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("rt2_settlement_thresholds_company_uq").on(table.companyId),
  }),
);

export const rt2AntiGamingSignals = pgTable(
  "rt2_anti_gaming_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    settlementId: uuid("settlement_id").references(() => rt2SettlementGovernance.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    signalType: text("signal_type").notNull(),
    severity: text("severity").notNull(),
    evidence: text("evidence").notNull(),
    referenceId: text("reference_id"),
    referenceType: text("reference_type"),
    usedInDecision: integer("used_in_decision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorIdx: index("rt2_anti_gaming_company_actor_idx").on(table.companyId, table.actorId, table.actorType),
    settlementIdx: index("rt2_anti_gaming_settlement_idx").on(table.settlementId),
  }),
);
