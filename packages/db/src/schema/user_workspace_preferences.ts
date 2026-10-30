import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** One presentation choice per person across companies on this instance.
 * local_trusted instances use their existing local-board principal. */
export const userWorkspacePreferences = pgTable("user_workspace_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  coordinatorWorkspaceEnabled: boolean("coordinator_workspace_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userUq: uniqueIndex("user_workspace_preferences_user_uq").on(table.userId),
}));
