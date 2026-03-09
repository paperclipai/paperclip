import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";
import type { PluginStateScopeKind } from "@paperclipai/shared";

/**
 * `plugin_entities` table — persistent high-level mapping between Paperclip
 * objects and external plugin-defined entities.
 *
 * This table is used by plugins (e.g. `linear`, `github`) to store pointers
 * to their respective external IDs for projects, issues, etc. and to store
 * their custom data.
 *
 * Unlike `plugin_state`, which is for raw K-V persistence, `plugin_entities`
 * is intended for structured object mappings that the host can understand
 * and query for cross-plugin UI integration.
 *
 * @see PLUGIN_SPEC.md §21.3
 */
export const pluginEntities = pgTable(
  "plugin_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    scopeKind: text("scope_kind").$type<PluginStateScopeKind>().notNull(),
    scopeId: uuid("scope_id"), // NULL for global scope
    externalId: text("external_id"), // ID in the external system
    title: text("title"),
    status: text("status"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginIdx: index("plugin_entities_plugin_idx").on(table.pluginId),
    typeIdx: index("plugin_entities_type_idx").on(table.entityType),
    scopeIdx: index("plugin_entities_scope_idx").on(table.scopeKind, table.scopeId),
    externalIdx: uniqueIndex("plugin_entities_external_idx").on(
      table.pluginId,
      table.entityType,
      table.externalId,
    ),
  }),
);
