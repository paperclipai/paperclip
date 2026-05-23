import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const workSessions = pgTable(
  "work_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").references(() => agents.id),
    status: text("status").notNull().default("active"), // active, paused, ended
    startTime: timestamp("start_time", { withTimezone: true }).notNull().defaultNow(),
    endTime: timestamp("end_time", { withTimezone: true }),
    duration: integer("duration"), // in seconds
    gitBranch: text("git_branch"),
    summary: text("summary"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("work_sessions_company_idx").on(table.companyId),
    statusIdx: index("work_sessions_status_idx").on(table.status),
    startTimeIdx: index("work_sessions_start_time_idx").on(table.startTime),
  }),
);

export const sessionSnapshots = pgTable(
  "session_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => workSessions.id, {
      onDelete: "cascade",
    }),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    gitBranch: text("git_branch"),
    openFiles: jsonb("open_files").$type<string[]>(),
    unfinishedTasks: jsonb("unfinished_tasks"),
    recentChanges: jsonb("recent_changes"),
    summary: text("summary"),
    contextScore: integer("context_score"), // 0-100
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionIdx: index("session_snapshots_session_idx").on(table.sessionId),
    timestampIdx: index("session_snapshots_timestamp_idx").on(table.timestamp),
  }),
);
