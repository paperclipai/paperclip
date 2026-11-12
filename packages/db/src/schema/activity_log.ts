import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    responsibleUserId: text("responsible_user_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    companyAgentCreatedIdx: index("activity_log_company_agent_created_idx").on(
      table.companyId,
      table.agentId,
      table.createdAt,
    ),
    companyResponsibleUserCreatedIdx: index("activity_log_company_responsible_user_created_idx").on(
      table.companyId,
      table.responsibleUserId,
      table.createdAt,
    ),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    companyEntityCreatedIdx: index("activity_log_company_entity_created_idx").on(
      table.companyId,
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
    companyUserIssueActorIdx: index("activity_log_company_user_issue_actor_idx")
      .on(table.companyId, table.actorId, table.entityId)
      .where(sql`${table.actorType} = 'user' AND ${table.entityType} = 'issue'`),
    // Receipts for the person a card was for (PAP-749 plan §6): the For you
    // feed reads the last 7 days of entries that name `handledForUserId`.
    companyHandledForCreatedIdx: index("activity_log_company_handled_for_created_idx")
      .on(table.companyId, sql`(${table.details} ->> 'handledForUserId')`, table.createdAt)
      .where(sql`(${table.details} ->> 'handledForUserId') IS NOT NULL`),
  }),
);
