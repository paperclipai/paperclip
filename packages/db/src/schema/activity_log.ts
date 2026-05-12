import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    commentAddedCommentIdUq: uniqueIndex("activity_log_comment_added_comment_id_uq")
      .on(table.action, table.entityType, table.entityId, sql`(${table.details} ->> 'commentId')`)
      .where(sql`${table.action} in ('issue.comment_added', 'approval.comment_added') and ${table.details} ? 'commentId'`),
    threadInteractionExpiredInteractionIdUq: uniqueIndex("activity_log_thread_interaction_expired_interaction_id_uq")
      .on(table.action, table.entityType, table.entityId, sql`(${table.details} ->> 'interactionId')`)
      .where(sql`${table.action} = 'issue.thread_interaction_expired' and ${table.details} ? 'interactionId'`),
  }),
);
