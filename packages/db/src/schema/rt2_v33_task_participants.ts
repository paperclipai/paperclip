import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const rt2V33TaskParticipants = pgTable(
  "rt2_v33_task_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    taskIssueId: uuid("task_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    state: text("state").notNull().default("active"),
    endedReason: text("ended_reason"),
    joinedByUserId: text("joined_by_user_id"),
    endedByUserId: text("ended_by_user_id"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => ({
    stateCheck: check(
      "rt2_v33_task_participants_state_check",
      sql`${table.state} in ('active', 'ended')`,
    ),
    endedReasonCheck: check(
      "rt2_v33_task_participants_ended_reason_check",
      sql`${table.endedReason} is null or ${table.endedReason} in ('manager_removed', 'self_left', 'capacity_reduced')`,
    ),
    taskStateIdx: index("rt2_v33_task_participants_task_state_idx").on(table.taskIssueId, table.state),
    taskUserIdx: index("rt2_v33_task_participants_task_user_idx").on(table.taskIssueId, table.userId),
    activeUserIdx: uniqueIndex("rt2_v33_task_participants_active_user_uq")
      .on(table.taskIssueId, table.userId)
      .where(sql`${table.state} = 'active'`),
  }),
);
