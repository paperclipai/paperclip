import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DecisionQueueSeedRule } from "@paperclipai/shared";
import { agentApiKeys } from "./agent_api_keys.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const decisionQueues = pgTable(
  "decision_queues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    createdByType: text("created_by_type").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id),
    createdByAgentApiKeyId: uuid("created_by_agent_api_key_id").references(() => agentApiKeys.id),
    retentionDays: integer("retention_days"),
    seedRules: jsonb("seed_rules").$type<DecisionQueueSeedRule[]>().notNull().default([]),
    seedRulesEnabled: boolean("seed_rules_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("decision_queues_company_key_uq").on(table.companyId, table.key),
    companyUpdatedIdx: index("decision_queues_company_updated_idx").on(table.companyId, table.updatedAt),
    idCompanyUq: unique("decision_queues_id_company_uq").on(table.id, table.companyId),
    creatorCheck: check(
      "decision_queues_creator_check",
      sql`(
        (${table.createdByType} = 'agent' AND ${table.createdByAgentId} IS NOT NULL AND ${table.createdByUserId} IS NULL)
        OR (${table.createdByType} = 'user' AND ${table.createdByAgentId} IS NULL AND ${table.createdByUserId} IS NOT NULL)
        OR (${table.createdByType} = 'system' AND ${table.createdByAgentId} IS NULL AND ${table.createdByUserId} IS NULL)
      )`,
    ),
    retentionDaysCheck: check(
      "decision_queues_retention_days_check",
      sql`${table.retentionDays} IS NULL OR (${table.retentionDays} >= 1 AND ${table.retentionDays} <= 3650)`,
    ),
  }),
);

export const decisionQueueItems = pgTable(
  "decision_queue_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queueId: uuid("queue_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    addedByType: text("added_by_type").notNull(),
    addedByAgentId: uuid("added_by_agent_id").references(() => agents.id),
    addedByUserId: text("added_by_user_id"),
    addedByRunId: uuid("added_by_run_id").references(() => heartbeatRuns.id),
    addedByAgentApiKeyId: uuid("added_by_agent_api_key_id").references(() => agentApiKeys.id),
    responsibleUserId: text("responsible_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    queueSourceUq: uniqueIndex("decision_queue_items_queue_source_uq").on(
      table.queueId,
      table.sourceKind,
      table.sourceId,
    ),
    companySourceIdx: index("decision_queue_items_company_source_idx").on(
      table.companyId,
      table.sourceKind,
      table.sourceId,
    ),
    queueCompanyFk: foreignKey({
      columns: [table.queueId, table.companyId],
      foreignColumns: [decisionQueues.id, decisionQueues.companyId],
      name: "decision_queue_items_queue_company_fk",
    }).onDelete("cascade"),
    actorCheck: check(
      "decision_queue_items_actor_check",
      sql`(
        (${table.addedByType} = 'agent' AND ${table.addedByAgentId} IS NOT NULL AND ${table.addedByUserId} IS NULL)
        OR (${table.addedByType} = 'user' AND ${table.addedByAgentId} IS NULL AND ${table.addedByUserId} IS NOT NULL)
        OR (${table.addedByType} = 'system' AND ${table.addedByAgentId} IS NULL AND ${table.addedByUserId} IS NULL)
      )`,
    ),
  }),
);

export const decisionTriage = pgTable(
  "decision_triage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    decideBy: text("decide_by"),
    decideByDate: date("decide_by_date"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    setByType: text("set_by_type").notNull(),
    setByAgentId: uuid("set_by_agent_id").references(() => agents.id),
    setByUserId: text("set_by_user_id"),
    setByRunId: uuid("set_by_run_id").references(() => heartbeatRuns.id),
    setByAgentApiKeyId: uuid("set_by_agent_api_key_id").references(() => agentApiKeys.id),
    responsibleUserId: text("responsible_user_id"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceUq: uniqueIndex("decision_triage_company_source_uq").on(
      table.companyId,
      table.sourceKind,
      table.sourceId,
    ),
    companyDecideByIdx: index("decision_triage_company_decide_by_idx").on(table.companyId, table.decideBy),
    actorCheck: check(
      "decision_triage_actor_check",
      sql`(
        (${table.setByType} = 'agent' AND ${table.setByAgentId} IS NOT NULL AND ${table.setByUserId} IS NULL)
        OR (${table.setByType} = 'user' AND ${table.setByAgentId} IS NULL AND ${table.setByUserId} IS NOT NULL)
      )`,
    ),
    decideByCheck: check(
      "decision_triage_decide_by_check",
      sql`(
        (${table.decideBy} IS NULL AND ${table.decideByDate} IS NULL)
        OR (${table.decideBy} IN ('today', 'this_week', 'whenever') AND ${table.decideByDate} IS NULL)
        OR (${table.decideBy} = 'date' AND ${table.decideByDate} IS NOT NULL)
      )`,
    ),
  }),
);

export const decisionTriageEvents = pgTable(
  "decision_triage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    queueId: uuid("queue_id").references(() => decisionQueues.id),
    sourceKind: text("source_kind"),
    sourceId: text("source_id"),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id),
    actorUserId: text("actor_user_id"),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id),
    agentApiKeyId: uuid("agent_api_key_id").references(() => agentApiKeys.id),
    responsibleUserId: text("responsible_user_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceCreatedIdx: index("decision_triage_events_company_source_created_idx").on(
      table.companyId,
      table.sourceKind,
      table.sourceId,
      table.createdAt,
    ),
    queueCreatedIdx: index("decision_triage_events_queue_created_idx").on(table.queueId, table.createdAt),
    actorCheck: check(
      "decision_triage_events_actor_check",
      sql`(
        (${table.actorType} = 'agent' AND ${table.actorAgentId} IS NOT NULL AND ${table.actorUserId} IS NULL)
        OR (${table.actorType} = 'user' AND ${table.actorAgentId} IS NULL AND ${table.actorUserId} IS NOT NULL)
        OR (${table.actorType} = 'system' AND ${table.actorAgentId} IS NULL AND ${table.actorUserId} IS NULL)
      )`,
    ),
  }),
);
