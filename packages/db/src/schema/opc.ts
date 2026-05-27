import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { OPCAgentPlanItem, OPCBudgetTimeGuesses, OPCIssuePlanItem, OPCRoutinePlanItem } from "@paperclipai/shared";
import { companies } from "./companies.js";

export const proposalArtifacts = pgTable(
  "proposal_artifacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceType: text("source_type").notNull(),
    filename: text("filename"),
    mimeType: text("mime_type"),
    extractedText: text("extracted_text").notNull(),
    extractionNotes: text("extraction_notes"),
    createdByUserId: text("created_by_user_id"),
    createdCompanyId: uuid("created_company_id").references(() => companies.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdAtIdx: index("proposal_artifacts_created_at_idx").on(table.createdAt),
  }),
);

export const opcBlueprints = pgTable(
  "opc_blueprints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposalArtifacts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    summary: text("summary").notNull(),
    targetCustomer: text("target_customer").notNull(),
    mvpWedge: text("mvp_wedge").notNull(),
    uxNotes: text("ux_notes").notNull(),
    architectureNotes: text("architecture_notes").notNull(),
    risks: jsonb("risks").$type<string[]>().notNull().default([]),
    assumptions: jsonb("assumptions").$type<string[]>().notNull().default([]),
    deliverables: jsonb("deliverables").$type<string[]>().notNull().default([]),
    budgetTimeGuesses: jsonb("budget_time_guesses").$type<OPCBudgetTimeGuesses>().notNull().default({
      timelineWeeks: 0,
      monthlyBudgetCents: 0,
      confidence: "low",
      rationale: "",
    }),
    launchPlan: jsonb("launch_plan").$type<string[]>().notNull().default([]),
    agentPlan: jsonb("agent_plan").$type<OPCAgentPlanItem[]>().notNull().default([]),
    issuePlan: jsonb("issue_plan").$type<OPCIssuePlanItem[]>().notNull().default([]),
    routinePlan: jsonb("routine_plan").$type<OPCRoutinePlanItem[]>().notNull().default([]),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    createdCompanyId: uuid("created_company_id").references(() => companies.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalIdx: index("opc_blueprints_proposal_idx").on(table.proposalId),
    createdCompanyIdx: index("opc_blueprints_created_company_idx").on(table.createdCompanyId),
  }),
);

export const coachDecisions = pgTable(
  "coach_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposalArtifacts.id, { onDelete: "cascade" }),
    blueprintId: uuid("blueprint_id").references(() => opcBlueprints.id, { onDelete: "cascade" }),
    question: text("question").notNull(),
    selectedAnswer: text("selected_answer").notNull(),
    rationale: text("rationale"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalCreatedIdx: index("coach_decisions_proposal_created_idx").on(table.proposalId, table.createdAt),
    questionUq: uniqueIndex("coach_decisions_proposal_question_uq").on(table.proposalId, table.question),
  }),
);
