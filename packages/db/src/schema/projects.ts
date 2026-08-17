import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, date, index, jsonb, check, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    goalId: uuid("goal_id").references(() => goals.id),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility").notNull().default("open"),
    personalOwnerUserId: text("personal_owner_user_id"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
    icon: text("icon"),
    env: jsonb("env").$type<AgentEnvConfig>(),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    executionWorkspacePolicy: jsonb("execution_workspace_policy").$type<Record<string, unknown>>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("projects_company_idx").on(table.companyId),
    visibilityCheck: check("projects_visibility_check", sql`${table.visibility} in ('open', 'private')`),
    personalOwnerUq: uniqueIndex("projects_company_personal_owner_uq")
      .on(table.companyId, table.personalOwnerUserId)
      .where(sql`${table.personalOwnerUserId} is not null`),
  }),
);
