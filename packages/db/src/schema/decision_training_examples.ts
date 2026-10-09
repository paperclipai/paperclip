import type {
  DecisionTrainingNotesHistoryEntry,
  DecisionTrainingRetentionPolicy,
  DecisionTrainingSnapshotV1,
  DecisionTrainingSourceKind,
} from "@paperclipai/shared";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const decisionTrainingExamples = pgTable(
  "decision_training_examples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<DecisionTrainingSourceKind>().notNull(),
    sourceId: uuid("source_id").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }).notNull(),
    notes: text("notes").notNull().default(""),
    notesHistory: jsonb("notes_history").$type<DecisionTrainingNotesHistoryEntry[]>().notNull().default([]),
    decisionOutcome: text("decision_outcome"),
    retentionPolicy: text("retention_policy")
      .$type<DecisionTrainingRetentionPolicy>()
      .notNull()
      .default("scrub_deleted_comments_v1"),
    snapshot: jsonb("snapshot").$type<DecisionTrainingSnapshotV1>().notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedAtIdx: index("decision_training_examples_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
    issueIdx: index("decision_training_examples_issue_idx").on(table.issueId),
    sourceAuthorUq: uniqueIndex("decision_training_examples_source_author_uq").on(
      table.sourceKind,
      table.sourceId,
      table.createdByUserId,
    ),
  }),
);
