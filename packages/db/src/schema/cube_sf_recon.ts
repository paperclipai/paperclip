import { pgTable, uuid, timestamp, text, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const cubeSfReconRun = pgTable("cube_sf_recon_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").references(() => companies.id).notNull(),
  startedAt: timestamp("started_at").notNull(),
  endedAt: timestamp("ended_at"),
  status: text("status").notNull(), // success | partial | failed
  loansCheckedSf: integer("loans_checked_sf"),
  loansCheckedCube: integer("loans_checked_cube"),
  divergenceCount: integer("divergence_count"),
  overdueCount: integer("overdue_count"),
  stalenessFlag: boolean("staleness_flag"),
  error: text("error"),
});

export const cubeSfReconEvent = pgTable("cube_sf_recon_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").references(() => cubeSfReconRun.id).notNull(),
  sfLoanId: text("sf_loan_id").notNull(),
  sfLoanNumber: text("sf_loan_number").notNull(),
  eventType: text("event_type").notNull(), // divergence | overdue | connector_stale
  sfStatus: text("sf_status"),
  cubeMilestone: text("cube_milestone"),
  estClosingDate: timestamp("est_closing_date"),
  severity: text("severity").notNull(), // critical | high | info
  firstSeenAt: timestamp("first_seen_at").notNull(),
  lastSeenAt: timestamp("last_seen_at").notNull(),
  stateTransitionKey: text("state_transition_key").notNull(),
  slackMsgId: text("slack_msg_id"),
  telegramMsgId: text("telegram_msg_id"),
});
