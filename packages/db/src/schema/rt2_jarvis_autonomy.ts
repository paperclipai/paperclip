import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { approvals } from "./approvals.js";

export const rt2JarvisRewriteProposals = pgTable(
  "rt2_jarvis_rewrite_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    targetKey: text("target_key").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("proposed"),
    riskLevel: text("risk_level").notNull().default("low"),
    proposedDiff: jsonb("proposed_diff").$type<Record<string, unknown>>().notNull(),
    rationale: text("rationale"),
    citations: jsonb("citations").$type<Array<Record<string, unknown>>>().notNull().default([]),
    contradictionIds: jsonb("contradiction_ids").$type<string[]>().notNull().default([]),
    approvalId: uuid("approval_id").references(() => approvals.id, { onDelete: "set null" }),
    approvalRoute: text("approval_route"),
    latestEval: jsonb("latest_eval").$type<Record<string, unknown> | null>(),
    createdBy: text("created_by").notNull().default("system"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("rt2_jarvis_rewrite_proposals_company_status_idx").on(table.companyId, table.status),
    companyTargetIdx: index("rt2_jarvis_rewrite_proposals_target_idx").on(table.companyId, table.targetType, table.targetId),
    approvalIdx: index("rt2_jarvis_rewrite_proposals_approval_idx").on(table.approvalId),
  }),
);

export const rt2JarvisRewriteEvals = pgTable(
  "rt2_jarvis_rewrite_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id").notNull().references(() => rt2JarvisRewriteProposals.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    providerStatus: text("provider_status").notNull().default("not_run"),
    fallbackStatus: text("fallback_status").notNull().default("completed"),
    providerRubric: jsonb("provider_rubric").$type<Record<string, unknown> | null>(),
    fallbackRubric: jsonb("fallback_rubric").$type<Record<string, unknown>>().notNull(),
    comparison: jsonb("comparison").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    proposalIdx: index("rt2_jarvis_rewrite_evals_proposal_idx").on(table.proposalId),
    companyCreatedIdx: index("rt2_jarvis_rewrite_evals_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
