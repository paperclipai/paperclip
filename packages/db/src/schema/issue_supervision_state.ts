import { index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const issueSupervisionState = pgTable(
  "issue_supervision_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    reflectionAttemptCount: integer("reflection_attempt_count").notNull().default(0),
    lastEvaluationId: uuid("last_evaluation_id"),
    lastScore: integer("last_score"),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueUnique: uniqueIndex("issue_supervision_state_issue_uq").on(table.issueId),
    companyIssueIdx: index("issue_supervision_state_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
