import { pgTable, uuid, text, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { rooms } from "./rooms.js";
import { issues } from "./issues.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const roomIssues = pgTable(
  "room_issues",
  {
    roomId: uuid("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    linkedByUserId: text("linked_by_user_id"),
    linkedByAgentId: uuid("linked_by_agent_id").references(() => agents.id),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roomId, table.issueId] }),
    issueIdx: index("room_issues_issue_idx").on(table.issueId),
    companyIdx: index("room_issues_company_idx").on(table.companyId),
  }),
);
