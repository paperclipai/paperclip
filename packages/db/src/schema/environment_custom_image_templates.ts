import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EnvironmentCustomImageTemplateStatus } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { environments } from "./environments.js";

export const environmentCustomImageTemplates = pgTable(
  "environment_custom_image_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id").notNull().references(() => environments.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    templateKind: text("template_kind").notNull().default("unknown"),
    templateRef: text("template_ref").notNull(),
    sourceTemplateRef: text("source_template_ref"),
    sourceEnvironmentConfigFingerprint: text("source_environment_config_fingerprint"),
    status: text("status").$type<EnvironmentCustomImageTemplateStatus>().notNull().default("active"),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    supersededByTemplateId: uuid("superseded_by_template_id")
      .references((): AnyPgColumn => environmentCustomImageTemplates.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEnvironmentStatusIdx: index("environment_custom_image_templates_company_environment_status_idx").on(
      table.companyId,
      table.environmentId,
      table.status,
    ),
    companyProviderStatusIdx: index("environment_custom_image_templates_company_provider_status_idx").on(
      table.companyId,
      table.provider,
      table.status,
    ),
    companyEnvironmentActiveUq: uniqueIndex("environment_custom_image_templates_company_environment_active_uq")
      .on(table.companyId, table.environmentId)
      .where(sql`${table.status} = 'active'`),
    supersededByIdx: index("environment_custom_image_templates_superseded_by_idx").on(table.supersededByTemplateId),
    companyLastUsedIdx: index("environment_custom_image_templates_company_last_used_idx").on(
      table.companyId,
      table.lastUsedAt,
    ),
  }),
);
