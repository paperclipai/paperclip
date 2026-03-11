import { pgTable, uuid, text, boolean, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const jiraIntegrations = pgTable(
  "jira_integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    hostUrl: text("host_url").notNull(),
    usernameOrEmail: text("username_or_email").notNull(),
    credentialSecretId: uuid("credential_secret_id").notNull().references(() => companySecrets.id),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("jira_integrations_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("jira_integrations_company_name_uq").on(table.companyId, table.name),
  }),
);
