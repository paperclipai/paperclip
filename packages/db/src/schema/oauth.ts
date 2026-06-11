import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    status: text("status").$type<"active" | "expired" | "revoked" | "error">().notNull(),
    accountId: text("account_id"),
    accountLabel: text("account_label"),
    scopes: text("scopes").array().notNull().default(sql`'{}'`),
    accessTokenSecretId: uuid("access_token_secret_id")
      .notNull()
      .references(() => companySecrets.id),
    refreshTokenSecretId: uuid("refresh_token_secret_id").references(() => companySecrets.id),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    refreshAttemptCount: integer("refresh_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    companyProviderUniq: uniqueIndex("oauth_connections_company_provider_uq").on(
      table.companyId,
      table.providerId,
    ),
    refreshIdx: index("oauth_connections_refresh_idx")
      .on(table.accessTokenExpiresAt)
      .where(sql`${table.status} = 'active' AND ${table.refreshTokenSecretId} IS NOT NULL`),
    statusCheck: check(
      "oauth_connections_status_check",
      sql`${table.status} IN ('active','expired','revoked','error')`,
    ),
  }),
);

export const oauthAuthorizationStates = pgTable(
  "oauth_authorization_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    scopesRequested: text("scopes_requested").array().notNull().default(sql`'{}'`),
    initiatedByUserId: text("initiated_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    returnUrl: text("return_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => ({
    expiryIdx: index("oauth_authorization_states_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} IS NULL`),
  }),
);

export type OAuthConnection = typeof oauthConnections.$inferSelect;
export type NewOAuthConnection = typeof oauthConnections.$inferInsert;
export type OAuthAuthorizationState = typeof oauthAuthorizationStates.$inferSelect;
export type NewOAuthAuthorizationState = typeof oauthAuthorizationStates.$inferInsert;
