import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { PluginCategory, PluginStatus, PaperclipPluginManifestV1 } from "@paperclipai/shared";

/**
 * `plugins` table — stores one row per installed plugin.
 *
 * Each plugin is uniquely identified by `plugin_key` (derived from
 * the manifest `id`). The full manifest is persisted as JSONB in
 * `manifest_json` so the host can reconstruct capability and UI
 * slot information without loading the plugin package.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const plugins = pgTable(
  "plugins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginKey: text("plugin_key").notNull(),
    packageName: text("package_name").notNull(),
    version: text("version").notNull(),
    apiVersion: integer("api_version").notNull().default(1),
    categories: jsonb("categories").$type<PluginCategory[]>().notNull().default([]),
    manifestJson: jsonb("manifest_json").$type<PaperclipPluginManifestV1>().notNull(),
    /**
     * sha256 of the manifest module's raw source bytes, captured whenever
     * `manifestJson` is (install, approved upgrade, activation refresh). Lets
     * diagnostic read routes detect a package swapped in place with the same
     * `package.json` version by comparing hashes without importing/executing
     * the manifest module. See PLUGIN_SPEC.md §15.4.
     */
    manifestSourceHash: text("manifest_source_hash"),
    /**
     * Manifest captured from an upgrade whose capability escalation is
     * awaiting operator approval (status `upgrade_pending`). Persisted at the
     * moment of the operator-invoked `upgrade()` call — the one legitimate
     * point where the package is loaded — so later reads (e.g. the enable
     * gate) can diff against it without re-executing the manifest module.
     * Null outside `upgrade_pending`.
     */
    pendingManifestJson: jsonb("pending_manifest_json").$type<PaperclipPluginManifestV1 | null>(),
    status: text("status").$type<PluginStatus>().notNull().default("installed"),
    installOrder: integer("install_order"),
    /** Resolved package path for local-path installs; used to find worker entrypoint. */
    packagePath: text("package_path"),
    lastError: text("last_error"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginKeyIdx: uniqueIndex("plugins_plugin_key_idx").on(table.pluginKey),
    statusIdx: index("plugins_status_idx").on(table.status),
  }),
);
