import { type AnyPgColumn, pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { teams } from "./teams.js";

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => labels.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("labels_company_idx").on(table.companyId),
    companyNameIdx: uniqueIndex("labels_company_name_idx").on(table.companyId, table.name),
    teamIdx: index("labels_team_idx").on(table.teamId),
    parentIdx: index("labels_parent_idx").on(table.parentId),
  }),
);
