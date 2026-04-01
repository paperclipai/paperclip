import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const userInvites = pgTable(
  "user_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tosAcceptedAt: timestamp("tos_accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("user_invites_token_hash_unique_idx").on(table.tokenHash),
    companyEmailIdx: index("user_invites_company_email_idx").on(table.companyId, table.email),
    expiresAtIdx: index("user_invites_expires_at_idx").on(table.expiresAt),
  }),
);
