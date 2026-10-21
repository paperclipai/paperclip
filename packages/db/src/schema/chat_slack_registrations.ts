import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SlackRegistrationStatus } from "@paperclipai/shared";
import { chatSlackManagerGrants } from "./chat_slack_manager_grants.js";
import { chatEndpoints } from "./chat_channels.js";

/** App provisioning is distinct from installation and runtime credentials. No plaintext secrets. */
export const chatSlackRegistrations = pgTable("chat_slack_registrations", {
  endpointId: uuid("endpoint_id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  managerGrantId: uuid("manager_grant_id"),
  requestId: uuid("request_id").notNull(),
  status: text("status").$type<SlackRegistrationStatus>().notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  manifestHash: text("manifest_hash").notNull(),
  callbackUri: text("callback_uri").notNull(),
  appId: text("app_id"),
  clientId: text("client_id"),
  secretIds: jsonb("secret_ids").$type<Record<string, string>>().notNull().default({}),
  workspaceId: text("workspace_id"),
  botUserId: text("bot_user_id"),
  errorCode: text("error_code"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.companyId, t.managerGrantId], foreignColumns: [chatSlackManagerGrants.companyId, chatSlackManagerGrants.id] }),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id] }).onDelete("cascade"),
  check("chat_slack_registration_status_check", sql`${t.status} in ('creating', 'uncertain', 'failed', 'install', 'credentials_saved', 'configured', 'removed')`),
]);
