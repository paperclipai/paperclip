import { pgTable, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * WebAuthn platform-authenticator credentials used by the issue-lock feature
 * (MAT-112). A credential is registered per board user + device (Touch ID /
 * platform authenticator) and later asserted to open a short-lived browser
 * unlock session for locked issues.
 *
 * Scoped by `userId` (better-auth `user.id`, or the synthetic `local-board`
 * user in local_trusted mode) so the same person's device unlocks their view.
 */
export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(),
    // Board user this credential belongs to. Not a hard FK because
    // local_trusted mode uses the synthetic `local-board` id which has no
    // `user` row; authenticated mode uses a real better-auth user id.
    userId: text("user_id").notNull(),
    // base64url-encoded credential id returned by the authenticator.
    credentialId: text("credential_id").notNull(),
    // base64url-encoded COSE public key.
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    // Reported transports, e.g. ["internal"] for a platform authenticator.
    transports: jsonb("transports").$type<string[]>(),
    deviceLabel: text("device_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => ({
    userIdx: index("webauthn_credentials_user_idx").on(table.userId),
    credentialIdx: index("webauthn_credentials_credential_idx").on(table.credentialId),
  }),
);
