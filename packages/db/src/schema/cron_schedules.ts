import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const cronSchedules = pgTable(
  "cron_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    expression: text("expression").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    issueMode: text("issue_mode").notNull().default("create_new"),
    issueTemplate: jsonb("issue_template").$type<Record<string, unknown>>().notNull().default({}),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    nextTriggerAt: timestamp("next_trigger_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnabledNextIdx: index("cron_schedules_company_enabled_next_idx").on(
      table.companyId,
      table.enabled,
      table.nextTriggerAt,
    ),
    agentEnabledNextIdx: index("cron_schedules_agent_enabled_next_idx").on(
      table.agentId,
      table.enabled,
      table.nextTriggerAt,
    ),
    issueIdx: index("cron_schedules_issue_idx").on(table.issueId),
  }),
);
