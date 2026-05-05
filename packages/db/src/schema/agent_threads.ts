import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentThreads = pgTable(
  "agent_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    status: text("status").notNull().default("active"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_threads_company_agent_idx").on(table.companyId, table.agentId),
    companyStatusLastActivityIdx: index("agent_threads_company_status_last_activity_idx").on(
      table.companyId,
      table.status,
      table.lastActivityAt,
    ),
    companyAgentActiveUnique: uniqueIndex("agent_threads_company_agent_active_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.status} = 'active'`),
  }),
);
