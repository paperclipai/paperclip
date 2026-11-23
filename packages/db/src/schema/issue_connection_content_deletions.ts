import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const issueConnectionContentDeletions = pgTable(
  "issue_connection_content_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    scope: jsonb("scope").$type<{ runIds: string[]; invocationIds: string[]; eventIds?: string[] }>().notNull(),
    status: text("status").$type<"pending" | "completed">().notNull().default("pending"),
    requestedByActorType: text("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("issue_connection_content_deletions_issue_idx").on(table.companyId, table.issueId),
    index("issue_connection_content_deletions_pending_idx")
      .on(table.notBefore)
      .where(sql`${table.status} = 'pending'`),
  ],
);
