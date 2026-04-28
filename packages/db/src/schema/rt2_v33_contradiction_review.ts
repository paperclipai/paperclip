import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export type Rt2ContradictionCandidateStatus = "open" | "resolved";
export type Rt2ContradictionResolutionDecision = "false_positive" | "accept_newer" | "keep_older" | "request_follow_up";

export const rt2V33ContradictionCandidates = pgTable(
  "rt2_v33_contradiction_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    status: text("status").$type<Rt2ContradictionCandidateStatus>().notNull().default("open"),
    reasonCode: text("reason_code").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation"),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    sourceKey: text("source_key").notNull(),
    conflictingSourceType: text("conflicting_source_type").notNull(),
    conflictingSourceId: text("conflicting_source_id").notNull(),
    conflictingSourceKey: text("conflicting_source_key").notNull(),
    confidence: text("confidence").notNull().default("unknown"),
    rawEvidence: jsonb("raw_evidence").$type<Array<Record<string, unknown>>>().notNull().default([]),
    deterministicSignals: jsonb("deterministic_signals").$type<Record<string, unknown>>().notNull().default({}),
    providerExplanation: jsonb("provider_explanation").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("rt2_v33_contra_candidates_company_status_idx").on(table.companyId, table.status),
    companyProjectStatusIdx: index("rt2_v33_contra_candidates_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    companySourcePairUq: uniqueIndex("rt2_v33_contra_candidates_source_pair_uq").on(
      table.companyId,
      table.reasonCode,
      table.sourceType,
      table.sourceId,
      table.conflictingSourceType,
      table.conflictingSourceId,
    ),
  }),
);

export const rt2V33ContradictionResolutions = pgTable(
  "rt2_v33_contradiction_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    candidateId: uuid("candidate_id").notNull().references(() => rt2V33ContradictionCandidates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    decision: text("decision").$type<Rt2ContradictionResolutionDecision>().notNull(),
    reason: text("reason").notNull(),
    followUpIssueId: uuid("follow_up_issue_id"),
    resolvedBy: text("resolved_by").notNull(),
    auditEventId: text("audit_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCandidateIdx: index("rt2_v33_contra_resolutions_candidate_idx").on(table.companyId, table.candidateId),
  }),
);
