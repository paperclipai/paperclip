import { date, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const tokenCapWarnings = pgTable(
  "token_cap_warnings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    month: date("month").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    agentMonthUniq: uniqueIndex("token_cap_warnings_agent_month_uniq").on(table.agentId, table.month),
  }),
);
