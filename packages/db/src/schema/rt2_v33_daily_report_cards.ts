import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";

export const rt2V33DailyReportCards = pgTable(
  "rt2_v33_daily_report_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    reportDate: date("report_date").notNull(),
    taskIssueId: uuid("task_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    todoIssueId: uuid("todo_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    assigneeUserId: text("assignee_user_id").notNull(),
    taskTitle: text("task_title").notNull(),
    todoTitle: text("todo_title").notNull(),
    lane: text("lane").notNull(),
    bucketLabel: text("bucket_label"),
    progressPercent: integer("progress_percent").notNull(),
    note: text("note"),
    status: text("status").notNull().default("todo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    laneCheck: check(
      "rt2_v33_daily_report_cards_lane_check",
      sql`${table.lane} in ('today', 'support_1', 'support_2')`,
    ),
    progressCheck: check(
      "rt2_v33_daily_report_cards_progress_percent_check",
      sql`${table.progressPercent} between 0 and 100`,
    ),
    statusCheck: check(
      "rt2_v33_daily_report_cards_status_check",
      sql`${table.status} in ('todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled')`,
    ),
    companyProjectLaneIdx: index("rt2_v33_daily_report_cards_company_project_lane_idx").on(
      table.companyId,
      table.projectId,
      table.userId,
      table.reportDate,
      table.lane,
    ),
    companyProjectUserReportDateTodoUq: uniqueIndex(
      "rt2_v33_daily_report_cards_company_project_todo_day_uq",
    ).on(
      table.companyId,
      table.projectId,
      table.userId,
      table.reportDate,
      table.todoIssueId,
    ),
  }),
);
