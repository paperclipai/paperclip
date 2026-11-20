import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { toolConnections } from "./tool_access.js";

export const toolConnectionContentDeletions = pgTable(
  "tool_connection_content_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
    status: text("status").$type<"pending" | "completed">().notNull().default("pending"),
    requestedByActorType: text("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tool_connection_content_deletions_connection_idx").on(table.companyId, table.connectionId, table.createdAt),
    uniqueIndex("tool_connection_content_deletions_pending_uq")
      .on(table.companyId, table.connectionId)
      .where(sql`${table.status} = 'pending'`),
    index("tool_connection_content_deletions_pending_idx")
      .on(table.requestedAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);
