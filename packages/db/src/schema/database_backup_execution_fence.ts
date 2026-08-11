import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Durable fail-closed marker for the one database backup that may execute.
 *
 * PostgreSQL advisory locks provide the fast mutual-exclusion path. This row
 * remains present if every advisory-lock session disappears, so a replacement
 * server cannot overlap a pg_dump child whose owner has not yet joined it.
 */
export const databaseBackupExecutionFence = pgTable(
  "database_backup_execution_fence",
  {
    singletonKey: text("singleton_key").primaryKey().default("default"),
    ownerToken: uuid("owner_token").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  },
);
