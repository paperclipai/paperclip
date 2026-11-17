import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Reusable personal management authorization; never a bot runtime credential. */
export const chatSlackManagerGrants = pgTable("chat_slack_manager_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  workspaceName: text("workspace_name").notNull(),
  managerAppId: text("manager_app_id").notNull(),
  status: text("status").$type<"active" | "revoked" | "reauthorize">().notNull().default("active"),
  accessSecretId: uuid("access_secret_id"),
  refreshSecretId: uuid("refresh_secret_id"),
  revision: integer("revision").notNull().default(0),
  rateLimits: jsonb("rate_limits").$type<Record<string, string>>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("chat_slack_manager_grants_company_id_idx").on(t.companyId, t.id),
  uniqueIndex("chat_slack_manager_grants_owner_idx").on(t.companyId, t.userId, t.managerAppId, t.workspaceId),
  check("chat_slack_manager_grants_status_check", sql`${t.status} in ('active', 'revoked', 'reauthorize')`),
]);
