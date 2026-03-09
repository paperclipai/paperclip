import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  serial,
} from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";

/**
 * `plugin_logs` table — structured log storage for plugin workers.
 *
 * Each row stores a single log entry emitted by a plugin worker via
 * `ctx.logger.info(...)` etc. Logs are queryable by plugin, level, and
 * time range to support the operator logs panel and debugging workflows.
 *
 * Rows are inserted by the host when handling `log` notifications from
 * the worker process. A capped retention policy can be applied via
 * periodic cleanup (e.g. delete rows older than 7 days).
 *
 * @see PLUGIN_SPEC.md §26 — Observability
 */
export const pluginLogs = pgTable(
  "plugin_logs",
  {
    id: serial("id").primaryKey(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => plugins.id, { onDelete: "cascade" }),
    level: text("level").notNull().default("info"),
    message: text("message").notNull(),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pluginTimeIdx: index("plugin_logs_plugin_time_idx").on(
      table.pluginId,
      table.createdAt,
    ),
    levelIdx: index("plugin_logs_level_idx").on(table.level),
  }),
);
