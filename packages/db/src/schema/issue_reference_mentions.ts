import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueReferenceMentions = pgTable(
  "issue_reference_mentions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<"title" | "description" | "comment" | "document">().notNull(),
    sourceRecordId: uuid("source_record_id"),
    documentKey: text("document_key"),
    matchedText: text("matched_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceIssueIdx: index("issue_reference_mentions_company_source_issue_idx").on(
      table.companyId,
      table.sourceIssueId,
    ),
    companyTargetIssueIdx: index("issue_reference_mentions_company_target_issue_idx").on(
      table.companyId,
      table.targetIssueId,
    ),
    companyIssuePairIdx: index("issue_reference_mentions_company_issue_pair_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.targetIssueId,
    ),
    companySourceMentionWithRecordUq: uniqueIndex("issue_reference_mentions_company_source_mention_record_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.targetIssueId,
      table.sourceKind,
      table.sourceRecordId,
    ).where(sql`${table.sourceRecordId} is not null`),
    companySourceMentionWithoutRecordUq: uniqueIndex("issue_reference_mentions_company_source_mention_null_record_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.targetIssueId,
      table.sourceKind,
    ).where(sql`${table.sourceRecordId} is null`),
  }),
);
