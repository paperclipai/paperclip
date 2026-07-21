import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

/**
 * Per-company "connect your repo" configuration for the managed state repo
 * (PAP-14639 P3 user-remote mirror). Holds the mirror remote URL plus a
 * reference to the company secret carrying the push token — the token value
 * itself is never stored here, only the secret binding.
 */
export const companyStateRepoRemotes = pgTable(
  "company_state_repo_remotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    remoteUrl: text("remote_url").notNull(),
    secretId: uuid("secret_id").references(() => companySecrets.id, { onDelete: "set null" }),
    secretVersion: text("secret_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_state_repo_remotes_company_uq").on(table.companyId),
  }),
);
