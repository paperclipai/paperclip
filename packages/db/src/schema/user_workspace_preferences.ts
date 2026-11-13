import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** One presentation choice per person across companies on this instance.
 * local_trusted instances use their existing local-board principal. */
export const userWorkspacePreferences = pgTable("user_workspace_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  coordinatorWorkspaceEnabled: boolean("coordinator_workspace_enabled").notNull().default(true),
  classicWorkspaceEnabled: boolean("classic_workspace_enabled").notNull().default(false),
  /** IANA zone reported by the person's browser, used to read their times and dates. */
  timeZone: text("time_zone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  userUq: uniqueIndex("user_workspace_preferences_user_uq").on(table.userId),
}));
