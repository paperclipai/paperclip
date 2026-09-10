import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  DeliveryBlocker,
  DeliveryCheck,
  DeliveryDisposition,
  DeliveryMergeMethod,
  DeliveryMergeQueueMode,
  DeliveryPolicyAuthorization,
  DeliveryProvenance,
  DeliveryQueueStatus,
  DeliveryUnitStatus,
  DeliveryFindingState,
  DeliveryFindingDisposition,
  DeliveryDependencyKind,
  DeliveryReconciliationClassification,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { projects } from "./projects.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { toolConnections } from "./tool_access.js";

/**
 * Canonical GitHub repository identity, company-scoped.
 *
 * The durable delivery queue is keyed by this row plus a target branch, so two
 * company projects that point at the same repository share one queue and
 * serialize against each other. `githubRepositoryId` is GitHub's immutable
 * numeric id; owner/name are verified against it on every policy write so a
 * rename cannot silently split the queue.
 */
export const deliveryRepositories = pgTable(
  "delivery_repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    host: text("host").notNull().default("github.com"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    githubRepositoryId: text("github_repository_id"),
    defaultBranch: text("default_branch").notNull().default("main"),
    connectionId: uuid("connection_id").references(() => toolConnections.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    renameVerifiedAt: timestamp("rename_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_repositories_provider_check", sql`${table.provider} = 'github'`),
    unique("delivery_repositories_company_owner_name_uq").on(table.companyId, table.host, table.owner, table.name),
    uniqueIndex("delivery_repositories_company_github_id_uq")
      .on(table.companyId, table.githubRepositoryId)
      .where(sql`${table.githubRepositoryId} is not null`),
  ],
);

/**
 * One delivery unit = one reviewed candidate: immutable accepted revision, one
 * pull request, one receipt. `status` tracks remote merge progress; the
 * `blocker` column carries the current machine reason without losing phase.
 */
export const deliveryUnits = pgTable(
  "delivery_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    repositoryId: uuid("repository_id").notNull().references(() => deliveryRepositories.id, { onDelete: "cascade" }),
    primaryIssueId: uuid("primary_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    targetBranch: text("target_branch").notNull(),
    sourceBranch: text("source_branch").notNull(),
    baseSha: text("base_sha"),
    headSha: text("head_sha"),
    acceptedHeadSha: text("accepted_head_sha"),
    mergedSha: text("merged_sha"),
    mergeCommitSha: text("merge_commit_sha"),
    status: text("status").$type<DeliveryUnitStatus>().notNull().default("submitted"),
    artifactReady: boolean("artifact_ready").notNull().default(false),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    mergeMethod: text("merge_method").$type<DeliveryMergeMethod>().notNull().default("squash"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    priority: text("priority").notNull().default("medium"),
    blocker: jsonb("blocker").$type<DeliveryBlocker | null>(),
    nextAction: text("next_action"),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    queueEnteredAt: timestamp("queue_entered_at", { withTimezone: true }),
    mergeRequestedAt: timestamp("merge_requested_at", { withTimezone: true }),
    mergeAttemptCount: integer("merge_attempt_count").notNull().default(0),
    repairAttemptCount: integer("repair_attempt_count").notNull().default(0),
    lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "delivery_units_status_check",
      sql`${table.status} in ('submitted','in_review','ready_to_merge','merging','merged','blocked','cancelled','closed_unmerged')`,
    ),
    check("delivery_units_merge_method_check", sql`${table.mergeMethod} in ('merge','squash','rebase')`),
    index("delivery_units_company_status_idx").on(table.companyId, table.status),
    index("delivery_units_company_repository_idx").on(table.companyId, table.repositoryId, table.targetBranch),
    index("delivery_units_primary_issue_idx").on(table.companyId, table.primaryIssueId),
    index("delivery_units_owner_idx").on(table.companyId, table.ownerAgentId),
    uniqueIndex("delivery_units_repository_pr_uq")
      .on(table.repositoryId, table.prNumber)
      .where(sql`${table.prNumber} is not null`),
  ],
);

/** Issues covered by a unit. Exactly one row per unit carries `primary`. */
export const deliveryUnitIssues = pgTable(
  "delivery_unit_issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("covered"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_unit_issues_role_check", sql`${table.role} in ('primary','covered')`),
    unique("delivery_unit_issues_unit_issue_uq").on(table.unitId, table.issueId),
    index("delivery_unit_issues_company_issue_idx").on(table.companyId, table.issueId),
  ],
);

