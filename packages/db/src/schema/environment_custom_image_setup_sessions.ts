import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type {
  EnvironmentCustomImageSetupConnectionSummary,
  EnvironmentCustomImageSetupSessionStatus,
} from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { environmentLeases } from "./environment_leases.js";
import { environmentCustomImageTemplates } from "./environment_custom_image_templates.js";
import { environments } from "./environments.js";

export const environmentCustomImageSetupSessions = pgTable(
  "environment_custom_image_setup_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
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
    companyEnvironmentStatusIdx: index("environment_custom_image_setup_sessions_company_environment_status_idx").on(
      table.companyId,
      table.environmentId,
      table.status,
    ),
    companyEnvironmentActiveUq: uniqueIndex("environment_custom_image_setup_sessions_company_environment_active_uq")
      .on(table.companyId, table.environmentId)
      .where(sql`${table.status} IN ('starting', 'waiting_for_user', 'capturing')`),
    companyTemplateIdx: index("environment_custom_image_setup_sessions_company_template_idx").on(
      table.companyId,
      table.templateId,
    ),
    companyPromotedTemplateIdx: index("environment_custom_image_setup_sessions_company_promoted_template_idx").on(
      table.companyId,
      table.promotedTemplateId,
    ),
    companyExpiresIdx: index("environment_custom_image_setup_sessions_company_expires_idx").on(
      table.companyId,
      table.expiresAt,
    ),
    providerLeaseIdx: index("environment_custom_image_setup_sessions_provider_lease_idx").on(
      table.provider,
      table.providerLeaseId,
    ),
  }),
);
