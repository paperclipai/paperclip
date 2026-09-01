import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agentWakeupRequests } from "./agent_wakeup_requests.js";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { formalQaCheckouts } from "./formal_qa_checkouts.js";
import { formalQaIssuances } from "./formal_qa_issuances.js";
import { formalQaPolicies } from "./formal_qa_policies.js";
import { formalQaPreparations } from "./formal_qa_preparations.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projects } from "./projects.js";
import { projectWorkspaces } from "./project_workspaces.js";

/**
 * Server-owned envelope for exactly one Formal-QA reviewer attempt.
 *
 * The row binds the immutable GitHub issuance and verified checkout to the
 * scheduler records that may execute it. No route accepts these identifiers or
 * any status/decision field from a caller.
 */
export const formalQaReviews = pgTable(
  "formal_qa_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    projectWorkspaceId: uuid("project_workspace_id").notNull().references(() => projectWorkspaces.id),
    preparationId: uuid("preparation_id").notNull().references(() => formalQaPreparations.id),
    issuanceId: uuid("issuance_id").notNull().references(() => formalQaIssuances.id),
    checkoutId: uuid("checkout_id").notNull().references(() => formalQaCheckouts.id),
    policyId: uuid("policy_id").notNull().references(() => formalQaPolicies.id),
    policyVersion: integer("policy_version").notNull(),
    reviewerAgentId: uuid("reviewer_agent_id").notNull().references(() => agents.id),
    executionWorkspaceId: uuid("execution_workspace_id").notNull().references(() => executionWorkspaces.id),
    wakeupRequestId: uuid("wakeup_request_id").notNull().references(() => agentWakeupRequests.id),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id),
    repository: text("repository").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    treeSha: text("tree_sha").notNull(),
    issuanceSha256: text("issuance_sha256").notNull(),
    checkoutSha256: text("checkout_sha256").notNull(),
    contractSha256: text("contract_sha256").notNull(),
    reviewerConfigSha256: text("reviewer_config_sha256").notNull(),
    promptSha256: text("prompt_sha256").notNull(),
    /**
     * Canonical, server-generated source authority captured when this review
     * is queued.  Keeping the preimage as text (rather than only a digest)
     * lets the executor prove that the checkout it is about to mount is the
     * same exact issued source, while the database guard makes it immutable.
     */
    sourceSnapshotJson: text("source_snapshot_json").notNull(),
    sourceSnapshotSha256: text("source_snapshot_sha256").notNull(),
    sourceManifestJson: text("source_manifest_json").notNull(),
    sourceManifestSha256: text("source_manifest_sha256").notNull(),
    status: text("status").notNull().default("queued"),
    decision: text("decision"),
    decisionArtifact: jsonb("decision_artifact").$type<Record<string, unknown>>(),
    decisionSha256: text("decision_sha256"),
    terminalReason: text("terminal_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    checkoutUq: uniqueIndex("formal_qa_reviews_checkout_uq").on(table.checkoutId),
    issuanceUq: uniqueIndex("formal_qa_reviews_issuance_uq").on(table.issuanceId),
    runUq: uniqueIndex("formal_qa_reviews_heartbeat_run_uq").on(table.heartbeatRunId),
    wakeUq: uniqueIndex("formal_qa_reviews_wakeup_request_uq").on(table.wakeupRequestId),
    workspaceUq: uniqueIndex("formal_qa_reviews_execution_workspace_uq").on(table.executionWorkspaceId),
    companyStatusCreatedIdx: index("formal_qa_reviews_company_status_created_idx")
      .on(table.companyId, table.status, table.createdAt),
  }),
);