/**
 * Explicit delivery dependencies between units.
 *
 * `needs_artifact` allows development once the depended-on unit has a reviewed
 * artifact; `must_merge_after` orders delivery and the queue. Parent/child issue
 * structure is deliberately not a dependency.
 */
export const deliveryDependencies = pgTable(
  "delivery_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    dependsOnUnitId: uuid("depends_on_unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    kind: text("kind").$type<DeliveryDependencyKind>().notNull(),
    createdByActorType: text("created_by_actor_type"),
    createdByActorId: text("created_by_actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_dependencies_kind_check", sql`${table.kind} in ('needs_artifact','must_merge_after')`),
    check("delivery_dependencies_not_self_check", sql`${table.unitId} <> ${table.dependsOnUnitId}`),
    unique("delivery_dependencies_edge_uq").on(table.unitId, table.dependsOnUnitId, table.kind),
    index("delivery_dependencies_depends_on_idx").on(table.companyId, table.dependsOnUnitId),
  ],
);

/**
 * Durable, repository+branch-keyed queue. Leases always expire; an expired
 * lease is reconciled back to `queued` rather than blocking the queue forever.
 */
export const deliveryQueueEntries = pgTable(
  "delivery_queue_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").notNull().references(() => deliveryRepositories.id, { onDelete: "cascade" }),
    targetBranch: text("target_branch").notNull(),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryQueueStatus>().notNull().default("queued"),
    priority: text("priority").notNull().default("medium"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseEpoch: integer("lease_epoch").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_queue_entries_status_check", sql`${table.status} in ('queued','leased','merged','cancelled','blocked')`),
    unique("delivery_queue_entries_unit_uq").on(table.repositoryId, table.targetBranch, table.unitId),
    index("delivery_queue_entries_order_idx").on(
      table.repositoryId,
      table.targetBranch,
      table.status,
      table.priority,
      table.readyAt,
      table.enqueuedAt,
    ),
    index("delivery_queue_entries_company_idx").on(table.companyId, table.status),
  ],
);

/**
 * Versioned, operator-approved repository delivery policy. Auto-merge is only
 * ever performed under a row whose `authorization` names the approving
 * operator; `version` increments on every write so a decision can be traced to
 * the policy revision it ran under.
 */
export const deliveryPolicies = pgTable(
  "delivery_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").references(() => deliveryRepositories.id, { onDelete: "set null" }),
    targetBranch: text("target_branch").notNull().default("main"),
    enabled: boolean("enabled").notNull().default(false),
    paused: boolean("paused").notNull().default(false),
    mergeMethod: text("merge_method").$type<DeliveryMergeMethod>().notNull().default("squash"),
    mergeQueueMode: text("merge_queue_mode").$type<DeliveryMergeQueueMode>().notNull().default("serialized"),
    requiredChecks: jsonb("required_checks").$type<string[]>().notNull().default([]),
    requireGreptile: boolean("require_greptile").notNull().default(false),
    requireIndependentApproval: boolean("require_independent_approval").notNull().default(true),
    githubConnectionId: uuid("github_connection_id").references(() => toolConnections.id, { onDelete: "set null" }),
    greptileConnectionId: uuid("greptile_connection_id").references(() => toolConnections.id, { onDelete: "set null" }),
    autoDeployDisposition: text("auto_deploy_disposition").notNull().default("none"),
    authorization: jsonb("authorization").$type<DeliveryPolicyAuthorization | null>(),
    version: integer("version").notNull().default(1),
    createdByUserId: text("created_by_user_id"),
    updatedByUserId: text("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_policies_merge_method_check", sql`${table.mergeMethod} in ('merge','squash','rebase')`),
    check("delivery_policies_merge_queue_mode_check", sql`${table.mergeQueueMode} in ('serialized','native_merge_queue')`),
    check(
      "delivery_policies_auto_deploy_disposition_check",
      sql`${table.autoDeployDisposition} in ('none','block_merge','no_auto_deploy','authorized')`,
    ),
    unique("delivery_policies_project_uq").on(table.projectId),
    index("delivery_policies_company_idx").on(table.companyId),
  ],
);

