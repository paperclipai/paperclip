import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

// OAuth client/request metadata is instance-level authentication infrastructure.
// Authority and mutation receipts are always scoped to a company and a user.
export const mcpOauthClients = pgTable("mcp_oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  registrationSourceHash: text("registration_source_hash"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull().default(["authorization_code", "refresh_token"]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Instance-level, short-lived admission receipts bound unauthenticated CIMD
// network work across replicas. Failed lookups consume the same quota as success.
export const mcpOauthMetadataAdmissions = pgTable("mcp_oauth_metadata_admissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceHash: text("source_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("mcp_oauth_metadata_admissions_expiry_idx").on(t.expiresAt)]);

export const mcpOauthGrants = pgTable("mcp_oauth_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull().references(() => mcpOauthClients.id, { onDelete: "cascade" }),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mcp_oauth_grants_user_company_idx").on(t.userId, t.companyId),
]);

export const mcpOauthRequests = pgTable("mcp_oauth_requests", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().references(() => mcpOauthClients.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  state: text("state"),
  challenge: text("challenge").notNull(),
  // A scope restriction, never authority. Retain it if the company is deleted.
  requestedCompanyId: uuid("requested_company_id"),
  grantId: uuid("grant_id").references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  codeHash: text("code_hash"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mcp_oauth_requests_code_uq").on(t.codeHash),
  index("mcp_oauth_requests_expiry_idx").on(t.expiresAt),
]);

export const mcpOauthTokens = pgTable("mcp_oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  grantId: uuid("grant_id").notNull().references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  kind: text("kind").$type<"access" | "refresh">().notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mcp_oauth_tokens_hash_uq").on(t.tokenHash),
  index("mcp_oauth_tokens_grant_idx").on(t.grantId),
  index("mcp_oauth_tokens_expiry_idx").on(t.expiresAt),
]);

export const mcpOauthDeviceRequests = pgTable("mcp_oauth_device_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientId: text("client_id").notNull().references(() => mcpOauthClients.id, { onDelete: "cascade" }),
  deviceCodeHash: text("device_code_hash").notNull(),
  userCodeHash: text("user_code_hash").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  requestedCompanyId: uuid("requested_company_id"),
  sourceHash: text("source_hash").notNull(),
  status: text("status").$type<"pending" | "approved" | "denied" | "consumed">().notNull().default("pending"),
  grantId: uuid("grant_id").references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  intervalSeconds: integer("interval_seconds").notNull().default(5),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mcp_oauth_device_code_uq").on(t.deviceCodeHash),
  uniqueIndex("mcp_oauth_user_code_uq").on(t.userCodeHash),
  index("mcp_oauth_device_expiry_idx").on(t.expiresAt),
]);

export const mcpMutationReceipts = pgTable("mcp_mutation_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  operation: text("operation").notNull(),
  requestId: uuid("request_id").notNull(),
  argumentsHash: text("arguments_hash").notNull(),
  status: text("status").$type<"reserved" | "completed" | "unknown">().notNull().default("reserved"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("mcp_mutation_receipts_request_uq").on(t.companyId, t.userId, t.operation, t.requestId),
  index("mcp_mutation_receipts_company_idx").on(t.companyId),
]);


export const mcpEventSubscriptions = pgTable("mcp_event_subscriptions", {
  id: text("id").primaryKey(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  taskId: uuid("task_id").notNull(),
  arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
  // URL, signing keys and optional Cloud authority, encrypted with the instance secret provider.
  deliveryMaterial: jsonb("delivery_material").$type<Record<string, unknown>>().notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("mcp_event_subscriptions_expiry_idx").on(t.expiresAt), index("mcp_event_subscriptions_company_idx").on(t.companyId)]);

// Short-lived admission leases bound remote verification across replicas. Finished
// attempts remain until expiry so failed callbacks cannot bypass rate limits.
export const mcpEventAdmissions = pgTable("mcp_event_admissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: text("subscription_id").notNull(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").notNull().references(() => mcpOauthGrants.id, { onDelete: "cascade" }),
  reservesSubscription: boolean("reserves_subscription").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("mcp_event_admissions_expiry_idx").on(t.expiresAt),
  index("mcp_event_admissions_grant_idx").on(t.grantId),
  index("mcp_event_admissions_company_idx").on(t.companyId),
]);

export const mcpEventDeliveries = pgTable("mcp_event_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: text("subscription_id").notNull().references(() => mcpEventSubscriptions.id, { onDelete: "cascade" }),
  activityId: uuid("activity_id").notNull(),
  event: jsonb("event").$type<Record<string, unknown>>().notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // Category/status only; never a URL, secret or response body.
  outcome: text("outcome"),
}, (t) => [
  uniqueIndex("mcp_event_deliveries_activity_uq").on(t.subscriptionId, t.activityId),
  index("mcp_event_deliveries_due_idx").on(t.nextAttemptAt),
]);
