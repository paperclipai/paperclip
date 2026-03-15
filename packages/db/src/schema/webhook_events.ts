import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { webhookEndpoints } from "./webhook_endpoints.js";
import { eventRoutingRules } from "./event_routing_rules.js";

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").references(() => webhookEndpoints.id, { onDelete: "set null" }),
    matchedRuleId: uuid("matched_rule_id").references(() => eventRoutingRules.id, { onDelete: "set null" }),
    source: text("source").notNull().default("webhook"), // "webhook" | "internal"
    provider: text("provider").notNull().default("generic"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    headers: jsonb("headers").$type<Record<string, unknown>>(),
    resultAction: jsonb("result_action").$type<Record<string, unknown>>(),
    status: text("status").notNull().default("received"), // received | matched | dispatched | ignored | error
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("webhook_events_company_created_idx").on(table.companyId, table.createdAt),
    endpointCreatedIdx: index("webhook_events_endpoint_created_idx").on(table.endpointId, table.createdAt),
    companyStatusCreatedIdx: index("webhook_events_company_status_created_idx").on(
      table.companyId,
      table.status,
      table.createdAt,
    ),
    companyTypeCreatedIdx: index("webhook_events_company_type_created_idx").on(
      table.companyId,
      table.eventType,
      table.createdAt,
    ),
  }),
);
