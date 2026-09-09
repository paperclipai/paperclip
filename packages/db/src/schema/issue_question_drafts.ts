import type { AskUserQuestionsAnswer } from "@paperclipai/shared";
import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";

/**
 * Durable, private per-human drafts for pending `ask_user_questions`
 * interactions (COD-69). One row per (company, interaction, user): the draft
 * survives reloads and server restarts while the originating worker is gone.
 *
 * Drafts are never exposed through the general issue/interaction list APIs and
 * are only readable by the owning human through the narrow draft endpoints.
 * Once the interaction leaves `pending`, rows are ignored (reads 404, writes
 * 409) and the submitted `interaction.result` stays authoritative.
 */
export const issueQuestionDrafts = pgTable(
  "issue_question_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    interactionId: uuid("interaction_id").notNull().references(() => issueThreadInteractions.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    answers: jsonb("answers").$type<AskUserQuestionsAnswer[]>().notNull().default([]),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueIdx: index("issue_question_drafts_company_issue_idx").on(table.companyId, table.issueId),
    companyInteractionUserUq: uniqueIndex("issue_question_drafts_company_interaction_user_uq").on(
      table.companyId,
      table.interactionId,
      table.userId,
    ),
  }),
);
