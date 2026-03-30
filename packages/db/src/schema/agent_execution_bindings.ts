import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentExecutionBindings = pgTable(
  "agent_execution_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    bindingType: text("binding_type").notNull(),
    providerType: text("provider_type").notNull(),
    providerRef: text("provider_ref"),
    status: text("status").notNull().default("active"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentStatusIdx: index("agent_execution_bindings_company_agent_status_idx").on(
      table.companyId,
      table.agentId,
      table.status,
    ),
    companyProviderStatusIdx: index("agent_execution_bindings_company_provider_status_idx").on(
      table.companyId,
      table.providerType,
      table.status,
    ),
    agentBindingTypeIdx: index("agent_execution_bindings_agent_binding_type_idx").on(
      table.agentId,
      table.bindingType,
      table.status,
    ),
  }),
);
