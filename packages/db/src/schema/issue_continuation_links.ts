import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/** Explicit successor relationships; parentage alone is never continuation identity. */
export const issueContinuationLinks = pgTable(
  "issue_continuation_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    predecessorIssueId: uuid("predecessor_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    successorIssueId: uuid("successor_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"replacement" | "residual">().notNull(),
    residualScope: text("residual_scope"),
    deliverableKey: text("deliverable_key").notNull(),
    dependencyFingerprint: text("dependency_fingerprint").notNull(),
    continuationFingerprint: text("continuation_fingerprint").notNull(),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPredecessorIdx: index("issue_continuation_links_company_predecessor_idx").on(table.companyId, table.predecessorIssueId),
    companySuccessorIdx: index("issue_continuation_links_company_successor_idx").on(table.companyId, table.successorIssueId),
    continuationFingerprintUq: uniqueIndex("issue_continuation_links_fingerprint_uq")
      .on(table.companyId, table.continuationFingerprint),
  }),
);
