import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const companySecretDeploymentAssertions = pgTable(
  "company_secret_deployment_assertions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    expectedLatestVersion: integer("expected_latest_version").notNull(),
    valueFingerprintSha256: text("value_fingerprint_sha256").notNull(),
    previousValueFingerprintSha256: text("previous_value_fingerprint_sha256").notNull(),
    assertedByAgentId: uuid("asserted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    originRunId: uuid("origin_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    originIssueId: uuid("origin_issue_id").references(() => issues.id, { onDelete: "set null" }),
    deploymentLabel: text("deployment_label").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    secretStatusIdx: index("company_secret_deployment_assertions_secret_status_idx")
      .on(table.secretId, table.status),
    expiryIdx: index("company_secret_deployment_assertions_expiry_idx")
      .on(table.status, table.expiresAt),
    companyIdx: index("company_secret_deployment_assertions_company_idx").on(table.companyId),
    statusCheck: check(
      "company_secret_deployment_assertions_status_check",
      sql`${table.status} in ('pending', 'verified', 'consumed', 'expired')`,
    ),
    fingerprintCheck: check(
      "company_secret_deployment_assertions_fingerprint_check",
      sql`${table.valueFingerprintSha256} <> ${table.previousValueFingerprintSha256}`,
    ),
  }),
);
