import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const companyAgentManagerSettings = pgTable("company_agent_manager_settings", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  supervisorAgentId: uuid("supervisor_agent_id").references(() => agents.id, { onDelete: "set null" }),
  escalationAgentId: uuid("escalation_agent_id").references(() => agents.id, { onDelete: "set null" }),
  judgeModelProfile: text("judge_model_profile").notNull().default("cheap"),
  scoreThreshold: integer("score_threshold").notNull().default(70),
  maxReflectionAttempts: integer("max_reflection_attempts").notNull().default(3),
  evaluateFailedRuns: boolean("evaluate_failed_runs").notNull().default(true),
  evaluateNeedsFollowup: boolean("evaluate_needs_followup").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
