import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const storedObjectDeletions = pgTable(
  "stored_object_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(),
    kind: text("kind").$type<"run_log" | "asset">().notNull(),
    logStore: text("log_store"),
    objectKey: text("object_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stored_object_deletions_due_idx").on(table.notBefore, table.id),
    index("stored_object_deletions_company_idx").on(table.companyId),
  ],
);
