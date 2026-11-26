import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  EnvironmentCustomImageSetupConnectionSummary,
  EnvironmentCustomImageSetupSessionStatus,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { environmentLeases } from "./environment_leases.js";
import { environmentCustomImageTemplates } from "./environment_custom_image_templates.js";
import { environments } from "./environments.js";

export const environmentCustomImageSetupSessions = pgTable(
  "environment_custom_image_setup_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => environmentCustomImageTemplates.id, { onDelete: "set null" }),
    promotedTemplateId: uuid("promoted_template_id")
      .references(() => environmentCustomImageTemplates.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    providerLeaseId: text("provider_lease_id"),
    environmentLeaseId: uuid("environment_lease_id").references(() => environmentLeases.id, { onDelete: "set null" }),
    status: text("status").$type<EnvironmentCustomImageSetupSessionStatus>().notNull().default("starting"),
    startedByUserId: text("started_by_user_id"),
    startedByAgentId: uuid("started_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    baseTemplateRef: text("base_template_ref"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    connectionSummary: jsonb("connection_summary").$type<EnvironmentCustomImageSetupConnectionSummary | null>(),
    connectionSecretRef: text("connection_secret_ref"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    environmentStatusIdx: index("environment_custom_image_setup_sessions_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
    environmentActiveUq: uniqueIndex("environment_custom_image_setup_sessions_environment_active_uq")
      .on(table.environmentId)
      .where(sql`${table.status} IN ('starting', 'waiting_for_user', 'capturing')`),
    templateIdx: index("environment_custom_image_setup_sessions_template_idx").on(table.templateId),
    promotedTemplateIdx: index("environment_custom_image_setup_sessions_promoted_template_idx")
      .on(table.promotedTemplateId),
    expiresIdx: index("environment_custom_image_setup_sessions_expires_idx").on(table.expiresAt),
    providerLeaseIdx: index("environment_custom_image_setup_sessions_provider_lease_idx").on(
      table.provider,
      table.providerLeaseId,
    ),
  }),
);
