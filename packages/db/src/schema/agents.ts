import {
  type AnyPgColumn,
  check,
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    role: text("role").notNull().default("general"),
    title: text("title"),
    icon: text("icon"),
    status: text("status").notNull().default("idle"),
    reportsTo: uuid("reports_to").references((): AnyPgColumn => agents.id),
    capabilities: text("capabilities"),
    adapterType: text("adapter_type").notNull().default("process"),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    errorReason: text("error_reason"),
    executionFenceId: uuid("execution_fence_id"),
    executionFencePriorStatus: text("execution_fence_prior_status"),
    executionFencePriorPauseReason: text("execution_fence_prior_pause_reason"),
    executionFencePriorPausedAt: timestamp("execution_fence_prior_paused_at", { withTimezone: true }),
    executionFenceRestoreStatus: text("execution_fence_restore_status"),
    executionFenceReason: text("execution_fence_reason"),
    executionFenceActorUserId: text("execution_fence_actor_user_id"),
    executionFenceAcquiredAt: timestamp("execution_fence_acquired_at", { withTimezone: true }),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("agents_company_status_idx").on(table.companyId, table.status),
    companyReportsToIdx: index("agents_company_reports_to_idx").on(table.companyId, table.reportsTo),
    companyDefaultEnvironmentIdx: index("agents_company_default_environment_idx").on(table.companyId, table.defaultEnvironmentId),
    executionFenceStateCheck: check(
      "agents_execution_fence_state_check",
      sql`(
        ${table.executionFenceId} is null
        and ${table.executionFencePriorStatus} is null
        and ${table.executionFencePriorPauseReason} is null
        and ${table.executionFencePriorPausedAt} is null
        and ${table.executionFenceRestoreStatus} is null
        and ${table.executionFenceReason} is null
        and ${table.executionFenceActorUserId} is null
        and ${table.executionFenceAcquiredAt} is null
      ) or (
        ${table.executionFenceId} is not null
        and ${table.status} = 'paused'
        and ${table.executionFencePriorStatus} is not null
        and ${table.executionFenceRestoreStatus} is not null
        and ${table.executionFenceReason} is not null
        and ${table.executionFenceAcquiredAt} is not null
      )`,
    ),
  }),
);
