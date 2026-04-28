import { index, integer, pgTable, real, text, timestamp, uuid, date } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

/**
 * Promotion triggers - tracks when agents become eligible for promotion
 * M4.2: 승진 트리거 - 명성 지수 임계값 초과 시 등록
 */
export const rt2PromotionTriggers = pgTable(
  "rt2_promotion_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** The reputation threshold that was crossed */
    reputationThreshold: integer("reputation_threshold").notNull(),
    /** Tier reached (senior=700, expert=850, legend=950) */
    tierReached: text("tier_reached").notNull(), // 'senior', 'expert', 'legend'
    /** Status of the promotion trigger */
    status: text("status").notNull().default("pending"), // 'pending', 'approved', 'rejected', 'auto_promoted'
    /** When the threshold was crossed */
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the promotion was resolved */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Who resolved it (manager ID or 'system') */
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("promotion_triggers_company_agent_idx").on(table.companyId, table.agentId),
    companyStatusIdx: index("promotion_triggers_company_status_idx").on(table.companyId, table.status),
  }),
);

/**
 * Performance reviews - formal performance evaluation records
 * M4.2: 고과 기록 - 공식 고과 데이터 저장
 */
export const rt2PerformanceReviews = pgTable(
  "rt2_performance_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    /** Review period type */
    reviewPeriod: text("review_period").notNull(), // 'quarterly', 'halfyearly', 'yearly'
    /** Start date of review period */
    periodStart: date("period_start").notNull(),
    /** End date of review period */
    periodEnd: date("period_end").notNull(),
    /** Reputation index at start of period */
    reputationStart: integer("reputation_start").notNull(),
    /** Reputation index at end of period */
    reputationEnd: integer("reputation_end").notNull(),
    /** Change in reputation over period */
    reputationDelta: integer("reputation_delta").notNull(),
    /** Performance grade */
    grade: text("grade").notNull(), // 'S', 'A', 'B', 'C', 'D'
    /** Written feedback */
    feedback: text("feedback"),
    /** Who conducted the review */
    reviewerId: text("reviewer_id"),
    /** Review status */
    status: text("status").notNull().default("draft"), // 'draft', 'submitted', 'acknowledged'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("perf_reviews_company_agent_idx").on(table.companyId, table.agentId),
    companyPeriodIdx: index("perf_reviews_company_period_idx").on(table.companyId, table.reviewPeriod),
    agentPeriodIdx: index("perf_reviews_agent_period_idx").on(table.agentId, table.periodEnd),
  }),
);

/**
 * Credit conversion ledger - tracks conversion of credits to gold
 * M4.2: 크레딧-금화 전환 기록
 */
export const rt2CreditConversionLedger = pgTable(
  "rt2_credit_conversion_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** userId or agentId */
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(), // 'user' or 'agent'
    /** Number of credits converted */
    creditsConverted: integer("credits_converted").notNull(),
    /** Gold received after conversion */
    goldReceived: integer("gold_received").notNull(),
    /** Conversion rate at time of conversion (credits per gold) */
    conversionRate: real("conversion_rate").notNull(),
    /** Source of credits */
    source: text("source").notNull(), // 'collaboration', 'achievement', 'manual', 'evaluation'
    /** Optional reference to related entity */
    referenceId: uuid("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActorIdx: index("credit_conv_company_actor_idx").on(table.companyId, table.actorId),
    createdAtIdx: index("credit_conv_created_idx").on(table.createdAt),
  }),
);

// ============================================================================
// Constants
// ============================================================================

/** Default credits required per gold (10 credits = 1 gold) */
export const CREDITS_PER_GOLD = 10;

/** Promotion tier thresholds (reputation index) */
export const PROMOTION_TIERS = {
  senior: 700,
  expert: 850,
  legend: 950,
} as const;

/** Grade thresholds based on reputation delta */
export const GRADE_THRESHOLDS = {
  S: 100,   // delta >= 100
  A: 50,    // delta >= 50
  B: 0,     // delta >= 0
  C: -50,   // delta >= -50
  D: Number.NEGATIVE_INFINITY, // delta < -50
} as const;

/**
 * Calculate grade from reputation delta
 */
export function calculateGrade(reputationDelta: number): "S" | "A" | "B" | "C" | "D" {
  if (reputationDelta >= GRADE_THRESHOLDS.S) return "S";
  if (reputationDelta >= GRADE_THRESHOLDS.A) return "A";
  if (reputationDelta >= GRADE_THRESHOLDS.B) return "B";
  if (reputationDelta >= GRADE_THRESHOLDS.C) return "C";
  return "D";
}

/**
 * Get tier name from reputation index
 */
export function getTierFromReputation(reputation: number): string {
  if (reputation >= PROMOTION_TIERS.legend) return "legend";
  if (reputation >= PROMOTION_TIERS.expert) return "expert";
  if (reputation >= PROMOTION_TIERS.senior) return "senior";
  return "member";
}

/**
 * Calculate gold from credits
 */
export function calculateGoldFromCredits(credits: number): {
  gold: number;
  remainingCredits: number;
} {
  const gold = Math.floor(credits / CREDITS_PER_GOLD);
  const remainingCredits = credits % CREDITS_PER_GOLD;
  return { gold, remainingCredits };
}
