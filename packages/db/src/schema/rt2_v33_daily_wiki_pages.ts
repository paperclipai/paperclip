import { date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Rt2DailyActivityEntry } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

export const rt2V33DailyWikiPages = pgTable(
  "rt2_v33_daily_wiki_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    reportDate: date("report_date").notNull(),
    pageKey: text("page_key").notNull(),
    shortSummary: jsonb("short_summary").$type<string[]>().notNull().default([]),
    markdown: text("markdown").notNull().default(""),
    history: jsonb("history").$type<Rt2DailyActivityEntry[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPageKeyUq: uniqueIndex("rt2_v33_daily_wiki_pages_company_page_key_uq").on(
      table.companyId,
      table.pageKey,
    ),
    companyProjectRecentIdx: index("rt2_v33_daily_wiki_pages_company_recent_idx").on(
      table.companyId,
      table.projectId,
      table.updatedAt,
    ),
    companyProjectUserReportDateUq: uniqueIndex(
      "rt2_v33_daily_wiki_pages_company_project_user_report_date_uq",
    ).on(
      table.companyId,
      table.projectId,
      table.userId,
      table.reportDate,
    ),
  }),
);
