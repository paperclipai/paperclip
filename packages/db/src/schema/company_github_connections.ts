import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyGithubConnections = pgTable(
  "company_github_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hostname: text("hostname").notNull().default("github.com"),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id),
    enabled: boolean("enabled").notNull().default(true),
    accountLogin: text("account_login"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestStatus: text("last_test_status"),
    lastTestMessage: text("last_test_message"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_github_connections_company_idx").on(table.companyId),
    secretIdx: index("company_github_connections_secret_idx").on(table.secretId),
    companyNameUq: uniqueIndex("company_github_connections_company_name_uq").on(table.companyId, table.name),
  }),
);
