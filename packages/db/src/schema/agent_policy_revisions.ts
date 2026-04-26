import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { agentPolicies } from "./agent_policies.js";

export const agentPolicyRevisions = pgTable(
  "agent_policy_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    policyId: uuid("policy_id").notNull().references(() => agentPolicies.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    policyRevisionNumberUniqueIdx: uniqueIndex("agent_policy_revisions_policy_revision_unique_idx").on(
      table.policyId,
      table.revisionNumber,
    ),
    policyIdIdx: index("agent_policy_revisions_policy_id_idx").on(table.policyId),
  }),
);
