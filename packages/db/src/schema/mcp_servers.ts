import { pgTable, uuid, text, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    description: text("description"),
    transportType: text("transport_type").notNull().default("stdio"),
    command: text("command"),
    args: jsonb("args").$type<string[]>().default([]),
    url: text("url"),
    headers: jsonb("headers").$type<Record<string, unknown>>().default({}),
    env: jsonb("env").$type<Record<string, unknown>>().default({}),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("mcp_servers_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("mcp_servers_company_name_uq").on(table.companyId, table.name),
  }),
);
