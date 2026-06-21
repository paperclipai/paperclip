import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
  },
  (table) => ({
    actionUniqueIdx: uniqueIndex("recovery_workflow_links_action_uniq").on(table.actionId),
  }),
);
