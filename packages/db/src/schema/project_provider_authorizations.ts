import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { connectionGrants } from "./tool_access.js";
import { projects } from "./projects.js";

export const projectProviderAuthorizations = pgTable(
  "project_provider_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull(),
    provider: text("provider").notNull(),
    scopeKey: text("scope_key").notNull(),
    grantId: uuid("grant_id").notNull(),
    authorizedByUserId: text("authorized_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  table => [
    uniqueIndex("project_provider_authorizations_project_provider_scope_uq").on(table.projectId, table.provider, table.scopeKey),
    index("project_provider_authorizations_company_project_idx").on(table.companyId, table.projectId),
    check("project_provider_authorizations_provider_check", sql`${table.provider} ~ '^[a-z][a-z0-9-]{0,31}$'`),
    foreignKey({
      columns: [table.companyId, table.projectId],
      foreignColumns: [projects.companyId, projects.id],
      name: "project_provider_authorizations_company_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.companyId, table.grantId],
      foreignColumns: [connectionGrants.companyId, connectionGrants.id],
      name: "project_provider_authorizations_company_grant_fk",
    }).onDelete("cascade"),
  ],
);
