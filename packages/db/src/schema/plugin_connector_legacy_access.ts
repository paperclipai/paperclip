import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { toolConnections } from "./tool_access.js";

/**
 * One-time carry-over of plugin agent tools declared with the legacy
 * top-level manifest `tools`. Before plugin connectors, every agent could use
 * those tools. The migration that adds plugin connectors records one row per
 * plugin installed at that time and per company; the host then creates one
 * connection of the plugin's implicit connector, installed for the whole
 * company, so agents keep exactly the tools they had. Plugins installed later
 * get no row and follow the normal connector activation rules.
 */
export const pluginConnectorLegacyAccess = pgTable(
  "plugin_connector_legacy_access",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    connectionId: uuid("connection_id").references(() => toolConnections.id, { onDelete: "set null" }),
    /** Set while one server works on the row; a stale claim can be taken over. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("plugin_connector_legacy_access_company_plugin_uq").on(table.companyId, table.pluginKey),
  ],
);
