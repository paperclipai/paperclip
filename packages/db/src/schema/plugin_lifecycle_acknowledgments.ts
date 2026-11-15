import { bigint, index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { plugins } from "./plugins.js";
import { resourceLifecycleEvents } from "./resource_lifecycle_events.js";

export const pluginLifecycleAcknowledgments = pgTable("plugin_lifecycle_acknowledgments", {
  pluginId: uuid("plugin_id").notNull().references(() => plugins.id, { onDelete: "cascade" }),
  eventId: bigint("event_id", { mode: "number" }).notNull().references(() => resourceLifecycleEvents.id, { onDelete: "cascade" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  pk: primaryKey({ columns: [table.pluginId, table.eventId] }),
  eventIdx: index("plugin_lifecycle_acknowledgments_event_idx").on(table.eventId),
}));
