import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { goals } from "./goals.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";

/**
 * The onboarding answers Paperclip Cloud collected during signup, pushed into
 * this stack at activation and applied here.
 *
 * `revision` is the content hash Cloud computed over the seed. Cloud retries
 * the push until it gets a 2xx and only then records the acknowledged
 * revision, so the receiver has to be idempotent: replaying a revision that
 * already matches this row must not create a second agent or a second task.
 * The `goal_id` / `agent_id` / `issue_id` back-references are what a later
 * revision updates in place rather than duplicating.
 */
export const companyOnboardingSeeds = pgTable(
  "company_onboarding_seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    mission: text("mission"),
    agentName: text("agent_name"),
    agentRole: text("agent_role"),
    firstTaskTitle: text("first_task_title"),
    firstTaskDetails: text("first_task_details"),
    goalId: uuid("goal_id").references(() => goals.id, { onDelete: "set null" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("company_onboarding_seeds_company_uq").on(table.companyId),
  }),
);
