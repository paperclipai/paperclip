import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentPermissionGrants = pgTable(
  "agent_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    granteeId: uuid("grantee_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueGrantIdx: uniqueIndex("agent_permission_grants_unique_idx").on(
      table.companyId,
      table.granteeId,
      table.agentId,
      table.permission,
    ),
    granteeIdx: index("agent_permission_grants_grantee_idx").on(table.granteeId),
    agentIdx: index("agent_permission_grants_agent_idx").on(table.agentId),
  }),
);
