import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { pipelineCases } from "./pipeline_cases.js";
import { pipelineStages } from "./pipelines.js";

export const pipelineCaseEvents = pgTable(
  "pipeline_case_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id"),
    fromStageId: uuid("from_stage_id").references(() => pipelineStages.id, { onDelete: "set null" }),
    toStageId: uuid("to_stage_id").references(() => pipelineStages.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseCreatedIdx: index("pipeline_case_events_case_created_idx").on(table.caseId, table.createdAt),
    companyCaseIdx: index("pipeline_case_events_company_case_idx").on(table.companyId, table.caseId),
    typeCheck: check(
      "pipeline_case_events_type_check",
      sql`${table.type} in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_forced',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'issue_unlinked',
        'automation_executed',
        'automation_failed',
        'automation_retry_requested',
        'automation_effects_retired',
        'automation_retry_dispatched',
        'blockers_set',
        'blockers_resolved',
        'children_terminal',
        'upstream_drift',
        'drift_acknowledged'
      )`,
    ),
    actorTypeCheck: check("pipeline_case_events_actor_type_check", sql`${table.actorType} in ('user', 'agent', 'system')`),
    agentRunCheck: check("pipeline_case_events_agent_run_check", sql`${table.actorType} <> 'agent' or ${table.runId} is not null`),
  }),
);
