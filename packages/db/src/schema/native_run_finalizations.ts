import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { nativeRunResults } from "./native_run_results.js";
import { statusDecisions } from "./status_decisions.js";
import { workAssessments } from "./work_assessments.js";

export const nativeRunFinalizations = pgTable(
  "native_run_finalizations",
  {
    runId: uuid("run_id").primaryKey(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull(),
    phase: text("phase").notNull(),
    attempt: integer("attempt").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    // Server process that took a token-only lease (finalizer or cleanup):
    // {token, bootId, pid, hostHash, processStartedAt}. It names the holder only
    // while `token` equals lease_owner, so a later lease never inherits it. The
    // controller_* columns stay the executor's. Null on rows saved before it existed.
    leaseHolder: jsonb("lease_holder").$type<Record<string, unknown>>(),
    controllerBootId: text("controller_boot_id"),
    controllerPid: integer("controller_pid"),
    // PID space of controllerPid (controller-process-identity hostHash). Null
    // on rows saved before it existed.
    controllerHostHash: text("controller_host_hash"),
    controllerProcessStartedAt: timestamp("controller_process_started_at", {
      withTimezone: true,
    }),
    controllerGeneration: integer("controller_generation").notNull().default(0),
    recoveryState: text("recovery_state"),
    recoveryRequestId: text("recovery_request_id"),
    recoveryHistory: jsonb("recovery_history")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    resultId: uuid("result_id"),
    assessmentId: uuid("assessment_id"),
    decisionId: uuid("decision_id"),
    failureCode: text("failure_code"),
    failureDetail: jsonb("failure_detail").$type<Record<string, unknown>>(),
    controlDeadlineAt: timestamp("control_deadline_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pendingEffectOwnerIdx: index("native_run_finalizations_pending_effect_owner_idx")
      .on(table.companyId, table.issueId, table.decisionId)
      .where(sql`${table.decisionId} is not null AND ${table.resultId} is not null AND ${table.phase} <> 'terminal_failure'`),
    unsafeExportRecoveryIdx: index("native_run_finalizations_unsafe_export_recovery_idx")
      .on(table.companyId, table.issueId, table.runId)
      .where(sql`${table.phase} = 'terminal_failure' AND ${table.failureCode} = 'native_workspace_sync_out_unsafe_archive'`),
    // The `native_accepted_result_lease` ownership kind: outstanding executor
    // leases on an accepted result that is not final yet (reconciler listing).
    // The `native_finalizer_lease` and `native_cleanup_lease` ownership kinds
    // (reconciler listing and settle watch). Both are sparse.
    finalizerLeaseIdx: index("native_run_finalizations_finalizer_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.leaseOwner} like 'native-finalizer:%'`),
    cleanupLeaseIdx: index("native_run_finalizations_cleanup_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.leaseOwner} like 'native-cleanup:%'`),
    acceptedResultLeaseIdx: index("native_run_finalizations_accepted_result_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.resultId} is not null AND ${table.leaseOwner} is not null AND ${table.phase} not in ('committed', 'terminal_failure', 'applied')`),
    controlDeadlineIdx: index("native_run_finalizations_control_deadline_idx")
      .on(table.controlDeadlineAt).where(sql`${table.controlDeadlineAt} is not null`),
    issueCompanyFk: foreignKey({
      columns: [table.companyId, table.issueId],
      foreignColumns: [issues.companyId, issues.id],
      name: "native_run_finalizations_issue_company_fk",
    }),
    runOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId],
      foreignColumns: [heartbeatRuns.companyId, heartbeatRuns.nativeIssueId, heartbeatRuns.id],
      name: "native_run_finalizations_run_owner_fk",
    }),
    resultOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.resultId],
      foreignColumns: [
        nativeRunResults.companyId,
        nativeRunResults.issueId,
        nativeRunResults.runId,
        nativeRunResults.id,
      ],
      name: "native_run_finalizations_result_owner_fk",
    }),
    assessmentOwnerFk: foreignKey({
      columns: [table.companyId, table.issueId, table.runId, table.assessmentId],
      foreignColumns: [
        workAssessments.companyId,
        workAssessments.issueId,
        workAssessments.runId,
        workAssessments.id,
      ],
      name: "native_run_finalizations_assessment_owner_fk",
    }),
    decisionOwnerFk: foreignKey({
      columns: [
        table.companyId,
        table.issueId,
        table.runId,
        table.assessmentId,
        table.decisionId,
      ],
      foreignColumns: [
        statusDecisions.companyId,
        statusDecisions.issueId,
        statusDecisions.runId,
        statusDecisions.assessmentId,
        statusDecisions.id,
      ],
      name: "native_run_finalizations_decision_owner_fk",
    }),
    assessmentRequiresResultCheck: check(
      "native_run_finalizations_assessment_requires_result_check",
      sql`${table.assessmentId} is null or ${table.resultId} is not null`,
    ),
    decisionRequiresAssessmentCheck: check(
      "native_run_finalizations_decision_requires_assessment_check",
      sql`${table.decisionId} is null or ${table.assessmentId} is not null`,
    ),
  }),
);
