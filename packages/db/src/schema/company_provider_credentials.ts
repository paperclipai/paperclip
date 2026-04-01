import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companyProviderCredentials = pgTable(
  "company_provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    envKey: text("env_key").notNull(),
    label: text("label").notNull(),
    secretId: uuid("secret_id")
      .notNull()
      .references(() => companySecrets.id, { onDelete: "cascade" }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    companyProviderIdx: index("company_provider_credentials_company_provider_idx").on(
      table.companyId,
      table.provider,
    ),
    secretIdx: index("company_provider_credentials_secret_idx").on(table.secretId),
    companyProviderLabelUq: uniqueIndex(
      "company_provider_credentials_company_provider_label_uq",
    ).on(table.companyId, table.provider, table.label),
    companyProviderSecretUq: uniqueIndex(
      "company_provider_credentials_company_provider_secret_uq",
    ).on(table.companyId, table.provider, table.secretId),
    companyProviderDefaultUq: uniqueIndex(
      "company_provider_credentials_company_provider_default_uq",
    )
      .on(table.companyId, table.provider)
      .where(sql`${table.isDefault} = true`),
  }),
);
