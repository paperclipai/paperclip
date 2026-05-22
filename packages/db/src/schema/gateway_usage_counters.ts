import { pgTable, uuid, text, bigint, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { gatewayRoutes } from "./gateway_routes.js";

export const gatewayUsageCounters = pgTable(
  "gateway_usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id").notNull().references(() => gatewayRoutes.id, { onDelete: "cascade" }),
    windowType: text("window_type").notNull(),
    windowKey: text("window_key").notNull(),
    tokenCount: bigint("token_count", { mode: "number" }).notNull().default(0),
    requestCount: integer("request_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    routeWindowUniqueIdx: uniqueIndex("gateway_usage_route_window_unique_idx").on(
      table.routeId,
      table.windowType,
      table.windowKey,
    ),
  }),
);
