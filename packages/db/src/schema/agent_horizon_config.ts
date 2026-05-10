import { pgTable, uuid, boolean, integer, doublePrecision, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";

export const agentHorizonConfig = pgTable("agent_horizon_config", {
  agentId: uuid("agent_id").primaryKey().references(() => agents.id),
  enabled: boolean("enabled").notNull().default(false),
  scanIntervalSeconds: integer("scan_interval_seconds").notNull().default(900),
  p0StallHours: doublePrecision("p0_stall_hours").notNull().default(4.0),
  p1StallHours: doublePrecision("p1_stall_hours").notNull().default(24.0),
  engineerStallL1Hours: doublePrecision("engineer_stall_l1_hours").notNull().default(24.0),
  engineerStallL2Hours: doublePrecision("engineer_stall_l2_hours").notNull().default(48.0),
  engineerReviewZombieHours: doublePrecision("engineer_review_zombie_hours").notNull().default(72.0),
  outstandingAskMinutes: integer("outstanding_ask_minutes").notNull().default(30),
  boardWaitEscalateMinutes: integer("board_wait_escalate_minutes").notNull().default(60),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
