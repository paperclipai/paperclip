import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Instance-scoped audit stream for actions that have no company home
 * (adapter lifecycle, instance DB backups, instance-admin changes) or that
 * must outlive their company scope (company deletion).
 *
 * Deliberately FK-free: rows must survive deletion of the company, agent,
 * or run they reference. `companyId`/`agentId`/`runId` are context columns,
 * not relational constraints.
 */
export const instanceActivityLog = pgTable(
  "instance_activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // "user" | "agent" | "system" | "pre_auth" — pre_auth models callers on
    // unauthenticated surfaces (dev-server restart in local_trusted,
    // smoke-lab OAuth, bootstrap/cli-auth flows) instead of faking a user.
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    // How the actor authenticated: session | board_key | local_implicit |
    // cloud_tenant | agent_key | agent_jwt | dev_server_token | unauthenticated
    actorSource: text("actor_source"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    companyId: uuid("company_id"),
    agentId: uuid("agent_id"),
    runId: uuid("run_id"),
    responsibleUserId: text("responsible_user_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index("instance_activity_log_created_idx").on(table.createdAt),
    actionCreatedIdx: index("instance_activity_log_action_created_idx").on(table.action, table.createdAt),
    companyCreatedIdx: index("instance_activity_log_company_created_idx").on(table.companyId, table.createdAt),
    entityIdx: index("instance_activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
  }),
);
