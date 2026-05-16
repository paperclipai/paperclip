import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issueComments } from "./issue_comments.js";
import { issues } from "./issues.js";
import { routines, routineRuns, routineTriggers } from "./routines.js";

export const standupPolicies = pgTable(
  "standup_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    policyKey: text("policy_key").notNull(),
    standupType: text("standup_type").notNull().default("daily"),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    timezone: text("timezone").notNull().default("UTC"),
    scheduleCron: text("schedule_cron").notNull(),
    recoveryByLocalTime: text("recovery_by_local_time").notNull(),
    responseDueLocalTime: text("response_due_local_time").notNull(),
    escalationDueLocalTime: text("escalation_due_local_time").notNull(),
    participantAgentIds: jsonb("participant_agent_ids").$type<string[]>().notNull().default([]),
    responseSchema: jsonb("response_schema").$type<Record<string, unknown>>().notNull().default({}),
    genericAnswerDenylist: jsonb("generic_answer_denylist").$type<string[]>().notNull().default([]),
    nonGreenTriggerRule: jsonb("non_green_trigger_rule").$type<Record<string, unknown>>().notNull().default({}),
    actionRouting: jsonb("action_routing").$type<Record<string, unknown>>().notNull().default({}),
    disableSettings: jsonb("disable_settings").$type<Record<string, unknown>>().notNull().default({}),
    linkedRoutineId: uuid("linked_routine_id").references(() => routines.id, { onDelete: "set null" }),
    serviceRunId: uuid("service_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("standup_policies_company_key_uq").on(table.companyId, table.policyKey),
    companyStatusIdx: index("standup_policies_company_status_idx").on(table.companyId, table.status),
    linkedRoutineIdx: index("standup_policies_linked_routine_idx").on(table.linkedRoutineId),
  }),
);

export const standupSessions = pgTable(
  "standup_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").notNull().references(() => standupPolicies.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "set null" }),
    triggerId: uuid("trigger_id").references(() => routineTriggers.id, { onDelete: "set null" }),
    routineRunId: uuid("routine_run_id").references(() => routineRuns.id, { onDelete: "set null" }),
    serviceRunId: uuid("service_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    standupIssueId: uuid("standup_issue_id").references(() => issues.id, { onDelete: "set null" }),
    localDate: text("local_date").notNull(),
    standupType: text("standup_type").notNull().default("daily"),
    policyVersion: integer("policy_version").notNull(),
    timezone: text("timezone").notNull(),
    status: text("status").notNull().default("pending"),
    triggerSource: text("trigger_source").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    triggerConditionSnapshot: jsonb("trigger_condition_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    assessmentSnapshot: jsonb("assessment_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    manualTriggerReceipt: jsonb("manual_trigger_receipt").$type<Record<string, unknown>>(),
    partialIssueIds: jsonb("partial_issue_ids").$type<string[]>().notNull().default([]),
    responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
    escalationDueAt: timestamp("escalation_due_at", { withTimezone: true }).notNull(),
    actionDueAt: timestamp("action_due_at", { withTimezone: true }),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyDateTypeUq: uniqueIndex("standup_sessions_company_date_type_uq").on(
      table.companyId,
      table.localDate,
      table.standupType,
    ),
    policyDateIdx: index("standup_sessions_policy_date_idx").on(table.policyId, table.localDate),
    routineRunIdx: index("standup_sessions_routine_run_idx").on(table.routineRunId),
    dueIdx: index("standup_sessions_due_idx").on(table.companyId, table.status, table.responseDueAt, table.escalationDueAt),
  }),
);

export const standupParticipants = pgTable(
  "standup_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    directiveIssueId: uuid("directive_issue_id").references(() => issues.id, { onDelete: "set null" }),
    responseStatus: text("response_status").notNull().default("pending"),
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
    escalationDueAt: timestamp("escalation_due_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    escalationId: uuid("escalation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sessionAgentUq: uniqueIndex("standup_participants_session_agent_uq").on(table.sessionId, table.agentId),
    companyDeadlineIdx: index("standup_participants_company_deadline_idx").on(
      table.companyId,
      table.responseStatus,
      table.responseDueAt,
      table.escalationDueAt,
    ),
    directiveIssueIdx: index("standup_participants_directive_issue_idx").on(table.directiveIssueId),
  }),
);

