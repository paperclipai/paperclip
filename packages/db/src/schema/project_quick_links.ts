import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const projectQuickLinks = pgTable(
  "project_quick_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    siteName: text("site_name"),
    description: text("description"),
    imageUrl: text("image_url"),
    faviconUrl: text("favicon_url"),
    metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true }),
    position: integer("position").notNull().default(0),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectPositionIdx: index("project_quick_links_company_project_position_idx").on(
      table.companyId,
      table.projectId,
      table.position,
    ),
    projectUpdatedIdx: index("project_quick_links_project_updated_idx").on(table.projectId, table.updatedAt),
  }),
);
