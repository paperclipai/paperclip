import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { formalQaPreparations } from "./formal_qa_preparations.js";
import { formalQaPolicies } from "./formal_qa_policies.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * Immutable, server-derived GitHub evidence that authorizes a prepared
 * Formal-QA checkout. Board-created preparations remain inert until this
 * separate record exists; its digest is never supplied by a route caller.
 */
export const formalQaIssuances = pgTable(
  "formal_qa_issuances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    preparationId: uuid("preparation_id")
      .notNull()
      .references(() => formalQaPreparations.id, { onDelete: "cascade" }),
    // Nullable solely for legacy rows predating the policy boundary. The
    // issuer and checkout reject them; new rows always provide these fields.
    policyId: uuid("policy_id").references(() => formalQaPolicies.id),
    policyVersion: integer("policy_version"),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id")
      .notNull()
      .references(() => projectWorkspaces.id),
    repository: text("repository").notNull(),
    prNumber: text("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    baseSha: text("base_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    requiredCheckName: text("required_check_name").notNull(),
    requiredCheckAppId: integer("required_check_app_id"),
    checkRunId: text("check_run_id").notNull(),
    checkSuiteId: text("check_suite_id"),
    workflowRunId: text("workflow_run_id"),
    workflowId: text("workflow_id"),
    /** Canonical, sanitized evidence bytes; snapshotSha256 is the digest of this exact string. */
    evidenceJson: text("evidence_json"),
    snapshotSha256: text("snapshot_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    preparationUq: uniqueIndex("formal_qa_issuances_preparation_uq").on(table.preparationId),
    companyProjectCreatedIdx: index("formal_qa_issuances_company_project_created_idx")
      .on(table.companyId, table.projectId, table.createdAt),
  }),
);