export const standupResponses = pgTable(
  "standup_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => standupParticipants.id, { onDelete: "cascade" }),
    actorAgentId: uuid("actor_agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    actorRunId: uuid("actor_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>().notNull(),
    valid: boolean("valid").notNull().default(false),
    rejectedReason: text("rejected_reason"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    participantIdx: index("standup_responses_participant_idx").on(table.participantId, table.submittedAt),
    actorRunIdx: index("standup_responses_actor_run_idx").on(table.actorRunId),
    acceptedParticipantUq: uniqueIndex("standup_responses_accepted_participant_uq")
      .on(table.participantId)
      .where(sql`${table.valid} = true`),
  }),
);

export const standupActions = pgTable(
  "standup_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    ownerAgentId: uuid("owner_agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    linkedCommentId: uuid("linked_comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    serviceRunId: uuid("service_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    canonicalKey: text("canonical_key").notNull(),
    sourceBlockerKey: text("source_blocker_key").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    proofTarget: text("proof_target").notNull(),
    timingState: text("timing_state").notNull(),
    status: text("status").notNull().default("open"),
    actionJson: jsonb("action_json").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalKeyUq: uniqueIndex("standup_actions_company_canonical_key_uq").on(table.companyId, table.canonicalKey),
    sessionIdx: index("standup_actions_session_idx").on(table.sessionId),
    ownerDueIdx: index("standup_actions_owner_due_idx").on(table.companyId, table.ownerAgentId, table.dueAt),
    issueIdx: index("standup_actions_issue_idx").on(table.issueId),
  }),
);

export const standupEscalations = pgTable(
  "standup_escalations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").notNull().references(() => standupParticipants.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    actingOwnerAgentId: uuid("acting_owner_agent_id").notNull().references(() => agents.id),
    escalationIssueId: uuid("escalation_issue_id").references(() => issues.id, { onDelete: "set null" }),
    serviceRunId: uuid("service_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    canonicalKey: text("canonical_key").notNull(),
    reason: text("reason").notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    closureCondition: text("closure_condition").notNull(),
    deliveryProofId: text("delivery_proof_id"),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalKeyUq: uniqueIndex("standup_escalations_company_canonical_key_uq").on(table.companyId, table.canonicalKey),
    sessionParticipantIdx: index("standup_escalations_session_participant_idx").on(table.sessionId, table.participantId),
    deadlineIdx: index("standup_escalations_deadline_idx").on(table.companyId, table.status, table.deadlineAt),
    issueIdx: index("standup_escalations_issue_idx").on(table.escalationIssueId),
  }),
);

export const standupOutboxJobs = pgTable(
  "standup_outbox_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id").references(() => standupParticipants.id, { onDelete: "set null" }),
    actionId: uuid("action_id").references(() => standupActions.id, { onDelete: "set null" }),
    escalationId: uuid("escalation_id").references(() => standupEscalations.id, { onDelete: "set null" }),
    serviceRunId: uuid("service_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    jobType: text("job_type").notNull(),
    priority: integer("priority").notNull().default(100),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    lastError: text("last_error"),
    replayOfJobId: uuid("replay_of_job_id").references((): AnyPgColumn => standupOutboxJobs.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("standup_outbox_jobs_company_idempotency_uq").on(table.companyId, table.idempotencyKey),
    retryScanIdx: index("standup_outbox_jobs_retry_scan_idx").on(
      table.status,
      table.nextAttemptAt,
      table.priority,
      table.createdAt,
    ),
    deadlinePriorityIdx: index("standup_outbox_jobs_deadline_priority_idx").on(
      table.companyId,
      table.sessionId,
      table.priority,
      table.nextAttemptAt,
    ),
    deadLetterScanIdx: index("standup_outbox_jobs_dead_letter_scan_idx").on(
      table.companyId,
      table.status,
      table.deadLetteredAt,
    ),
  }),
);

export const standupDeadLetters = pgTable(
  "standup_dead_letters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sessionId: uuid("session_id").notNull().references(() => standupSessions.id, { onDelete: "cascade" }),
    outboxJobId: uuid("outbox_job_id").notNull().references(() => standupOutboxJobs.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    lastError: text("last_error"),
    payloadSnapshot: jsonb("payload_snapshot").$type<Record<string, unknown>>().notNull().default({}),
    replayReceipt: jsonb("replay_receipt").$type<Record<string, unknown>>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    outboxJobUq: uniqueIndex("standup_dead_letters_outbox_job_uq").on(table.outboxJobId),
    companySessionIdx: index("standup_dead_letters_company_session_idx").on(table.companyId, table.sessionId),
    unresolvedIdx: index("standup_dead_letters_unresolved_idx").on(table.companyId, table.resolvedAt),
  }),
);
