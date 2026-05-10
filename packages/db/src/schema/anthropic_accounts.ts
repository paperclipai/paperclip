import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, numeric, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const anthropicAccounts = pgTable(
  "anthropic_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    mode: text("mode").notNull(),
    credentialDir: text("credential_dir"),
    apiKeySecretId: uuid("api_key_secret_id").references(() => companySecrets.id, {
      onDelete: "set null",
    }),
    lastQuotaCheckAt: timestamp("last_quota_check_at", { withTimezone: true }),
    lastUtilizationFiveHour: numeric("last_utilization_five_hour"),
    lastUtilizationSevenDay: numeric("last_utilization_seven_day"),
    lastQuotaError: text("last_quota_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("anthropic_accounts_company_idx").on(table.companyId),
    modeCheck: check(
      "anthropic_accounts_mode_check",
      sql`${table.mode} IN ('oauth', 'api_key', 'bedrock')`,
    ),
  }),
);

export type AnthropicAccount = typeof anthropicAccounts.$inferSelect;
export type NewAnthropicAccount = typeof anthropicAccounts.$inferInsert;
