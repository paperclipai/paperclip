import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";
import { boardApiKeys } from "./board_api_keys.js";

export const cliAuthChallenges = pgTable(
  "cli_auth_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    secretHash: text("secret_hash").notNull(),
    command: text("command").notNull(),
    clientName: text("client_name"),
    requestedAccess: text("requested_access").notNull().default("board"),
    requestedCompanyId: uuid("requested_company_id").references(() => companies.id, { onDelete: "set null" }),
    pendingKeyHash: text("pending_key_hash").notNull(),
    pendingKeyName: text("pending_key_name").notNull(),
    approvedByUserId: text("approved_by_user_id").references(() => authUsers.id, { onDelete: "set null" }),
    boardApiKeyId: uuid("board_api_key_id").references(() => boardApiKeys.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    secretHashIdx: index("cli_auth_challenges_secret_hash_idx").on(table.secretHash),
    approvedByIdx: index("cli_auth_challenges_approved_by_idx").on(table.approvedByUserId),
    requestedCompanyIdx: index("cli_auth_challenges_requested_company_idx").on(table.requestedCompanyId),
  }),
);
