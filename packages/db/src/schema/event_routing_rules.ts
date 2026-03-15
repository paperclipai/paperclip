import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { webhookEndpoints } from "./webhook_endpoints.js";

export const eventRoutingRules = pgTable(
  "event_routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("webhook"), // "webhook" | "internal"
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100),
    condition: jsonb("condition").$type<Record<string, unknown>>().notNull().default({}),
    action: jsonb("action").$type<Record<string, unknown>>().notNull().default({}),
    cooldownSec: integer("cooldown_sec").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnabledPriorityIdx: index("event_routing_rules_company_enabled_priority_idx").on(
      table.companyId,
      table.enabled,
      table.priority,
      table.createdAt,
    ),
    endpointIdx: index("event_routing_rules_endpoint_idx").on(table.endpointId, table.enabled, table.priority),
    sourceIdx: index("event_routing_rules_source_idx").on(table.companyId, table.source, table.enabled, table.priority),
  }),
);
