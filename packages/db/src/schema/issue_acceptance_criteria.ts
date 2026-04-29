import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueWorkProducts } from "./issue_work_products.js";
import { issues } from "./issues.js";

export const issueAcceptanceCriteria = pgTable(
  "issue_acceptance_criteria",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    state: text("state").notNull().default("pending"),
    notes: text("notes"),
    position: integer("position").notNull().default(0),
    evidenceWorkProductId: uuid("evidence_work_product_id")
      .references(() => issueWorkProducts.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    resolvedByAgentId: uuid("resolved_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedByRunId: uuid("resolved_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssuePositionIdx: index("issue_acceptance_criteria_company_issue_position_idx").on(
      table.companyId,
      table.issueId,
      table.position,
    ),
    companyIssueStateIdx: index("issue_acceptance_criteria_company_issue_state_idx").on(
      table.companyId,
      table.issueId,
      table.state,
    ),
    evidenceIdx: index("issue_acceptance_criteria_evidence_idx").on(table.evidenceWorkProductId),
  }),
);
