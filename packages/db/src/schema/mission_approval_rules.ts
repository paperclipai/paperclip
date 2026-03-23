import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { missions } from "./missions.js";

export const missionApprovalRules = pgTable("mission_approval_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  actionType: text("action_type").notNull(),
  riskTier: text("risk_tier").notNull().default("yellow"),
  autoApproveAfterMin: integer("auto_approve_after_min"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
