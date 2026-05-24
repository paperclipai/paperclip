import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const tokenCapResets = pgTable(
  "token_cap_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    month: date("month").notNull(),
    offsetTokens: bigint("offset_tokens", { mode: "number" }).notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    authorizedByUserId: text("authorized_by_user_id"),
    authorizedByAgentId: uuid("authorized_by_agent_id").references(() => agents.id),
    recoverIssueId: uuid("recover_issue_id").references(() => issues.id),
  },
  (table) => ({
    companyAgentMonthIdx: index("token_cap_resets_company_agent_month_idx").on(
      table.companyId,
      table.agentId,
      table.month,
    ),
    exactlyOneAuthorizedBy: check(
      "token_cap_resets_exactly_one_authorized_by",
      sql`(${table.authorizedByUserId} IS NOT NULL)::int + (${table.authorizedByAgentId} IS NOT NULL)::int = 1`,
    ),
  }),
);
