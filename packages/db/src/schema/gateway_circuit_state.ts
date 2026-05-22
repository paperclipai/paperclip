import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { gatewayRoutes } from "./gateway_routes.js";

export const gatewayCircuitState = pgTable(
  "gateway_circuit_state",
  {
    routeId: uuid("route_id").primaryKey().references(() => gatewayRoutes.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("closed"),
    failureCount: integer("failure_count").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
