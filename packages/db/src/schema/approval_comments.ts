import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const approvalComments = pgTable(
  "approval_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("approval_comments_company_idx").on(table.companyId),
    approvalIdx: index("approval_comments_approval_idx").on(table.approvalId),
    approvalCreatedIdx: index("approval_comments_approval_created_idx").on(
      table.approvalId,
      table.createdAt,
    ),
    idempotencyKeyIdx: uniqueIndex("approval_comments_idempotency_key_uq").on(table.idempotencyKey).where(sql`"idempotency_key" IS NOT NULL`),
  }),
);
