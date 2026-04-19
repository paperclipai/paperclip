import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const pendingResponses = pgTable(
  "pending_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    waitingAgentId: uuid("waiting_agent_id").notNull().references(() => agents.id),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("pending_responses_company_status_idx").on(table.companyId, table.status),
    expiresIdx: index("pending_responses_expires_idx").on(table.expiresAt),
  }),
);
