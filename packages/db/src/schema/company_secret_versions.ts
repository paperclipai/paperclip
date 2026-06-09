import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companySecrets } from "./company_secrets.js";

export const companySecretVersions = pgTable(
  "company_secret_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    material: jsonb("material").$type<Record<string, unknown>>().notNull(),
    valueSha256: text("value_sha256").notNull(),
    providerVersionRef: text("provider_version_ref"),
    status: text("status").notNull().default("current"),
    fingerprintSha256: text("fingerprint_sha256").notNull(),
    rotationJobId: text("rotation_job_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    secretIdx: index("company_secret_versions_secret_idx").on(table.secretId, table.createdAt),
    valueHashIdx: index("company_secret_versions_value_sha256_idx").on(table.valueSha256),
    fingerprintIdx: index("company_secret_versions_fingerprint_idx").on(table.fingerprintSha256),
    secretVersionUq: uniqueIndex("company_secret_versions_secret_version_uq").on(table.secretId, table.version),
  }),
);
