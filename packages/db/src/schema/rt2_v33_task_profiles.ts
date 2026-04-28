import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const rt2V33TaskProfiles = pgTable(
  "rt2_v33_task_profiles",
  {
    issueId: uuid("issue_id").primaryKey().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    taskMode: text("task_mode").notNull(),
    capacity: integer("capacity").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    taskModeCheck: check(
      "rt2_v33_task_profiles_task_mode_check",
      sql`${table.taskMode} in ('solo', 'collab')`,
    ),
    capacityCheck: check("rt2_v33_task_profiles_capacity_check", sql`${table.capacity} >= 1`),
    companyProjectIdx: index("rt2_v33_task_profiles_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
  }),
);
