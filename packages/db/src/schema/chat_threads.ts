import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    title: text("title"),
    status: text("status").notNull().default("open"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("chat_threads_company_idx").on(table.companyId),
    companyIssueIdx: index("chat_threads_company_issue_idx").on(table.companyId, table.issueId),
    companyStatusIdx: index("chat_threads_company_status_idx").on(table.companyId, table.status),
    companyCreatedAtIdx: index("chat_threads_company_created_at_idx").on(
      table.companyId,
      table.createdAt,
    ),
  }),
);
