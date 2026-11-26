import { foreignKey, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ComposioAppAccount } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { toolConnections } from "./tool_access.js";

/** Non-secret upstream account observations, scoped to the viewing human's credential. */
export const toolConnectionAppSnapshots = pgTable("tool_connection_app_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(),
  userId: text("user_id").notNull(),
  credentialKey: text("credential_key").notNull(),
  toolkit: text("toolkit").notNull(),
  status: text("status").$type<"connected" | "not_connected">().notNull(),
  accounts: jsonb("accounts").$type<ComposioAppAccount[]>().notNull().default([]),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  errorAt: timestamp("error_at", { withTimezone: true }),
}, t => [
  uniqueIndex("tool_connection_app_snapshots_owner_toolkit_uq").on(t.companyId, t.connectionId, t.userId, t.toolkit),
  foreignKey({ columns: [t.companyId, t.connectionId], foreignColumns: [toolConnections.companyId, toolConnections.id], name: "tool_connection_app_snapshots_company_connection_fk" }).onDelete("cascade"),
]);
