import type { IssueReportPayload } from "@paperclipai/shared";
import { boolean, index, jsonb, pgTable, timestamp, uniqueIndex, uuid, text } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueReports = pgTable(
  "issue_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    targetIssueId: uuid("target_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    originIssueId: uuid("origin_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    originRunId: uuid("origin_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    originAgentId: uuid("origin_agent_id").notNull().references(() => agents.id),
    fingerprint: text("fingerprint").notNull(),
    payload: jsonb("payload").$type<IssueReportPayload>().notNull(),
    wakeRequested: boolean("wake_requested").notNull().default(false),
    consumedByRunId: uuid("consumed_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deliveryFingerprintUq: uniqueIndex("issue_reports_delivery_fingerprint_uq").on(
      table.companyId,
      table.originIssueId,
      table.targetIssueId,
      table.fingerprint,
    ),
    targetPendingIdx: index("issue_reports_target_pending_idx").on(
      table.companyId,
      table.targetIssueId,
      table.consumedAt,
      table.createdAt,
    ),
  }),
);
