import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const workCycles = pgTable(
  "work_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("planned"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    capacityStoryPoints: integer("capacity_story_points"),
    capacityHours: integer("capacity_hours"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyProjectStatusIdx: index("work_cycles_company_project_status_idx").on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    companyDatesIdx: index("work_cycles_company_dates_idx").on(
      table.companyId,
      table.startDate,
      table.endDate,
    ),
  }),
);
