import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";
import { agents } from "./agents.js";

export const companyKpis = pgTable(
  "company_kpis",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value: text("value").notNull(),
    trend: text("trend").notNull().default("none"),
    note: text("note"),
    position: integer("position").notNull(),
    updatedByUserId: text("updated_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_kpis_company_idx").on(table.companyId),
    companyUpdatedIdx: index("company_kpis_company_updated_idx").on(table.companyId, table.updatedAt),
    companyPositionUq: uniqueIndex("company_kpis_company_position_uq").on(table.companyId, table.position),
  }),
);
