import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * A person's named delegate agent in one company. While active, the agent may
 * perform an allowlisted set of person-only actions as that person, with a
 * stated reason that is logged before each action. One active delegate per
 * person per company; the person turns it off by revoking the row.
 */
export const userDelegates = pgTable(
  "user_delegates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    delegateAgentId: uuid("delegate_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").$type<"active" | "revoked">().notNull().default("active"),
    createdByUserId: text("created_by_user_id").notNull(),
    revokedByUserId: text("revoked_by_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeCompanyUserUq: uniqueIndex("user_delegates_active_company_user_uq")
      .on(table.companyId, table.userId)
      .where(sql`${table.status} = 'active'`),
    companyAgentIdx: index("user_delegates_company_agent_idx").on(table.companyId, table.delegateAgentId),
    statusCheck: check("user_delegates_status_check", sql`${table.status} in ('active', 'revoked')`),
  }),
);
