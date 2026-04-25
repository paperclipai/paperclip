import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const prCiStatus = pgTable(
  "pr_ci_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    repositoryFullName: text("repository_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    workflowRunId: text("workflow_run_id"),
    checkRunId: text("check_run_id"),
    checkRunName: text("check_run_name"),
    conclusion: text("conclusion"),
    status: text("status"),
    url: text("url"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRepoPrIdx: index("pr_ci_status_company_repo_pr_idx").on(
      table.companyId,
      table.repositoryFullName,
      table.prNumber,
    ),
    headShaIdx: index("pr_ci_status_head_sha_idx").on(table.headSha),
    workflowRunIdIdx: uniqueIndex("pr_ci_status_workflow_run_id_idx").on(table.workflowRunId),
    checkRunIdIdx: uniqueIndex("pr_ci_status_check_run_id_idx").on(table.checkRunId),
  }),
);