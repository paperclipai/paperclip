import { pgTable, uuid, text, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueRecoveryActions } from "./issue_recovery_actions.js";

// One row per recovery action: maps it to its Cloudflare Workflow instance + mode.
export const recoveryWorkflowLinks = pgTable(
  "recovery_workflow_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    actionId: uuid("action_id").notNull().references(() => issueRecoveryActions.id),
    instanceId: text("instance_id").notNull(),
    mode: text("mode").notNull().default("shadow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Append-only array of shadow decisions recorded during dry-run attempts.
     * Each entry: { attemptNumber, observed: { active, status, attemptCount }, recordedAtMs }
     *
     * Fidelity limit: dry-run is READ-ONLY (per Task 2 design). It returns the
     * current action state — it does NOT simulate the forward-looking owner/wake
     * decision. Therefore this column captures only LIFECYCLE/CADENCE signals
     * (active, status, attemptCount). Owner/wake decisions are NOT stored here.
     */
    shadowDecisions: jsonb("shadow_decisions").$type<unknown[]>().notNull().default([]),
  },
  (table) => ({
    actionUniqueIdx: uniqueIndex("recovery_workflow_links_action_uniq").on(table.actionId),
  }),
);
