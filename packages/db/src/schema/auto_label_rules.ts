import { pgTable, uuid, text, timestamp, boolean, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { labels } from "./labels.js";
import { issues } from "./issues.js";

export const autoLabelRules = pgTable(
  "auto_label_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    triggerEvent: text("trigger_event").notNull(),
    conditionExpression: text("condition_expression").notNull(),
    action: text("action").notNull(),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull().default(0),
    createdByUserId: uuid("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("auto_label_rules_company_idx").on(table.companyId),
    companyTriggerIdx: index("auto_label_rules_company_trigger_idx").on(table.companyId, table.triggerEvent),
    companyNameIdx: uniqueIndex("auto_label_rules_company_name_idx").on(table.companyId, table.name),
  }),
);

export const autoLabelRuleExecutions = pgTable(
  "auto_label_rule_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").notNull().references(() => autoLabelRules.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    triggerEventType: text("trigger_event_type").notNull(),
    conditionResult: boolean("condition_result").notNull(),
    actionTaken: text("action_taken"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    ruleIdx: index("auto_label_rule_executions_rule_idx").on(table.ruleId),
    issueIdx: index("auto_label_rule_executions_issue_idx").on(table.issueId),
  }),
);