/** Normalized review findings (Greptile-first) with persisted disposition. */
export const deliveryFindings = pgTable(
  "delivery_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("greptile"),
    externalId: text("external_id").notNull(),
    severity: text("severity").notNull().default("unknown"),
    title: text("title").notNull(),
    body: text("body"),
    filePath: text("file_path"),
    line: integer("line"),
    url: text("url"),
    headSha: text("head_sha"),
    state: text("state").$type<DeliveryFindingState>().notNull().default("open"),
    disposition: text("disposition").$type<DeliveryFindingDisposition | null>(),
    dispositionExplanation: text("disposition_explanation"),
    dispositionActorType: text("disposition_actor_type"),
    dispositionActorId: text("disposition_actor_id"),
    dispositionAt: timestamp("disposition_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "delivery_findings_state_check",
      sql`${table.state} in ('open','fixed','disputed','already_addressed','stale')`,
    ),
    unique("delivery_findings_external_uq").on(table.unitId, table.source, table.externalId),
    index("delivery_findings_unit_state_idx").on(table.companyId, table.unitId, table.state),
  ],
);

/** Durable, deduplicated delivery timeline. `dedupeKey` makes replays idempotent. */
export const deliveryEvents = pgTable(
  "delivery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    dedupeKey: text("dedupe_key"),
    url: text("url"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("delivery_events_dedupe_uq")
      .on(table.unitId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    index("delivery_events_unit_created_idx").on(table.companyId, table.unitId, table.createdAt),
    index("delivery_events_issue_created_idx").on(table.companyId, table.issueId, table.createdAt),
  ],
);

/** Immutable merge receipt: the only evidence that may satisfy the Done gate. */
export const deliveryReceipts = pgTable(
  "delivery_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    repository: text("repository").notNull(),
    githubRepositoryId: text("github_repository_id"),
    targetBranch: text("target_branch").notNull(),
    sourceBranch: text("source_branch").notNull(),
    submittedHeadSha: text("submitted_head_sha").notNull(),
    acceptedHeadSha: text("accepted_head_sha").notNull(),
    baseSha: text("base_sha"),
    mergedSha: text("merged_sha").notNull(),
    mergeCommitSha: text("merge_commit_sha"),
    mergeMethod: text("merge_method").$type<DeliveryProvenance["mergeMethod"]>().notNull(),
    squashOrRebase: boolean("squash_or_rebase").notNull().default(false),
    checks: jsonb("checks").$type<DeliveryCheck[]>().notNull().default([]),
    reviewStatus: text("review_status").notNull().default("unknown"),
    blockingFindings: integer("blocking_findings").notNull().default(0),
    provenance: jsonb("provenance").$type<DeliveryProvenance>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("delivery_receipts_unit_uq").on(table.unitId),
    index("delivery_receipts_company_merged_idx").on(table.companyId, table.mergedSha),
  ],
);

/**
 * Historical/operator reconciliation. Idempotent per company+key so a replay
 * never reopens tasks or moves branches a second time.
 */
export const deliveryReconciliations = pgTable(
  "delivery_reconciliations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => deliveryUnits.id, { onDelete: "set null" }),
    classification: text("classification").$type<DeliveryReconciliationClassification>().notNull(),
    outcome: text("outcome").notNull(),
    observedStatus: text("observed_status").notNull(),
    provenance: jsonb("provenance").$type<DeliveryProvenance | null>(),
    disposition: jsonb("disposition").$type<DeliveryDisposition | null>(),
    note: text("note"),
    reconciledByActorType: text("reconciled_by_actor_type").notNull(),
    reconciledByActorId: text("reconciled_by_actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("delivery_reconciliations_idempotency_uq").on(table.companyId, table.idempotencyKey),
    index("delivery_reconciliations_company_issue_idx").on(table.companyId, table.issueId),
  ],
);

/**
 * Bounded repair attempts for the implementation-owner wake/repair loop. The
 * unique key makes a repeated actionable event idempotent; when the bound is
 * reached the unit escalates instead of waking forever.
 */
export const deliveryRepairAttempts = pgTable(
  "delivery_repair_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").notNull().references(() => deliveryUnits.id, { onDelete: "cascade" }),
    reasonCode: text("reason_code").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull().default("requested"),
    headSha: text("head_sha"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    wakeRequestId: uuid("wake_request_id"),
    requestedByActorType: text("requested_by_actor_type"),
    requestedByActorId: text("requested_by_actor_id"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("delivery_repair_attempts_status_check", sql`${table.status} in ('requested','dispatched','resolved','exhausted')`),
    unique("delivery_repair_attempts_uq").on(table.unitId, table.reasonCode, table.attempt),
    index("delivery_repair_attempts_unit_idx").on(table.companyId, table.unitId, table.status),
  ],
);
