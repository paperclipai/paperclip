import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";

export const authUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const authSessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
});

export const authAccounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  // CMP-60: actor audit fields for password writes. Nullable for backward compat;
  // populated by the password-audit wrapper on every observed password write.
  lastPasswordChangedByUserId: text("last_password_changed_by_user_id"),
  lastPasswordChangedByAgentId: text("last_password_changed_by_agent_id"),
  lastPasswordChangeSource: text("last_password_change_source"),
  lastPasswordChangedAt: timestamp("last_password_changed_at", { withTimezone: true }),
});

export const authVerifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

/**
 * CMP-60: Append-only audit log for every observed password write on `account.password`.
 *
 * One row per attempt (success or failure). The actor columns capture who initiated
 * the write (board user, agent, or unknown), the request columns capture how it
 * arrived (endpoint, method, IP, user-agent). Direct DB edits cannot appear here by
 * definition — that gap is what motivates the `last_password_changed_*` columns on
 * `account` itself, which this table's row should match for any legitimate write.
 */
export const authPasswordChangeLog = pgTable("account_password_change_log", {
  id: text("id").primaryKey(),
  // The account whose password was the target of the write, when known.
  accountId: text("account_id"),
  targetUserId: text("target_user_id"),
  // Who initiated the write.
  actorType: text("actor_type").notNull(),
  actorUserId: text("actor_user_id"),
  actorAgentId: text("actor_agent_id"),
  actorSource: text("actor_source"),
  // What they did.
  action: text("action").notNull(),
  method: text("method").notNull(),
  requestPath: text("request_path").notNull(),
  statusCode: integer("status_code").notNull(),
  success: boolean("success").notNull(),
  errorMessage: text("error_message"),
  // Where they came from.
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
});
