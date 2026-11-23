import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const tailscaleConnections = pgTable("tailscale_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").notNull().default("pending"),
  secretId: uuid("secret_id").references(() => companySecrets.id),
  credentialVersion: integer("credential_version"),
  credentialHash: text("credential_hash"),
  createdByUserId: text("created_by_user_id").notNull(),
  oauthStateHash: text("oauth_state_hash"),
  oauthExpiresAt: timestamp("oauth_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyIdx: index("tailscale_connections_company_idx").on(table.companyId),
  stateIdx: uniqueIndex("tailscale_connections_oauth_state_idx").on(table.oauthStateHash),
}));
