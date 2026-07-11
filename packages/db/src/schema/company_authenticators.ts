import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { agents } from "./agents.js";

/** Company-scoped TOTP records; the seed remains in the referenced encrypted secret. */
export const companyAuthenticators = pgTable(
  "company_authenticators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    issuer: text("issuer"),
    accountName: text("account_name"),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "restrict" }),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_authenticators_company_idx").on(table.companyId),
    companyNameUq: uniqueIndex("company_authenticators_company_name_uq").on(table.companyId, table.name),
  }),
);

export const companyAuthenticatorAgents = pgTable(
  "company_authenticator_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    authenticatorId: uuid("authenticator_id").notNull().references(() => companyAuthenticators.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    authenticatorIdx: index("company_authenticator_agents_authenticator_idx").on(table.authenticatorId),
    uniqueBinding: uniqueIndex("company_authenticator_agents_unique_uq").on(table.authenticatorId, table.agentId),
  }),
);
