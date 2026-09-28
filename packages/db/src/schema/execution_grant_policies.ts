import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/** Board-owned authority anchor. Agents cannot appoint their own approver. */
export const executionGrantPolicies = pgTable("execution_grant_policies", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id),
  stewardAgentId: uuid("steward_agent_id").notNull().references(() => agents.id),
  version: integer("version").notNull().default(1),
  updatedByUserId: text("updated_by_user_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
