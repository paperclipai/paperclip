import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const nodes = pgTable(
  "nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    name: text("name").notNull(),
    status: text("status").notNull().default("offline"),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    registeredByActorType: text("registered_by_actor_type"),
    registeredByActorId: text("registered_by_actor_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("nodes_company_status_idx").on(table.companyId, table.status),
    companyNameUniqueIdx: uniqueIndex("nodes_company_name_unique_idx").on(table.companyId, table.name),
  }),
);
