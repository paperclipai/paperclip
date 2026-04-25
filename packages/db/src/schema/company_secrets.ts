import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const companySecrets = pgTable(
  "company_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL = instance-scoped. Keep the FK so a non-null company_id still has
    // to reference a real company; only NULL is the new state.
    companyId: uuid("company_id").references(() => companies.id),
    name: text("name").notNull(),
    provider: text("provider").notNull().default("local_encrypted"),
    externalRef: text("external_ref"),
    latestVersion: integer("latest_version").notNull().default(1),
    description: text("description"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secrets_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secrets_company_provider_idx").on(table.companyId, table.provider),
    // Two partial unique indexes keep the per-company-name uniqueness AND a
    // single instance-scope namespace. Postgres treats NULLs as distinct in
    // a regular unique index, so a single combined index would let two
    // instance-scoped rows share a name.
    companyNameUq: uniqueIndex("company_secrets_company_name_uq")
      .on(table.companyId, table.name)
      .where(sql`${table.companyId} IS NOT NULL`),
    instanceNameUq: uniqueIndex("company_secrets_instance_name_uq")
      .on(table.name)
      .where(sql`${table.companyId} IS NULL`),
  }),
);
