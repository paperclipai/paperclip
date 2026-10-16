import { pgTable, text, timestamp, boolean, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

export const authUsers = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Better Auth two-factor plugin: per-account opt-in flag. The plugin's user
  // model declares `twoFactorEnabled` (boolean, default false, input: false),
  // so the Drizzle user table must expose it or any `updateUser({
  // twoFactorEnabled })` write throws "field does not exist in the user Drizzle schema".
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
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

/**
 * Better Auth's `account` model. Every column here has to exist for the
 * Drizzle adapter to accept the table at all: the adapter validates the
 * model's fields against the schema on each write and throws
 * `The field "<name>" does not exist in the "account" Drizzle schema`
 * when one is missing, which surfaces as a 500 on sign-up.
 *
 * `issuer` is the account namespace Better Auth 1.7 added. It is
 * `local:credential` for email/password accounts and
 * `local:oauth:<providerId>` for social accounts that do not declare an
 * issuer of their own, and it pairs with `account_id` as the stable
 * provider-side key — hence the unique index, which mirrors the
 * `(issuer, accountId)` unique index Better Auth declares on the model.
 */
export const authAccounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
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
  },
  (table) => ({
    issuerAccountIdUq: uniqueIndex("account_issuer_account_id_uq").on(table.issuer, table.accountId),
  }),
);

export const authVerifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

/**
 * Better Auth `twoFactor` model (the built-in two-factor / TOTP plugin).
 *
 * The Drizzle adapter maps the plugin's camelCase model fields
 * (`secret`, `backupCodes`, `userId`, `verified`, `failedVerificationCount`,
 * `lockedUntil`) onto this table's JS property names, so the keys below must
 * stay exactly those camelCase names — the snake_case column names are the
 * DB-side identity. Mirrors the column set Better Auth 1.7's default
 * `two_factor` Drizzle schema generates.
 *
 * `id` is a TEXT primary key with no DB default: Better Auth's adapter factory
 * generates a base62 string id in JS on every create and injects it before the
 * insert, same as `authUsers` / `authVerifications`.
 *
 * `secret` is encrypted at write time (symmetricEncrypt keyed off the app
 * secret). `backupCodes` are stored encrypted because
 * `server/src/auth/better-auth.ts` configures the plugin with
 * `backupCodeOptions: { storeBackupCodes: "encrypted" }`; without that
 * option the plugin writes them in plaintext. Neither value is ever
 * returned to the client (`returned: false` in the plugin schema).
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("two_factor_user_id_idx").on(table.userId),
  }),
);
