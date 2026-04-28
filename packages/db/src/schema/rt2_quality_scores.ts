import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Quality scores for Co-Pilot evaluation mode.
 * AI generates preliminary evaluation, manager gives final approval/rejection.
 * In shadow mode: positive scores are applied, negative scores are recorded but don't subtract.
 * In Co-Pilot mode: AI evaluates, manager approves/rejects with feedback.
 * M4.1: Auto evaluation within ±10% band - auto-approve or escalate to copilot
 */
export const rt2QualityScores = pgTable(
  "rt2_quality_scores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    /** The deliverable/work product being scored */
    deliverableId: uuid("deliverable_id").references(() => issues.id, { onDelete: "cascade" }),
    /** The task that produced this deliverable */
    taskIssueId: uuid("task_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    /** Who/what performed the evaluation (agent, ai, human) */
    evaluator: text("evaluator").notNull(),
    /** Evaluation type */
    evalType: text("eval_type").notNull(),
    /** The actual score value */
    score: integer("score").notNull(),
    /** Is this a positive or negative score? */
    direction: text("direction").notNull(), // 'positive' | 'negative'
    /** Score category */
    category: text("category").notNull(), // 'accuracy', 'completeness', 'relevance', 'quality'
    /** Feedback or rationale for the score */
    rationale: text("rationale"),
    /** Shadow mode: is this score active? (positive = yes, negative = no in shadow mode) */
    isActive: integer("is_active").notNull().default(1), // 1 = active, 0 = shadow-only
    /** M3.1: Manager decision - approved, rejected, or pending */
    managerDecision: text("manager_decision"), // 'approved' | 'rejected' | 'pending' | null (null for shadow)
    /** M3.1: Manager who made the decision */
    managerId: text("manager_id"),
    /** M3.1: Manager's feedback comment */
    managerFeedback: text("manager_feedback"),
    /** M3.1: Is this evaluation finalized by manager? */
    isFinalized: integer("is_finalized").notNull().default(0), // 1 = finalized, 0 = pending
    /** M4.1: Base price snapshot at evaluation time (gold units) */
    basePrice: integer("base_price"),
    /** M4.1: Lower bound of auto-approval band (basePrice * (1 - threshold)) */
    autoApprovalBandLow: integer("auto_approval_band_low"),
    /** M4.1: Upper bound of auto-approval band (basePrice * (1 + threshold)) */
    autoApprovalBandHigh: integer("auto_approval_band_high"),
    /** M4.1: Evaluation mode - 'auto' (within ±10%) or 'copilot' (outside band) */
    evaluationMode: text("evaluation_mode"), // 'auto' | 'copilot'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("rt2_quality_scores_company_idx").on(table.companyId),
    deliverableIdx: index("rt2_quality_scores_deliverable_idx").on(table.deliverableId),
    taskIdx: index("rt2_quality_scores_task_idx").on(table.taskIssueId),
    evaluatorIdx: index("rt2_quality_scores_evaluator_idx").on(table.evaluator),
    activeScoresIdx: index("rt2_quality_scores_active_idx").on(table.isActive),
    pendingEvalIdx: index("rt2_quality_scores_pending_idx").on(table.isFinalized),
  }),
);
