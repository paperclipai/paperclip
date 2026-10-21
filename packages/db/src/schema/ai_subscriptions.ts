import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, boolean, integer, numeric, index, uniqueIndex, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { connectionGrants, toolConnections } from "./tool_access.js";

/** An estimate of a recurring account fee, deliberately separate from receipts. */
export const aiSubscriptions = pgTable("ai_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  // Company-scoped digest of provider account AND seat, or an unverified credential.
  accountKey: text("account_key").notNull(),
  identityVerified: boolean("identity_verified").notNull().default(false),
  name: text("name").notNull(),
  // A paid seat can be connected personally and shared. Retain all billing
  // editors even after a connection is deleted; disconnecting is not cancellation.
  ownerUserIds: text("owner_user_ids").array().notNull().default(sql`'{}'::text[]`),
  shared: boolean("shared").notNull().default(false),
  detectedPlan: text("detected_plan"),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  refreshStatus: text("refresh_status").$type<"ok" | "unavailable">(),
  mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => aiSubscriptions.id),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: uniqueIndex("ai_subscriptions_identity_idx").on(table.companyId, table.provider, table.accountKey),
  company: index("ai_subscriptions_company_idx").on(table.companyId),
  noSelfMerge: check("ai_subscriptions_no_self_merge", sql`${table.mergedIntoId} is null or ${table.mergedIntoId} <> ${table.id}`),
}));

export const aiSubscriptionPrices = pgTable("ai_subscription_prices", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").notNull().references(() => aiSubscriptions.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  plan: text("plan").notNull(),
  amountCents: numeric("amount_cents", { precision: 24, scale: 7 }),
  currency: text("currency").notNull().default("USD"),
  cadence: text("cadence").$type<"month" | "year">().notNull().default("month"),
  status: text("status").$type<"active" | "ended" | "excluded">().notNull().default("active"),
  source: text("source").$type<"catalog" | "user" | "unknown">().notNull(),
  sourceUrl: text("source_url"),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  version: uniqueIndex("ai_subscription_prices_revision_idx").on(table.subscriptionId, table.revision),
  company: index("ai_subscription_prices_company_idx").on(table.companyId),
  valid: check("ai_subscription_prices_valid", sql`(${table.amountCents} is null or ${table.amountCents} >= 0) and ${table.cadence} in ('month','year') and ${table.status} in ('active','ended','excluded') and ${table.source} in ('catalog','user','unknown')`),
}));

/** Current credential-to-account binding. Runs snapshot the subscription ID. */
export const aiSubscriptionConnections = pgTable("ai_subscription_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => connectionGrants.id, { onDelete: "cascade" }),
  credentialKey: text("credential_key").notNull(),
  subscriptionId: uuid("subscription_id").notNull().references(() => aiSubscriptions.id, { onDelete: "cascade" }),
}, table => ({
  grant: uniqueIndex("ai_subscription_connections_grant_idx").on(table.companyId, table.grantId),
  credential: index("ai_subscription_connections_credential_idx").on(table.companyId, table.credentialKey),
  account: index("ai_subscription_connections_account_idx").on(table.companyId, table.subscriptionId),
}));
