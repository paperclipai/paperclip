import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

/**
 * Instance-level account blocks applied by an instance admin.
 *
 * Kept outside Better Auth's own `user` table on purpose: the Drizzle adapter
 * validates every write against that model, so new columns there have to be
 * declared to Better Auth as additional fields. A row here with a null
 * `enabled_at` is an active block; re-enabling closes the row instead of
 * deleting it, so the table doubles as the audit trail of who blocked the
 * account, when, and why. Rows go away with the user (`on delete cascade`).
 */
export const userDisablements = pgTable(
  "user_disablements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
    reason: text("reason"),
    disabledByUserId: text("disabled_by_user_id"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }).notNull().defaultNow(),
    enabledByUserId: text("enabled_by_user_id"),
    enabledAt: timestamp("enabled_at", { withTimezone: true }),
  },
  (table) => ({
    activeUserUq: uniqueIndex("user_disablements_active_user_uq")
      .on(table.userId)
      .where(sql`${table.enabledAt} IS NULL`),
    userDisabledAtIdx: index("user_disablements_user_disabled_at_idx").on(table.userId, table.disabledAt),
  }),
);
