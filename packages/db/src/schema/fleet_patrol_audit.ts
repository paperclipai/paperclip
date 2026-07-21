import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Security audit for the default-off fleet-patrol remediation capability.
 *
 * Deliberately has no foreign keys: deleting an agent, run, target, or company
 * must not erase or rewrite the security record. Migration-level triggers make
 * this table append-only.
 */
export const fleetPatrolAudit = pgTable(
  "fleet_patrol_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    authenticatedAgentId: uuid("authenticated_agent_id").notNull(),
    authenticatedRunId: uuid("authenticated_run_id").notNull(),
    apiKeyId: text("api_key_id"),
    credentialId: text("credential_id").notNull(),
    operation: text("operation").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("fleet_patrol_audit_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    runCreatedIdx: index("fleet_patrol_audit_run_created_idx").on(
      table.authenticatedRunId,
      table.createdAt,
    ),
    targetCreatedIdx: index("fleet_patrol_audit_target_created_idx").on(
      table.targetType,
      table.targetId,
      table.createdAt,
    ),
  }),
);
