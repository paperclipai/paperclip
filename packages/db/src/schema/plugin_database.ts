import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PluginDatabaseMigrationStatus,
  PluginDatabaseNamespaceMode,
  PluginDatabaseNamespaceStatus,
} from "@paperclipai/shared";
import { plugins } from "./plugins.js";

/**
 * Database namespace allocated to an installed plugin.
 *
 * Namespaces are deterministic and owned by the host. Plugin SQL may create
 * objects only inside its namespace, while selected public core tables remain
 * read-only join targets through runtime checks.
 */
export const pluginDatabaseNamespaces = pgTable(
  "plugin_database_namespaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    namespaceName: text("namespace_name").notNull(),
    namespaceMode: text("namespace_mode").$type<PluginDatabaseNamespaceMode>().notNull().default("schema"),
    status: text("status").$type<PluginDatabaseNamespaceStatus>().notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: uniqueIndex("plugin_database_namespaces_plugin_idx").on(table.pluginId),
    namespaceIdx: uniqueIndex("plugin_database_namespaces_namespace_idx").on(table.namespaceName),
    statusIdx: index("plugin_database_namespaces_status_idx").on(table.status),
  }),
);

/**
 * Per-plugin migration ledger.
 *
 * Every migration file is recorded with a checksum. A previously applied
 * migration whose checksum changes is rejected during later activation.
 */
export const pluginMigrations = pgTable(
  "plugin_migrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    pluginKey: text("plugin_key").notNull(),
    namespaceName: text("namespace_name").notNull(),
    migrationKey: text("migration_key").notNull(),
    checksum: text("checksum").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    status: text("status").$type<PluginDatabaseMigrationStatus>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    errorMessage: text("error_message"),
  },
  (table) => ({
    pluginMigrationIdx: uniqueIndex("plugin_migrations_plugin_key_idx").on(
      table.pluginId,
      table.migrationKey,
    ),
    pluginIdx: index("plugin_migrations_plugin_idx").on(table.pluginId),
    statusIdx: index("plugin_migrations_status_idx").on(table.status),
  }),
);
