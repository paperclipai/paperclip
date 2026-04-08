import { pgTable, uuid, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const teamWorkflowStatuses = pgTable(
  "team_workflow_statuses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    category: text("category").notNull(),
    color: text("color"),
    description: text("description"),
    position: integer("position").notNull().default(0),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamIdx: index("team_workflow_statuses_team_idx").on(table.teamId),
    teamSlugUniq: uniqueIndex("team_workflow_statuses_team_slug_uniq").on(table.teamId, table.slug),
  }),
);
