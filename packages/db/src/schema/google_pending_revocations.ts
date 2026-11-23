import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const googlePendingRevocations = pgTable(
  "google_pending_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    connectionId: uuid("connection_id"),
    grantId: uuid("grant_id"),
    sourceSecretId: uuid("source_secret_id"),
    subject: text("subject").notNull(),
    profile: text("profile").notNull(),
    tokenMaterial: jsonb("token_material").$type<Record<string, unknown>>().notNull(),
    tokenSha256: text("token_sha256").notNull(),
    reason: text("reason").$type<"connection_removed" | "grant_revoked" | "company_deleted" | "instance_removed">().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastOutcome: text("last_outcome"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    giveUpAt: timestamp("give_up_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("google_pending_revocations_due_idx").on(table.nextAttemptAt, table.id),
    uniqueIndex("google_pending_revocations_token_idx").on(table.companyId, table.tokenSha256),
  ],
);
