import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { assets } from "./assets.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { issues } from "./issues.js";

export const releaseCandidates = pgTable(
  "release_candidates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    commitSha: text("commit_sha").notNull(),
    imageDigest: text("image_digest").notNull(),
    signatureBundleRef: text("signature_bundle_ref").notNull(),
    provenanceRef: text("provenance_ref").notNull(),
    sbomHash: text("sbom_hash").notNull(),
    workflowRunUrl: text("workflow_run_url").notNull(),
    environment: text("environment").notNull(),
    targetHost: text("target_host").notNull(),
    sequence: integer("sequence").notNull(),
    documentRevisionId: text("document_revision_id"),
    status: text("status").notNull().default("candidate_created"),
    approvalInteractionId: uuid("approval_interaction_id").references(() => issueThreadInteractions.id, {
      onDelete: "restrict",
    }),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    stagedArtifactAssetId: uuid("staged_artifact_asset_id").references(() => assets.id, { onDelete: "set null" }),
    stagedArtifactSha256: text("staged_artifact_sha256"),
    stagedAt: timestamp("staged_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("release_candidates_company_created_idx").on(table.companyId, table.createdAt),
    sourceIssueIdx: index("release_candidates_source_issue_idx").on(table.sourceIssueId),
    companyTargetSequenceUq: uniqueIndex("release_candidates_company_target_sequence_uq")
      .on(table.companyId, table.environment, table.targetHost, table.sequence),
    companyDigestUq: uniqueIndex("release_candidates_company_digest_uq").on(table.companyId, table.imageDigest),
    immutableAfterApprovalIdx: index("release_candidates_approval_interaction_idx")
      .on(table.approvalInteractionId)
      .where(sql`${table.approvalInteractionId} IS NOT NULL`),
  }),
);

export const releaseDeployAuthorizations = pgTable(
  "release_deploy_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    candidateId: uuid("candidate_id").notNull().references(() => releaseCandidates.id, { onDelete: "restrict" }),
    approvalInteractionId: uuid("approval_interaction_id").notNull().references(() => issueThreadInteractions.id, {
      onDelete: "restrict",
    }),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    targetHost: text("target_host").notNull(),
    imageDigest: text("image_digest").notNull(),
    environment: text("environment").notNull(),
    sequence: integer("sequence").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    leaseArtifactAssetId: uuid("lease_artifact_asset_id").references(() => assets.id, { onDelete: "set null" }),
    leaseIssuedAt: timestamp("lease_issued_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCandidateIdx: index("release_deploy_authorizations_company_candidate_idx").on(table.companyId, table.candidateId),
    tokenHashUq: uniqueIndex("release_deploy_authorizations_token_hash_uq").on(table.tokenHash),
  }),
);

export const releaseCandidateAuditEvents = pgTable(
  "release_candidate_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    candidateId: uuid("candidate_id").notNull().references(() => releaseCandidates.id, { onDelete: "restrict" }),
    authorizationId: uuid("authorization_id").references(() => releaseDeployAuthorizations.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    redacted: boolean("redacted").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    candidateCreatedIdx: index("release_candidate_audit_events_candidate_created_idx").on(table.candidateId, table.createdAt),
    companyCreatedIdx: index("release_candidate_audit_events_company_created_idx").on(table.companyId, table.createdAt),
  }),
);
