import { sql } from "drizzle-orm";
import { type AnyPgColumn, pgTable, uuid, text, timestamp, date, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import type { AgentEnvConfig } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => projects.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    code: text("code"),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id),
    targetDate: date("target_date"),
    color: text("color"),
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
    companyParentIdx: index("projects_company_parent_idx").on(table.companyId, table.parentId),
    companyCodeUq: uniqueIndex("projects_company_code_uq")
      .on(table.companyId, table.code)
      .where(sql`${table.code} is not null`),
  }),
);
