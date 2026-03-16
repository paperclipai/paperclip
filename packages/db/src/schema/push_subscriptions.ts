import { pgTable, uuid, text, timestamp, jsonb, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    keys: jsonb("keys").notNull(),
    // Notification preferences
    notifyTaskComplete: boolean("notify_task_complete").notNull().default(true),
    notifyAgentQuestion: boolean("notify_agent_question").notNull().default(true),
    notifyBoardReview: boolean("notify_board_review").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    endpointUniqueIdx: uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    companyUserIdx: index("push_subscriptions_company_user_idx").on(table.companyId, table.userId),
  }),
);
