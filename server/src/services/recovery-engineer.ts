import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issues,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  projects,
  recoveryEngineerConfigs,
  recoveryEngineerIncidents,
  recoveryEngineerIncidentSources,
  recoveryEngineerProcedures,
  recoveryEngineerProcedureReuses,
  recoveryEngineerVerifications,
} from "@paperclipai/db";
import type {
  RecoveryEngineerActivationRequest,
  RecoveryEngineerConfig,
  RecoveryEngineerConfigInput,
  RecoveryEngineerDiagnoseInput,
  RecoveryEngineerIncidentOutcome,
  RecoveryEngineerProcedureApplicability,
  RecoveryEngineerProcedureInput,
  RecoveryEngineerProcedureReuseInput,
  RecoveryEngineerProcedureReuseStatus,
  RecoveryEngineerProcedureReviewInput,
  RecoveryEngineerRepairInput,
  RecoveryEngineerResumeInput,
  RecoveryEngineerSourceCloseReason,
  RecoveryEngineerVerifyInput,
} from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "../db-errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import {
  executeIssuePostCommitActions,
  issueService,
  type IssuePostCommitAction,
} from "./issues.js";
import {
  classifyAdapterFailureForRecovery,
  isOperatorCancelledRun,
} from "./recovery/service.js";
import {
  RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES,
  RECOVERY_ENGINEER_ORIGIN_KINDS,
  RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES,
  evaluateRecoveryEngineerProcedureApplicability,
  isRecoveryEngineerIssueOrigin,
  type RecoveryEngineerProcedureApplicabilityContext,
  type RecoveryEngineerProcedureReuseSummary,
} from "./recovery-engineer-policy.js";
import {
  buildBlockedIssueEvidence,
  buildRecoveryRunEvidence,
} from "./recovery-engineer-evidence.js";
import { redactSensitiveText } from "../redaction.js";

const INCIDENT_FINGERPRINT_CONSTRAINT = "recovery_engineer_incidents_company_fingerprint_uq";
const VERIFICATION_RUN_CONSTRAINT = "recovery_engineer_verifications_company_review_run_uq";
const PROCEDURE_REUSE_CONSTRAINT = "recovery_engineer_procedure_reuses_key_uq";
const TERMINAL_FAILURE_STATUSES = ["failed", "timed_out"] as const;
const PARTICIPANT_FAILURE_STATUSES = ["failed", "timed_out", "interrupted", "cancelled"] as const;
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const LIVE_WAKE_REQUEST_STATUSES = ["queued", "deferred_issue_execution", "claimed"] as const;
const SWEEP_BATCH_SIZE = 100;
const INITIAL_SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
// Bounded automatic replay of a claimed resume whose wake never materialized a
// run (crash between claim and dispatch, or a suppressed wake). Past the cap
// the generation is superseded and the board owns the next action, so a stuck
// dispatch can never become an infinite retry loop.
const RESUME_DISPATCH_MAX_ATTEMPTS = 3;
// The same bound for the incident's own dispatch intents (diagnose wake,
// repair wake, post-activation resume wake). The agent_wakeup_requests rows
// written under the dispatch idempotency key are the durable attempt ledger:
// exactly one row per attempt, written by the wakeup path for suppressed or
// refused enqueues and by the reconciliation sweep for a failure that
// produced no row at all. A claim whose dispatch never materialized is
// therefore re-armable after a restart, adoptable when the wake already
// exists, and bounded instead of endlessly re-derived.
const INCIDENT_DISPATCH_MAX_ATTEMPTS = 3;
const DIAGNOSE_DISPATCH_KEY_PREFIX = "recovery-engineer:diagnose:";
const REPAIR_WAKE_KEY_PREFIX = "recovery-engineer:repair-wake:";
const ACTIVATED_WAKE_KEY_PREFIX = "recovery-engineer:activated:";
const BOARD_ESCALATION_ACTION_PREFIX = "Inspect recovery incident ";
/** Escalation reasons that mean "the dispatch intent never produced a run".
 * Only these are re-armable: the single diagnosis attempt is still unspent in
 * substance, so the sweep may spend another bounded enqueue on the same
 * incident. Every other escalation reason is an outcome or authority decision
 * the board owns and is never overwritten. */
const DIAGNOSIS_DISPATCH_ESCALATION_REASONS = [
  "diagnosis_enqueue_failed",
  "diagnosis_not_enqueued",
] as const;
const REPAIR_DISPATCH_ESCALATION_REASONS = [
  "repair_enqueue_failed",
  "repair_not_enqueued",
] as const;
const ACTIVATED_DISPATCH_ESCALATION_REASONS = [
  "post_activation_resume_wake_not_enqueued",
] as const;
const REARMABLE_DISPATCH_ESCALATION_REASONS = [
  ...DIAGNOSIS_DISPATCH_ESCALATION_REASONS,
  ...REPAIR_DISPATCH_ESCALATION_REASONS,
  ...ACTIVATED_DISPATCH_ESCALATION_REASONS,
] as const;
const DIAGNOSIS_DISPATCH_EXHAUSTED_REASON = "diagnosis_dispatch_attempts_exhausted";
const REPAIR_DISPATCH_EXHAUSTED_REASON = "repair_dispatch_attempts_exhausted";
const ACTIVATED_DISPATCH_EXHAUSTED_REASON = "post_activation_resume_attempts_exhausted";
/** Wake-request outcomes that mean a known real hold owns the dispatch
 * (scheduling suppression, a paused or budget-held participant, an issue
 * tree pause, the agent's scheduling policy, a heartbeat daily cap). They
 * park the intent without spending a charge: the condition owner re-enables
 * dispatching, and the sweep re-arms once the condition can be re-verified or
 * the backoff has elapsed. Recognized holds never escalate on their own. */
const DISPATCH_HOLD_SKIP_REASONS = [
  "agent.not_invokable",
  "budget.blocked",
  "company.inactive",
  "heartbeat.scheduling_suppressed",
  "heartbeat.daily_run_limit",
  "heartbeat.daily_cost_limit",
  "issue_tree_hold_active",
  "heartbeat.wakeOnDemand.disabled",
  "heartbeat.disabled",
  "heartbeat.timer.no_actionable_work",
] as const;
const DISPATCH_REARM_BASE_BACKOFF_MS = 30 * 60 * 1_000;
const DISPATCH_REARM_MAX_BACKOFF_MS = 24 * 60 * 60 * 1_000;
/** Ledger marker for a wake row whose run is a parked scheduled-retry
 * carrier: the dispatch is durably parked by the scheduler and will mature
 * or be superseded by its own owner. It is a wait, never an admission. */
const DISPATCH_PARK_CARRIER_HOLD = "scheduled_retry_park_carrier";
/** Durable in-flight marker for an incident dispatch pass: between the
 * dispatch decision (a short advisory-locked transaction) and the enqueue —
 * which runs OUTSIDE any connection-holding transaction so a supported pool
 * size of 1 cannot deadlock — the claimed wake-request row is the intent's
 * dispatch lease. A fresh claimed row makes concurrent dispatchers stand
 * down; a stale one (crash between claim and enqueue) is converted into the
 * failed-attempt row it represents and re-derived under the bounded cap. */
const DISPATCH_CLAIM_REASON = "recovery_engineer_dispatch_claim";
const DISPATCH_CLAIM_STALE_MS = 2 * 60 * 1_000;
const DISPATCH_ENQUEUE_FAILED_REASON = "recovery_engineer_dispatch_enqueue_failed";
/** Stable failure marker for a refused pre-start binding: the incident moved
 * on (a terminal/manual outcome won) between the dispatch decision and the
 * dispatcher's run-creation transaction, so the enqueue rolled back. The
 * dispatch stands down; it is never a charge and never a duplicate. */
const DISPATCH_BINDING_LOST_MESSAGE = "recovery_incident_dispatch_binding_lost";
/** Stable failure marker for an enqueue whose dispatch claim was replaced:
 * the lease expired and another dispatcher converted it and re-claimed the
 * intent, so this late enqueue must not produce an executable run. */
const DISPATCH_CLAIM_REPLACED_MESSAGE = "recovery_incident_dispatch_claim_replaced";
const LIFENESS_ADVANCED_STATES = ["advanced", "completed"] as const;
const ACTIVATION_WAIT_PREFIX = "Activate verified repair commit";
/** Incident statuses that carry a newer manual/terminal disposition: a
 * pending-outcome roll-up must never downgrade them back to `resumed`. */
const RESUME_STAGE_PROTECTED_STATUSES = ["escalated", "gated", "resolved"] as const;
/** The routine bookkeeping reason for replacing an older generation with a
 * newer observation of the same issue. */
const SUPERSEDED_BY_NEWER_GENERATION = "superseded_by_newer_generation";
/** Incident statuses that cannot act on a newly observed generation of the same
 * failure: the recurrence is recorded for the board instead of being
 * re-diagnosed. */
const RECURRENCE_ESCALATION_STATUSES = ["resolved", "resumed", "gated", "escalated"] as const;

export type RecoveryEngineerActor = {
  actorType: "agent" | "user";
  agentId: string | null;
  userId: string | null;
  runId: string | null;
  board: boolean;
};

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

/** The minimal transactional surface a pre-start run binding may write
 * through: a real transaction handle (the dispatcher's run-creation
 * transaction) or the database client itself. */
type DispatchBindingTx = Pick<Db, "select" | "insert" | "update" | "execute">;

/** Binds a materialized run to its incident authority before the dispatcher
 * can claim it. Receives the run row inside the dispatcher's own
 * run-creation transaction (fresh wake or parked carrier); throwing refuses
 * admission and rolls the enqueue back. */
type RecoveryRunBinding = (
  run: typeof heartbeatRuns.$inferSelect,
  tx: DispatchBindingTx,
) => Promise<void>;

type RecoveryEngineerWakeup = (
  agentId: string,
  opts: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown>;
    contextSnapshot?: Record<string, unknown>;
    requestedByActorType?: "agent" | "user" | "system";
    requestedByActorId?: string | null;
    idempotencyKey?: string;
    bindRun?: RecoveryRunBinding | null;
  },
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type IncidentRow = typeof recoveryEngineerIncidents.$inferSelect;
type ConfigRow = typeof recoveryEngineerConfigs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type RunRow = typeof heartbeatRuns.$inferSelect;
type SourceRow = typeof recoveryEngineerIncidentSources.$inferSelect;
type ProcedureRow = typeof recoveryEngineerProcedures.$inferSelect;
type ProcedureReuseRow = typeof recoveryEngineerProcedureReuses.$inferSelect;
type ParticipantRole = "recovery" | "repair" | "reviewer";

/** The open failure generation a dispatch intent is bound to: the source
 * issue it came from, the native generation key that captured it, and the
 * owner that held the issue when the failure was observed. */
type IncidentSourceGeneration = {
  sourceIssueId: string;
  generationKey: string;
  originalOwnerAgentId: string | null;
};

/** Sweep pass over the incident's own dispatch intents (diagnose wake, repair
 * wake, post-activation resume wake). `evaluated` counts selected incidents;
 * `rearmed` counts intents that materialized a new or adopted run dispatch,
 * `adopted` intents that converged on an existing live wake, `completed`
 * intents whose adopted wake already carried an outcome, `held` intents kept
 * pending (live path, gate, hold park, or unavailable participant) without
 * spending a charge, and `exhausted` intents handed to the board at the
 * attempt cap. */
type IncidentDispatchReconciliation = {
  evaluated: number;
  rearmed: number;
  adopted: number;
  completed: number;
  held: number;
  exhausted: number;
};

/** The durable attempt ledger for one incident dispatch intent, classified
 * from its agent_wakeup_requests rows: `charges` counts admitted dispatches
 * (rows whose run materialized), this flow's own failure markers, and
 * unrecognized skips; `newestHoldReason`/`holdStreak`/`newestRowAt` describe
 * the recognized hold the intent is parked on, if any; `liveRealWake` is a
 * wake whose dispatch materialized (or still owns a durable queued path);
 * `freshClaim`/`staleClaim` are this flow's own dispatch lease rows (an
 * in-flight enqueue, or a lease expired by a crash between claim and
 * enqueue). */
type IncidentDispatchLedger = {
  charges: number;
  newestHoldReason: string | null;
  holdStreak: number;
  newestRowAt: Date | null;
  liveRealWake: typeof agentWakeupRequests.$inferSelect | null;
  freshClaim: typeof agentWakeupRequests.$inferSelect | null;
  staleClaim: typeof agentWakeupRequests.$inferSelect | null;
};

/** Linked-run facts classification needs beyond the raw status: whether the
 * run is a suppressed-wake park carrier (its durable `suppressedWakePark`
 * marker), which distinguishes a gate-cancelled carrier (a stale intent that
 * never executed) from a genuinely cancelled execution. */
type DispatchRunInfo = {
  status: string | null;
  parkCarrier: boolean;
};

/** Persisted dispatch intent for one source generation. Replaying the same key
 * after a restart converges on the same wake instead of minting a new one. */
function resumeIdempotencyKeyFor(incidentId: string, sourceId: string) {
  return `recovery-engineer:resume:${incidentId}:${sourceId}`;
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runIssueId(run: Pick<RunRow, "nativeIssueId" | "contextSnapshot">) {
  const context = parseObject(run.contextSnapshot);
  return run.nativeIssueId ?? readString(context.issueId) ?? readString(context.taskId);
}

function publicConfig(row: ConfigRow): RecoveryEngineerConfig {
  return {
    enabled: row.enabled,
    agentId: row.agentId,
    repairAgentId: row.repairAgentId,
    reviewerAgentId: row.reviewerAgentId,
    projectId: row.projectId,
    ...(row.repairProjectIds && Object.keys(row.repairProjectIds).length > 0
      ? { repairProjectIds: row.repairProjectIds }
      : {}),
    maxAttempts: 1,
    sweepIntervalSec: 300,
  };
}

function participantRole(config: ConfigRow, agentId: string | null): ParticipantRole | null {
  if (!agentId) return null;
  if (agentId === config.agentId) return "recovery";
  if (agentId === config.repairAgentId) return "repair";
  if (agentId === config.reviewerAgentId) return "reviewer";
  return null;
}

function cursorCondition<T extends { createdAt: Date; id: string }>(
  table: { createdAt: unknown; id: unknown },
  cursor: T | null,
) {
  if (!cursor) return undefined;
  return or(
    lt(table.createdAt as never, cursor.createdAt),
    and(eq(table.createdAt as never, cursor.createdAt), lt(table.id as never, cursor.id)),
  );
}

export function recoveryEngineerService(
  db: Db,
  deps: { enqueueWakeup: RecoveryEngineerWakeup },
) {
  const issuesSvc = issueService(db);
  const sweepingCompanies = new Set<string>();

  async function getConfigRow(companyId: string, dbOrTx: DbOrTransaction = db) {
    return dbOrTx
      .select()
      .from(recoveryEngineerConfigs)
      .where(eq(recoveryEngineerConfigs.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function getConfig(companyId: string) {
    const row = await getConfigRow(companyId);
    return row ? publicConfig(row) : null;
  }

  async function validateConfiguration(companyId: string, input: RecoveryEngineerConfigInput) {
    const distinctAgentIds = new Set([
      input.agentId,
      input.repairAgentId,
      input.reviewerAgentId,
    ]);
    if (distinctAgentIds.size !== 3) {
      throw unprocessable("Recovery, repair, and reviewer agents must be distinct");
    }

    const configuredAgents = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...distinctAgentIds])));
    if (configuredAgents.length !== 3) {
      throw unprocessable("Every recovery participant must belong to the configured company");
    }
    if (input.enabled) {
      for (const configuredAgent of configuredAgents) {
        const invokability = await evaluateAgentInvokabilityFromDb(db, configuredAgent);
        if (!invokability.invokable) {
          throw unprocessable("Recovery cannot be enabled with a non-invokable participant", {
            agentId: configuredAgent.id,
            reason: invokability.reason,
          });
        }
      }
    }

    const projectIds = new Set([
      input.projectId,
      ...Object.values(input.repairProjectIds ?? {}).filter(
        (value): value is string => typeof value === "string",
      ),
    ]);
    const configuredProjects = await db
      .select({ id: projects.id, archivedAt: projects.archivedAt, pausedAt: projects.pausedAt })
      .from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, [...projectIds])));
    if (configuredProjects.length !== projectIds.size) {
      throw unprocessable("Every recovery project must belong to the configured company");
    }
    const unavailableProject = configuredProjects.find((project) => project.archivedAt || project.pausedAt);
    if (input.enabled && unavailableProject) {
      throw unprocessable("Recovery cannot be enabled with an archived or paused project", {
        projectId: unavailableProject.id,
      });
    }
  }

  async function putConfig(companyId: string, input: RecoveryEngineerConfigInput, userId: string) {
    await validateConfiguration(companyId, input);
    const now = new Date();
    const row = await db
      .insert(recoveryEngineerConfigs)
      .values({
        companyId,
        enabled: input.enabled,
        agentId: input.agentId,
        repairAgentId: input.repairAgentId,
        reviewerAgentId: input.reviewerAgentId,
        projectId: input.projectId,
        repairProjectIds: input.repairProjectIds ?? null,
        maxAttempts: 1,
        sweepIntervalSec: 300,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: recoveryEngineerConfigs.companyId,
        set: {
          enabled: input.enabled,
          agentId: input.agentId,
          repairAgentId: input.repairAgentId,
          reviewerAgentId: input.reviewerAgentId,
          projectId: input.projectId,
          repairProjectIds: input.repairProjectIds ?? null,
          maxAttempts: 1,
          sweepIntervalSec: 300,
          lastSweepAt: null,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0]!);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      agentId: null,
      runId: null,
      action: "recovery_engineer.config_updated",
      entityType: "company",
      entityId: companyId,
      details: {
        enabled: input.enabled,
        agentId: input.agentId,
        repairAgentId: input.repairAgentId,
        reviewerAgentId: input.reviewerAgentId,
        projectId: input.projectId,
        repairProjectIds: input.repairProjectIds ?? null,
        maxAttempts: 1,
        sweepIntervalSec: 300,
      },
    });
    return publicConfig(row);
  }

  async function resolveIncidentForIssue(issueId: string) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) return null;

    const direct = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(and(
        eq(recoveryEngineerIncidents.companyId, issue.companyId),
        or(
          eq(recoveryEngineerIncidents.maintenanceIssueId, issue.id),
          eq(recoveryEngineerIncidents.repairIssueId, issue.id),
        ),
      ))
      .orderBy(desc(recoveryEngineerIncidents.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (direct) return { issue, incident: direct, participantScoped: true };

    if (isRecoveryEngineerIssueOrigin(issue.originKind) && issue.originId) {
      const byOrigin = await db
        .select()
        .from(recoveryEngineerIncidents)
        .where(and(
          eq(recoveryEngineerIncidents.id, issue.originId),
          eq(recoveryEngineerIncidents.companyId, issue.companyId),
        ))
        .then((rows) => rows[0] ?? null);
      if (byOrigin) return { issue, incident: byOrigin, participantScoped: true };
    }

    if (issue.parentId) {
      const ancestorRows = await db.execute(sql`
        WITH RECURSIVE ancestors(id, parent_id, origin_kind, origin_id, depth) AS (
          SELECT id, parent_id, origin_kind, origin_id, 0
          FROM issues
          WHERE company_id = ${issue.companyId}
            AND id = ${issue.parentId}
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.origin_kind, parent.origin_id, ancestors.depth + 1
          FROM issues parent
          JOIN ancestors ON parent.id = ancestors.parent_id
          WHERE parent.company_id = ${issue.companyId}
            AND ancestors.depth < 63
        )
        SELECT incident.id AS "incidentId"
        FROM ancestors
        JOIN recovery_engineer_incidents incident
          ON incident.company_id = ${issue.companyId}
          AND (
            incident.maintenance_issue_id = ancestors.id
            OR incident.repair_issue_id = ancestors.id
            OR (
              ancestors.origin_kind IN (
                ${RECOVERY_ENGINEER_ORIGIN_KINDS.incident},
                ${RECOVERY_ENGINEER_ORIGIN_KINDS.repair}
              )
              AND incident.id::text = ancestors.origin_id
            )
          )
        ORDER BY ancestors.depth ASC
        LIMIT 1
      `);
      const ancestorCandidate = Array.from(ancestorRows)[0];
      const ancestorIncidentId =
        ancestorCandidate &&
        typeof ancestorCandidate === "object" &&
        "incidentId" in ancestorCandidate &&
        typeof ancestorCandidate.incidentId === "string"
          ? ancestorCandidate.incidentId
          : null;
      if (ancestorIncidentId) {
        const ancestorIncident = await db
          .select()
          .from(recoveryEngineerIncidents)
          .where(eq(recoveryEngineerIncidents.id, ancestorIncidentId))
          .then((rows) => rows[0] ?? null);
        if (ancestorIncident) {
          return { issue, incident: ancestorIncident, participantScoped: true };
        }
      }
    }

    const source = await db
      .select({ incident: recoveryEngineerIncidents })
      .from(recoveryEngineerIncidentSources)
      .innerJoin(
        recoveryEngineerIncidents,
        eq(recoveryEngineerIncidentSources.incidentId, recoveryEngineerIncidents.id),
      )
      .where(and(
        eq(recoveryEngineerIncidentSources.companyId, issue.companyId),
        eq(recoveryEngineerIncidentSources.sourceIssueId, issue.id),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt))
      .limit(1)
      .then((rows) => rows[0]?.incident ?? null);
    return source ? { issue, incident: source, participantScoped: false } : null;
  }

  async function listIncidentIssueIds(incident: IncidentRow) {
    const sourceIds = await db
      .select({ sourceIssueId: recoveryEngineerIncidentSources.sourceIssueId })
      .from(recoveryEngineerIncidentSources)
      .where(eq(recoveryEngineerIncidentSources.incidentId, incident.id));
    return new Set([
      incident.maintenanceIssueId,
      incident.repairIssueId,
      ...sourceIds.map((row) => row.sourceIssueId),
    ].filter((value): value is string => Boolean(value)));
  }

  async function getActorRun(
    actor: RecoveryEngineerActor,
    config: ConfigRow,
    incident: IncidentRow,
    allowedRoles: ParticipantRole[],
    requiredIssue: "maintenance" | "repair" | "any" = "any",
  ) {
    if (actor.board) return { role: null as ParticipantRole | null, run: null as RunRow | null };
    const role = participantRole(config, actor.agentId);
    if (!role || !allowedRoles.includes(role)) {
      throw forbidden("Recovery action is not authorized for this configured participant");
    }
    if (!config.enabled) throw forbidden("Recovery engineer is disabled");
    if (!actor.runId || !actor.agentId) {
      throw forbidden("Recovery participant actions require a run-scoped agent identity");
    }
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, actor.runId),
        eq(heartbeatRuns.companyId, incident.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) throw forbidden("Recovery participant run is unavailable");
    if (!ACTIVE_RUN_STATUSES.includes(run.status as never)) {
      throw forbidden("Recovery participant actions require an active current run");
    }
    const scopedIssueId = runIssueId(run);
    const allowedIssueIds = await listIncidentIssueIds(incident);
    if (!scopedIssueId || !allowedIssueIds.has(scopedIssueId)) {
      throw forbidden("Recovery participant run is not scoped to this incident");
    }
    if (requiredIssue === "maintenance" && scopedIssueId !== incident.maintenanceIssueId) {
      throw forbidden("This action requires the incident maintenance run");
    }
    if (requiredIssue === "repair" && scopedIssueId !== incident.repairIssueId) {
      throw forbidden("This action requires the incident repair review run");
    }
    return { role, run };
  }

  async function assertReadAuthority(
    actor: RecoveryEngineerActor,
    config: ConfigRow,
    incident: IncidentRow,
  ) {
    await getActorRun(actor, config, incident, ["recovery", "repair", "reviewer"]);
  }

  async function readSourceContext(source: typeof recoveryEngineerIncidentSources.$inferSelect) {
    const issue = await db.select().from(issues).where(and(
      eq(issues.id, source.sourceIssueId),
      eq(issues.companyId, source.companyId),
    )).then((rows) => rows[0] ?? null);
    if (!issue) return null;
    const [comments, latestRun, owner, humanGate, dependencyGate] = await Promise.all([
      db.select({
        id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt,
      }).from(issueComments).where(and(
        eq(issueComments.companyId, source.companyId),
        eq(issueComments.issueId, source.sourceIssueId),
        isNull(issueComments.deletedAt),
      )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(21),
      latestIssueRun(issue),
      issue.assigneeAgentId
        ? db.select().from(agents).where(and(
          eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, source.companyId),
        )).then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      hasPendingHumanGate(issue),
      hasUnresolvedDependency(issue),
    ]);
    const invokability = owner ? await evaluateAgentInvokabilityFromDb(db, owner) : null;
    return {
      // This is current diagnostic evidence, not a replacement for the captured
      // failure generation or authorization to resume it.
      issueId: issue.id,
      status: issue.status,
      statusVersion: issue.statusVersion,
      updatedAt: issue.updatedAt,
      ownerChanged: issue.assigneeAgentId !== source.originalOwnerAgentId ||
        issue.assigneeUserId !== source.originalOwnerUserId,
      owner: owner ? {
        id: owner.id, status: owner.status, invokable: invokability?.invokable ?? false,
      } : null,
      gates: {
        human: humanGate,
        dependency: dependencyGate,
        executionLocked: Boolean(issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt),
      },
      comments: comments.slice(0, 20).map((comment) => {
        const body = redactSensitiveText(comment.body);
        return { ...comment, body: body.slice(0, 20_000), truncated: body.length > 20_000 };
      }),
      commentsHasMore: comments.length > 20,
      latestRun: latestRun
        ? buildRecoveryRunEvidence(latestRun, owner?.adapterType ?? "unknown", issue.id).evidence
        : null,
    };
  }

  async function readContext(input: {
    issueId: string;
    actor: RecoveryEngineerActor;
    sourceLimit: number;
    sourceCursor?: string | null;
    procedureLimit: number;
    procedureCursor?: string | null;
  }) {
    const resolved = await resolveIncidentForIssue(input.issueId);
    if (!resolved) throw notFound("Recovery incident not found");
    const config = await getConfigRow(resolved.issue.companyId);
    if (!config) throw notFound("Recovery engineer is not configured");
    await assertReadAuthority(input.actor, config, resolved.incident);

    const sourceCursor = input.sourceCursor
      ? await db
        .select({ id: recoveryEngineerIncidentSources.id, createdAt: recoveryEngineerIncidentSources.createdAt })
        .from(recoveryEngineerIncidentSources)
        .where(and(
          eq(recoveryEngineerIncidentSources.id, input.sourceCursor),
          eq(recoveryEngineerIncidentSources.incidentId, resolved.incident.id),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (input.sourceCursor && !sourceCursor) throw badRequest("Invalid recovery source cursor");
    const sourceRows = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, resolved.incident.id),
        cursorCondition(recoveryEngineerIncidentSources, sourceCursor),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.createdAt), desc(recoveryEngineerIncidentSources.id))
      .limit(input.sourceLimit + 1);
    const sourceHasMore = sourceRows.length > input.sourceLimit;
    const visibleSources = sourceRows.slice(0, input.sourceLimit);

    const procedureCursor = input.procedureCursor
      ? await db
        .select({ id: recoveryEngineerProcedures.id, createdAt: recoveryEngineerProcedures.createdAt })
        .from(recoveryEngineerProcedures)
        .where(and(
          eq(recoveryEngineerProcedures.id, input.procedureCursor),
          eq(recoveryEngineerProcedures.companyId, resolved.incident.companyId),
          eq(recoveryEngineerProcedures.status, "reviewed"),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (input.procedureCursor && !procedureCursor) throw badRequest("Invalid recovery procedure cursor");
    const relevantProcedure = resolved.incident.classification
      ? or(
        eq(recoveryEngineerProcedures.failureFingerprint, resolved.incident.failureFingerprint),
        eq(recoveryEngineerProcedures.classification, resolved.incident.classification),
      )
      : eq(recoveryEngineerProcedures.failureFingerprint, resolved.incident.failureFingerprint);
    const procedureRows = await db
      .select()
      .from(recoveryEngineerProcedures)
      .where(and(
        eq(recoveryEngineerProcedures.companyId, resolved.incident.companyId),
        eq(recoveryEngineerProcedures.status, "reviewed"),
        relevantProcedure,
        cursorCondition(recoveryEngineerProcedures, procedureCursor),
      ))
      .orderBy(desc(recoveryEngineerProcedures.createdAt), desc(recoveryEngineerProcedures.id))
      .limit(input.procedureLimit + 1);
    const procedureHasMore = procedureRows.length > input.procedureLimit;
    const visibleProcedures = procedureRows.slice(0, input.procedureLimit);

    const verification = resolved.incident.verifiedVerificationId
      ? await db
        .select()
        .from(recoveryEngineerVerifications)
        .where(and(
          eq(recoveryEngineerVerifications.id, resolved.incident.verifiedVerificationId),
          eq(recoveryEngineerVerifications.incidentId, resolved.incident.id),
        ))
        .then((rows) => rows[0] ?? null)
      : await db
        .select()
        .from(recoveryEngineerVerifications)
        .where(eq(recoveryEngineerVerifications.incidentId, resolved.incident.id))
        .orderBy(desc(recoveryEngineerVerifications.submittedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

    // Reviewed procedures are diagnostic aids, so the read carries the
    // applicability verdict and reuse history for the context that is live
    // right now: an old review of another context is visible as not applicable
    // instead of being silently available as a blind retry.
    const contextSource = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, resolved.incident.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const applicabilityContext = await procedureApplicabilityContextForIncident(
      resolved.incident,
      contextSource,
    );
    const reviewedProcedures = await Promise.all(visibleProcedures.map(async (procedure) => {
      const reuses = await loadProcedureReuses(procedure.id);
      return {
        ...procedure,
        applicabilityVerdict: evaluateRecoveryEngineerProcedureApplicability({
          procedure,
          context: applicabilityContext,
          evidenceKey: null,
          reuseHistory: reuses.map((reuse) => ({
            status: reuse.status,
            evidenceKey: reuse.evidenceKey,
            sourceGenerationKey: reuse.sourceGenerationKey,
          })),
        }),
        reuses,
      };
    }));

    return {
      config: publicConfig(config),
      incident: resolved.incident,
      sources: await Promise.all(visibleSources.map(async (source) => ({
        ...source,
        currentContext: await readSourceContext(source),
      }))),
      sourcesPage: {
        limit: input.sourceLimit,
        hasMore: sourceHasMore,
        nextCursor: sourceHasMore ? visibleSources.at(-1)?.id ?? null : null,
      },
      reviewedProcedures,
      proceduresPage: {
        limit: input.procedureLimit,
        hasMore: procedureHasMore,
        nextCursor: procedureHasMore ? visibleProcedures.at(-1)?.id ?? null : null,
      },
      resumeGate: {
        status: !resolved.incident.verifiedAt
          ? "verification_required"
          : !resolved.incident.activatedAt ||
              resolved.incident.activatedRepairCommit !== resolved.incident.repairCommit
            ? "activation_required"
            : "activation_confirmed",
        verifiedRepairCommit: resolved.incident.repairCommit,
        activatedRepairCommit: resolved.incident.activatedRepairCommit,
        activatedAt: resolved.incident.activatedAt,
        activationEvidence: resolved.incident.activationEvidence,
      },
      verification,
    };
  }

  async function hasPendingHumanGate(issue: IssueRow, reviewAccepted = false) {
    if (issue.assigneeUserId || issue.status === "backlog" || (issue.status === "in_review" && !reviewAccepted)) return true;
    if (issue.unblockDescriptor) return true;
    const [interaction, approval, pauseHold, unavailableOwner] = await Promise.all([
      db
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, issue.companyId),
          eq(issueApprovals.issueId, issue.id),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: issueTreeHolds.id })
        .from(issueTreeHoldMembers)
        .innerJoin(issueTreeHolds, eq(issueTreeHoldMembers.holdId, issueTreeHolds.id))
        .where(and(
          eq(issueTreeHoldMembers.companyId, issue.companyId),
          eq(issueTreeHoldMembers.issueId, issue.id),
          eq(issueTreeHoldMembers.skipped, false),
          eq(issueTreeHolds.status, "active"),
          eq(issueTreeHolds.mode, "pause"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      issue.assigneeAgentId
        ? db
          .select({ id: agents.id })
          .from(agents)
          .where(and(
            eq(agents.id, issue.assigneeAgentId),
            eq(agents.companyId, issue.companyId),
            inArray(agents.status, ["paused", "terminated", "pending_approval"]),
          ))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    return Boolean(interaction || approval || pauseHold || unavailableOwner);
  }

  async function hasUnresolvedDependency(issue: IssueRow) {
    const readiness = await issuesSvc.getDependencyReadiness(issue.id);
    return !readiness.isDependencyReady;
  }

  async function latestIssueRun(issue: IssueRow, dbOrTx: DbOrTransaction = db) {
    return dbOrTx
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, issue.companyId),
        or(
          eq(heartbeatRuns.nativeIssueId, issue.id),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}`,
        ),
      ))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  /**
   * A live run, or a queued/claimed wake for the issue's next actor, already
   * owns the next action. A source generation is then held open instead of
   * being closed over an in-flight path, and the maintenance wait is not
   * rewritten on top of someone else's queued work.
   */
  async function hasLiveExecutionPath(
    issue: IssueRow,
    agentId: string | null,
    options: { excludeRunId?: string | null; dbOrTx?: DbOrTransaction } = {},
  ) {
    const dbOrTx = options.dbOrTx ?? db;
    const liveRun = await dbOrTx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, issue.companyId),
        inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        options.excludeRunId ? ne(heartbeatRuns.id, options.excludeRunId) : undefined,
        or(
          eq(heartbeatRuns.nativeIssueId, issue.id),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}`,
        ),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (liveRun) return true;
    if (!agentId) return false;
    const liveWake = await dbOrTx
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.status, LIVE_WAKE_REQUEST_STATUSES),
        or(
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
          sql`${agentWakeupRequests.payload} ->> 'taskId' = ${issue.id}`,
          sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issue.id}`,
          sql`${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${issue.id}`,
        ),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(liveWake);
  }

  /**
   * Gate vocabulary of the issue as it stands now, for applicability and
   * dispatch rules. Provider quota is classified from the issue's current run
   * exactly like admission does, so a provider gate is a gate here too instead
   * of an unreachable vocabulary entry.
   */
  async function sourceGateKind(
    issue: IssueRow,
    run: RunRow | null,
  ): Promise<RecoveryEngineerProcedureApplicabilityContext["gate"]> {
    if (issue.assigneeUserId) return "owner";
    if (await hasPendingHumanGate(issue)) return "human";
    if (await hasUnresolvedDependency(issue)) return "dependency";
    if (run && classifyAdapterFailureForRecovery(run, new Date())?.kind === "provider_quota") {
      return "provider";
    }
    return "none";
  }

  /**
   * The live context a procedure would be applied in: the failure fingerprint
   * and classification of the incident, the adapter of the run currently
   * working the source, the activated repair commit, and whether anybody else
   * holds a gate right now. Recorded with every reuse so a later reader can
   * see exactly which context authorized (or refused) it.
   */
  async function procedureApplicabilityContextForIncident(
    incident: IncidentRow,
    source: SourceRow | null,
  ): Promise<RecoveryEngineerProcedureApplicabilityContext> {
    const sourceIssue = source
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, source.sourceIssueId),
          eq(issues.companyId, incident.companyId),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    const latestRun = sourceIssue ? await latestIssueRun(sourceIssue) : null;
    const adapterType = latestRun ? await sourceAgentAdapterType(latestRun) : null;
    return {
      failureFingerprint: incident.failureFingerprint,
      classification: incident.classification,
      adapterType,
      gate: sourceIssue ? await sourceGateKind(sourceIssue, latestRun) : "none",
      // Only an activated repair may authorize a procedure: verified but not
      // yet installed is still not the context anyone reviewed.
      activatedRepairCommit: incident.activatedAt ? incident.activatedRepairCommit : null,
      sourceGenerationKey: source?.generationKey ?? null,
    };
  }

  /**
   * A run counts as evidence about a generation only when it is not the failed
   * run itself and it is either the dispatched continuation of this generation
   * or newer than the observation that captured it.
   */
  function isPostFailureRunForSource(source: SourceRow, run: RunRow) {
    if (run.id === source.sourceRunId) return false;
    if (run.id === source.resumedRunId) return true;
    const observedAt = source.observedAt?.getTime() ?? 0;
    const createdAt = run.createdAt?.getTime() ?? 0;
    return createdAt >= observedAt;
  }

  /**
   * The single place a source failure generation stops being open. Recovery is
   * recorded only with the evidence that proved the original path overcame the
   * failure; every other close names why this generation left the incident's
   * scope. Both transitions are conditional on the generation still being open,
   * so a concurrent evidence/supersession race cannot double-write.
   */
  async function closeSourceGeneration(input: {
    incident: IncidentRow;
    source: Pick<SourceRow, "id" | "sourceIssueId" | "generationKey">;
    close:
      | {
        kind: "recovered";
        reason: RecoveryEngineerSourceCloseReason;
        runId: string | null;
        evidence: Record<string, unknown>;
      }
      | {
        kind: "superseded";
        reason: RecoveryEngineerSourceCloseReason;
        supersededBySourceId?: string | null;
      };
  }) {
    const now = new Date();
    const closed = await db
      .update(recoveryEngineerIncidentSources)
      .set(input.close.kind === "recovered"
        ? {
          recoveredAt: now,
          recoveredRunId: input.close.runId,
          recoveredEvidence: {
            reason: input.close.reason,
            recordedAt: now.toISOString(),
            ...input.close.evidence,
          },
          updatedAt: now,
        }
        : {
          supersededAt: now,
          supersededReason: input.close.reason,
          supersededBySourceId: input.close.supersededBySourceId ?? null,
          updatedAt: now,
        })
      .where(and(
        eq(recoveryEngineerIncidentSources.id, input.source.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!closed) return null;
    await logActivity(db, {
      companyId: input.incident.companyId,
      actorType: "system",
      actorId: "recovery_engineer",
      agentId: null,
      runId: input.close.kind === "recovered" ? input.close.runId : null,
      action: input.close.kind === "recovered"
        ? "recovery_engineer.source_recovered"
        : "recovery_engineer.source_superseded",
      entityType: "recovery_engineer_incident",
      entityId: input.incident.id,
      details: {
        incidentId: input.incident.id,
        sourceId: input.source.id,
        sourceIssueId: input.source.sourceIssueId,
        generationKey: input.source.generationKey,
        reason: input.close.reason,
        ...(input.close.kind === "recovered" ? { recoveredRunId: input.close.runId } : {}),
      },
    });
    return closed;
  }

  /**
   * Resolves the outcome of the newest open generation of one source issue.
   * Evidence is evaluated before staleness: a newer run that advanced the
   * original path closes the generation as recovered, a terminal failure of
   * the dispatched continuation records that the continuation did not overcome
   * the failure, and an undispatched generation whose status generation or
   * owner moved on is superseded. Gates and unavailable owners stay pending —
   * they are real waits owned by someone else, not recovery outcomes.
   */
  async function resolveSourceOutcome(input: {
    incident: IncidentRow;
    issue: IssueRow;
    evidenceRun?: RunRow | null;
  }): Promise<
    | { kind: "recovered"; sourceId: string; runId: string | null; reason: RecoveryEngineerSourceCloseReason }
    | { kind: "superseded"; sourceId: string; reason: RecoveryEngineerSourceCloseReason }
    | { kind: "pending"; sourceId: string; reason: string }
    | null
  > {
    const openSources = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, input.incident.id),
        eq(recoveryEngineerIncidentSources.sourceIssueId, input.issue.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id));
    if (openSources.length === 0) return null;
    const [current, ...olderOpen] = openSources;
    for (const older of olderOpen) {
      // Only the newest generation can still be recovered; a newer observation
      // of the same issue replaced it.
      await closeSourceGeneration({
        incident: input.incident,
        source: older,
        close: {
          kind: "superseded",
          reason: SUPERSEDED_BY_NEWER_GENERATION,
          supersededBySourceId: current.id,
        },
      });
    }

    const latestRun = await latestIssueRun(input.issue);
    const evidenceRun = input.evidenceRun ?? latestRun;
    if (input.issue.status === "done") {
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: {
          kind: "recovered",
          reason: "source_issue_completed",
          runId: latestRun?.id ?? null,
          evidence: {
            issueStatus: input.issue.status,
            issueStatusVersion: input.issue.statusVersion,
            issueUpdatedAt: input.issue.updatedAt.toISOString(),
            latestRunId: latestRun?.id ?? null,
            latestRunStatus: latestRun?.status ?? null,
          },
        },
      });
      return closed
        ? { kind: "recovered", sourceId: current.id, runId: latestRun?.id ?? null, reason: "source_issue_completed" }
        : null;
    }
    if (input.issue.status === "cancelled") {
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: { kind: "superseded", reason: "source_cancelled" },
      });
      return closed ? { kind: "superseded", sourceId: current.id, reason: "source_cancelled" } : null;
    }
    if (
      evidenceRun &&
      evidenceRun.status === "succeeded" &&
      latestRun?.id === evidenceRun.id &&
      isPostFailureRunForSource(current, evidenceRun) &&
      runIssueId(evidenceRun) === input.issue.id &&
      // The evidence must be tied to this generation's actual advancement: it
      // is either the continuation we dispatched, or a run that moved the
      // issue's native status generation forward. A useful-but-unrelated
      // success on the same issue does not prove this failure was overcome.
      (
        evidenceRun.id === current.resumedRunId ||
        input.issue.statusVersion > current.sourceStatusVersion
      ) &&
      LIFENESS_ADVANCED_STATES.includes(evidenceRun.livenessState as never) &&
      Boolean(evidenceRun.lastUsefulActionAt) &&
      input.issue.status !== "blocked"
    ) {
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: {
          kind: "recovered",
          reason: "original_path_run",
          runId: evidenceRun.id,
          evidence: {
            runId: evidenceRun.id,
            // Recorded, not required: the failing operation is the source
            // task's own execution path, so a later owner who actually
            // finished it still counts as the failure being overcome. Stale
            // ownership is never restored.
            executedByAgentId: evidenceRun.agentId,
            originalOwnerAgentId: current.originalOwnerAgentId,
            livenessState: evidenceRun.livenessState,
            lastUsefulActionAt: evidenceRun.lastUsefulActionAt?.toISOString() ?? null,
            issueStatus: input.issue.status,
            issueStatusVersion: input.issue.statusVersion,
            resumedRunId: current.resumedRunId,
          },
        },
      });
      return closed
        ? { kind: "recovered", sourceId: current.id, runId: evidenceRun.id, reason: "original_path_run" }
        : null;
    }

    if (await hasLiveExecutionPath(input.issue, current.originalOwnerAgentId)) {
      return { kind: "pending", sourceId: current.id, reason: "live_execution_path" };
    }
    if (input.issue.assigneeUserId || !current.originalOwnerAgentId) {
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: { kind: "superseded", reason: "source_owner_human" },
      });
      return closed ? { kind: "superseded", sourceId: current.id, reason: "source_owner_human" } : null;
    }
    if (input.issue.assigneeAgentId !== current.originalOwnerAgentId) {
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: { kind: "superseded", reason: "source_owner_changed" },
      });
      return closed ? { kind: "superseded", sourceId: current.id, reason: "source_owner_changed" } : null;
    }
    if (current.resumedAt) {
      if (
        latestRun &&
        TERMINAL_FAILURE_STATUSES.includes(latestRun.status as never) &&
        isPostFailureRunForSource(current, latestRun)
      ) {
        const closed = await closeSourceGeneration({
          incident: input.incident,
          source: current,
          close: { kind: "superseded", reason: "continuation_failed" },
        });
        return closed ? { kind: "superseded", sourceId: current.id, reason: "continuation_failed" } : null;
      }
      if (
        latestRun &&
        latestRun.status === "succeeded" &&
        latestRun.id === current.resumedRunId
      ) {
        // The continuation ran to completion without advancing the issue: the
        // failure was not overcome, and nothing else is coming.
        const closed = await closeSourceGeneration({
          incident: input.incident,
          source: current,
          close: { kind: "superseded", reason: "continuation_without_progress" },
        });
        return closed
          ? { kind: "superseded", sourceId: current.id, reason: "continuation_without_progress" }
          : null;
      }
      return { kind: "pending", sourceId: current.id, reason: "awaiting_recovery_evidence" };
    }
    if (
      input.issue.statusVersion !== current.sourceStatusVersion ||
      input.issue.status !== current.sourceStatus
    ) {
      const gate = await sourceGateKind(input.issue, latestRun);
      const reason: RecoveryEngineerSourceCloseReason =
        input.issue.status === "blocked" && gate !== "none"
          ? "source_gate_changed"
          : "source_generation_advanced";
      const closed = await closeSourceGeneration({
        incident: input.incident,
        source: current,
        close: { kind: "superseded", reason },
      });
      return closed ? { kind: "superseded", sourceId: current.id, reason } : null;
    }
    const gate = await sourceGateKind(input.issue, latestRun);
    if (gate !== "none") {
      return { kind: "pending", sourceId: current.id, reason: `${gate}_gate` };
    }
    const owner = await db
      .select()
      .from(agents)
      .where(and(
        eq(agents.id, current.originalOwnerAgentId),
        eq(agents.companyId, input.incident.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    const invokability = await evaluateAgentInvokabilityFromDb(db, owner);
    if (!invokability.invokable) {
      return { kind: "pending", sourceId: current.id, reason: `owner_unavailable:${invokability.reason}` };
    }
    return { kind: "pending", sourceId: current.id, reason: "awaiting_dispatch" };
  }

  /**
   * The only place the incident rewrites its own maintenance issue. Every mode
   * is owner-preserving and guarded by a row lock with the guards re-validated
   * under that lock, so a competing operator decision (takeover, completion,
   * newer execution generation, live wake) is never overwritten. `close`
   * completes the maintenance issue once every source generation is recovered;
   * `board_wait` keeps a board-owned wait and only replaces the descriptor this
   * flow itself wrote, so a wait someone else set survives untouched.
   */
  async function transitionMaintenanceWait(input: {
    incident: IncidentRow;
    config: ConfigRow;
    mode: "close" | "board_wait";
    action: string;
  }): Promise<boolean> {
    if (!input.incident.maintenanceIssueId) return false;
    const postCommitActivityPublications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const transitioned = await db.transaction(async (tx): Promise<{
      issueId: string;
      previousStatus: string;
      nextStatus: string;
    } | null> => {
      const issue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.incident.maintenanceIssueId!),
          eq(issues.companyId, input.incident.companyId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!issue) return null;
      // The outcome recomputed from the sources is the authority for this
      // transition: a concurrent admission of a newer generation flips it back
      // to pending without any lock ordering assumptions, and the maintenance
      // issue must not be completed (or handed to the board) on a stale verdict.
      const incidentNow = await tx
        .select({
          outcome: recoveryEngineerIncidents.outcome,
          status: recoveryEngineerIncidents.status,
        })
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, input.incident.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!incidentNow) return null;
      const requiredOutcome = input.mode === "close" ? "recovered" : "unresolved";
      if (incidentNow.outcome !== requiredOutcome) return null;
      if (input.mode === "close") {
        const openSource = await tx
          .select({ id: recoveryEngineerIncidentSources.id })
          .from(recoveryEngineerIncidentSources)
          .where(and(
            eq(recoveryEngineerIncidentSources.incidentId, input.incident.id),
            isNull(recoveryEngineerIncidentSources.recoveredAt),
            isNull(recoveryEngineerIncidentSources.supersededAt),
          ))
          .limit(1);
        if (openSource.length > 0) return null;
      }
      if (["done", "cancelled"].includes(issue.status)) return null;
      if (issue.assigneeAgentId !== input.config.agentId || issue.assigneeUserId) return null;
      if (issue.executionState) return null;
      if (issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt) return null;
      if (await hasLiveExecutionPath(issue, input.config.agentId, { dbOrTx: tx })) return null;
      if (input.mode === "board_wait") {
        const existingAction = issue.unblockDescriptor ? issue.unblockDescriptor.action : null;
        if (existingAction && !existingAction.startsWith(ACTIVATION_WAIT_PREFIX)) return null;
        const updated = await issuesSvc.update(issue.id, {
          status: "blocked",
          unblockDescriptor: { owner: "board", action: input.action },
        }, tx, postCommitActivityPublications, postCommitActions);
        return updated
          ? { issueId: issue.id, previousStatus: issue.status, nextStatus: updated.status }
          : null;
      }
      let current = issue;
      if (current.status !== "in_progress") {
        const promoted = await issuesSvc.update(
          current.id,
          { status: "in_progress" },
          tx,
          postCommitActivityPublications,
          postCommitActions,
        );
        if (!promoted) return null;
        current = promoted;
      }
      const completed = await issuesSvc.update(
        current.id,
        { status: "done" },
        tx,
        postCommitActivityPublications,
        postCommitActions,
      );
      return completed
        ? { issueId: issue.id, previousStatus: issue.status, nextStatus: completed.status }
        : null;
    });
    if (!transitioned) return false;
    for (const publication of postCommitActivityPublications) publishActivity(publication);
    await executeIssuePostCommitActions(db, postCommitActions);
    await logActivity(db, {
      companyId: input.incident.companyId,
      actorType: "system",
      actorId: "recovery_engineer",
      agentId: null,
      runId: null,
      action: input.mode === "close"
        ? "recovery_engineer.maintenance_closed"
        : "recovery_engineer.maintenance_wait_refreshed",
      entityType: "recovery_engineer_incident",
      entityId: input.incident.id,
      details: {
        incidentId: input.incident.id,
        maintenanceIssueId: transitioned.issueId,
        previousStatus: transitioned.previousStatus,
        nextStatus: transitioned.nextStatus,
      },
    });
    return true;
  }

  /**
   * The generation that is current for its source issue. Superseding an older
   * generation when a newer one is observed is routine bookkeeping, so the
   * roll-up follows the `superseded_by_newer_generation` chain instead of
   * counting that bookkeeping as a permanent failure.
   */
  function currentGenerationFor(sources: readonly SourceRow[], start: SourceRow): SourceRow {
    let current = start;
    const visited = new Set<string>([current.id]);
    for (let hop = 0; hop < 32; hop += 1) {
      if (!current.supersededAt || current.supersededReason !== SUPERSEDED_BY_NEWER_GENERATION) {
        return current;
      }
      const next = current.supersededBySourceId
        ? sources.find((row) => row.id === current.supersededBySourceId) ?? null
        : null;
      if (!next || visited.has(next.id)) return current;
      visited.add(next.id);
      current = next;
    }
    return current;
  }

  /**
   * Recomputes an incident's outcome from the generations that are current for
   * their source issues and follows it with the lifecycle status. `recovered`
   * means every source issue's current generation carries recovery evidence;
   * routine newer-generation supersession never counts against it. A dispatched
   * continuation alone never resolves an incident — the maintenance issue is
   * completed exactly on the recovered transition. The status write is guarded
   * by the snapshot it was computed from, so a concurrent verification,
   * escalation, or operator decision is never reverted; on a lost race the
   * roll-up re-reads and recomputes instead of forcing the stale status.
   */
  async function rollUpIncidentOutcome(incidentId: string): Promise<IncidentRow | null> {
    const readIncident = () => db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, incidentId))
      .then((rows) => rows[0] ?? null);
    const initial = await readIncident();
    if (!initial) return null;
    const sources = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(eq(recoveryEngineerIncidentSources.incidentId, incidentId));
    if (sources.length === 0) return initial;
    const open = sources.filter((source) => !source.recoveredAt && !source.supersededAt);
    const newestByIssue = new Map<string, SourceRow>();
    for (const source of sources) {
      const existing = newestByIssue.get(source.sourceIssueId);
      if (
        !existing ||
        source.observedAt.getTime() > existing.observedAt.getTime() ||
        (source.observedAt.getTime() === existing.observedAt.getTime() && source.id > existing.id)
      ) {
        newestByIssue.set(source.sourceIssueId, source);
      }
    }
    const currentGenerations = [...newestByIssue.values()].map((source) =>
      currentGenerationFor(sources, source));
    const outcome: RecoveryEngineerIncidentOutcome = open.length > 0
      ? "pending"
      : currentGenerations.every((source) => source.recoveredAt)
        ? "recovered"
        : "unresolved";

    const now = new Date();
    let updated: IncidentRow | null = null;
    for (let attempt = 0; attempt < 3 && !updated; attempt += 1) {
      const snapshot = attempt === 0 ? initial : await readIncident();
      if (!snapshot) return null;
      const nextStatus = outcome === "recovered"
        ? "resolved"
        : outcome === "unresolved"
          ? "gated"
          : open.length > 0 &&
              open.every((source) => source.resumedAt) &&
              !RESUME_STAGE_PROTECTED_STATUSES.includes(snapshot.status as never)
            ? "resumed"
            : snapshot.status;
      const outcomeChanged = outcome !== snapshot.outcome;
      const statusChanged = nextStatus !== snapshot.status;
      if (!outcomeChanged && !statusChanged) return snapshot;
      updated = await db
        .update(recoveryEngineerIncidents)
        .set({
          outcome,
          ...(statusChanged ? { status: nextStatus } : {}),
          outcomeUpdatedAt: outcomeChanged ? now : snapshot.outcomeUpdatedAt,
          updatedAt: now,
        })
        .where(and(
          eq(recoveryEngineerIncidents.id, incidentId),
          eq(recoveryEngineerIncidents.status, snapshot.status),
          eq(recoveryEngineerIncidents.outcome, snapshot.outcome),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    }
    if (!updated) {
      // Three lost races in a row: leave the write to the next sweep rather
      // than forcing a stale status over live work.
      updated = await readIncident();
      if (!updated) return null;
    }
    const config = await getConfigRow(initial.companyId);
    if (config) {
      if (outcome === "recovered") {
        await transitionMaintenanceWait({
          incident: updated,
          config,
          mode: "close",
          action: `All source generations of recovery incident ${updated.id} recovered with evidence.`,
        });
      } else if (outcome === "unresolved") {
        const unrecovered = sources
          .filter((source) => !source.recoveredAt)
          .map((source) => `${source.sourceIssueId}:${source.supersededReason ?? "open"}`)
          .join(", ");
        if (!updated.boardEscalatedAt) {
          const escalated = await db
            .update(recoveryEngineerIncidents)
            .set({
              boardEscalatedAt: now,
              boardEscalationReason: "sources_unrecoverable_after_detection",
              updatedAt: now,
            })
            .where(and(
              eq(recoveryEngineerIncidents.id, incidentId),
              isNull(recoveryEngineerIncidents.boardEscalatedAt),
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (escalated) {
            await logActivity(db, {
              companyId: initial.companyId,
              actorType: "system",
              actorId: "recovery_engineer",
              agentId: null,
              runId: null,
              action: "recovery_engineer.incident_escalated",
              entityType: "recovery_engineer_incident",
              entityId: incidentId,
              details: { reason: "sources_unrecoverable_after_detection", sources: unrecovered },
            });
          }
        }
        await transitionMaintenanceWait({
          incident: updated,
          config,
          mode: "board_wait",
          action: `Recovery incident ${updated.id} cannot claim a repair outcome for ${unrecovered}. The failure generation left the incident's scope; decide the source disposition instead of re-running the recovery role to persist status.`,
        });
      }
    }
    if (outcome !== initial.outcome || updated.status !== initial.status) {
      await logActivity(db, {
        companyId: initial.companyId,
        actorType: "system",
        actorId: "recovery_engineer",
        agentId: null,
        runId: null,
        action: "recovery_engineer.incident_outcome_recorded",
        entityType: "recovery_engineer_incident",
        entityId: incidentId,
        details: {
          previousOutcome: initial.outcome,
          outcome,
          previousStatus: initial.status,
          status: updated.status,
          openSourceCount: open.length,
          closedSourceCount: sources.length - open.length,
          currentGenerationCount: currentGenerations.length,
        },
      });
    }
    return updated;
  }

  async function shouldIgnoreSource(input: {
    issue: IssueRow;
    run?: RunRow | null;
  }): Promise<{ ignored: true; reason: string } | { ignored: false }> {
    if (isRecoveryEngineerIssueOrigin(input.issue.originKind)) {
      return { ignored: true, reason: "recovery_participant_issue" };
    }
    if (["done", "cancelled"].includes(input.issue.status)) {
      return { ignored: true, reason: "already_recovered" };
    }
    if (input.run) {
      const newest = await latestIssueRun(input.issue);
      if (newest && newest.id !== input.run.id) {
        return { ignored: true, reason: "already_recovered" };
      }
      const adapterClassification = classifyAdapterFailureForRecovery(input.run, new Date());
      if (adapterClassification?.kind === "provider_quota") {
        return { ignored: true, reason: "provider_gate" };
      }
      if (adapterClassification?.kind === "configuration_incomplete") {
        return { ignored: true, reason: "human_gate" };
      }
      if (isOperatorCancelledRun(input.run)) {
        return { ignored: true, reason: "operator_cancelled" };
      }
    }
    if (await hasPendingHumanGate(input.issue)) {
      return { ignored: true, reason: "human_gate" };
    }
    if (await hasUnresolvedDependency(input.issue)) {
      return { ignored: true, reason: "dependency_gate" };
    }
    return { ignored: false };
  }

  async function sourceAgentAdapterType(run: RunRow) {
    return db
      .select({ adapterType: agents.adapterType })
      .from(agents)
      .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)))
      .then((rows) => rows[0]?.adapterType ?? null);
  }

  async function findIncident(companyId: string, failureFingerprint: string) {
    return db
      .select()
      .from(recoveryEngineerIncidents)
      .where(and(
        eq(recoveryEngineerIncidents.companyId, companyId),
        eq(recoveryEngineerIncidents.failureFingerprint, failureFingerprint),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function createOrResolveIncident(companyId: string, failureFingerprint: string) {
    const existing = await findIncident(companyId, failureFingerprint);
    if (existing) return { incident: existing, created: false };
    try {
      const incident = await db
        .insert(recoveryEngineerIncidents)
        .values({ companyId, failureFingerprint })
        .returning()
        .then((rows) => rows[0]!);
      return { incident, created: true };
    } catch (error) {
      if (!isUniqueViolation(error, INCIDENT_FINGERPRINT_CONSTRAINT)) throw error;
      const winner = await findIncident(companyId, failureFingerprint);
      if (!winner) throw error;
      return { incident: winner, created: false };
    }
  }

  async function addIncidentSource(input: {
    incident: IncidentRow;
    issue: IssueRow;
    run: RunRow | null;
    generationKey: string;
    evidence: Record<string, unknown>;
  }) {
    const values: typeof recoveryEngineerIncidentSources.$inferInsert = {
      companyId: input.issue.companyId,
      incidentId: input.incident.id,
      sourceIssueId: input.issue.id,
      sourceRunId: input.run?.id ?? null,
      generationKey: input.generationKey,
      originalOwnerAgentId: input.issue.assigneeAgentId,
      originalOwnerUserId: input.issue.assigneeUserId,
      sourceStatus: input.issue.status,
      sourceStatusVersion: input.issue.statusVersion,
      sourceUpdatedAt: input.issue.updatedAt,
      checkoutRunId: input.issue.checkoutRunId,
      executionRunId: input.issue.executionRunId,
      evidence: input.evidence,
    };
    const source = await db
      .insert(recoveryEngineerIncidentSources)
      .values(values)
      .onConflictDoNothing({
        target: [
          recoveryEngineerIncidentSources.incidentId,
          recoveryEngineerIncidentSources.sourceIssueId,
          recoveryEngineerIncidentSources.generationKey,
        ],
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (source) {
      // Only the newest generation of an issue stays open per incident: a
      // newer observation replaces an older pending one, and the older
      // generation is recorded as superseded rather than silently dropped.
      const olderOpen = await db
        .select({
          id: recoveryEngineerIncidentSources.id,
          sourceIssueId: recoveryEngineerIncidentSources.sourceIssueId,
          generationKey: recoveryEngineerIncidentSources.generationKey,
        })
        .from(recoveryEngineerIncidentSources)
        .where(and(
          eq(recoveryEngineerIncidentSources.incidentId, input.incident.id),
          eq(recoveryEngineerIncidentSources.sourceIssueId, input.issue.id),
          ne(recoveryEngineerIncidentSources.id, source.id),
          isNull(recoveryEngineerIncidentSources.recoveredAt),
          isNull(recoveryEngineerIncidentSources.supersededAt),
        ));
      for (const older of olderOpen) {
        await closeSourceGeneration({
          incident: input.incident,
          source: older,
          close: {
            kind: "superseded",
            reason: SUPERSEDED_BY_NEWER_GENERATION,
            supersededBySourceId: source.id,
          },
        });
      }
      return { source, created: true };
    }
    const existing = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, input.incident.id),
        eq(recoveryEngineerIncidentSources.sourceIssueId, input.issue.id),
        eq(recoveryEngineerIncidentSources.generationKey, input.generationKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw conflict("Recovery source generation disappeared during observation");
    return { source: existing, created: false };
  }

  async function ensureMaintenanceIssue(
    incident: IncidentRow,
    config: ConfigRow,
    issue: IssueRow,
    summary: string,
  ) {
    if (incident.maintenanceIssueId) {
      const existing = await issuesSvc.getById(incident.maintenanceIssueId);
      if (existing) return existing;
    }
    const shortFingerprint = incident.failureFingerprint.slice(0, 12);
    const maintenanceIssue = await issuesSvc.create(incident.companyId, {
      title: `Recovery incident ${shortFingerprint}: ${issue.title}`.slice(0, 240),
      description: [
        "A deterministic recovery-engineer incident was opened for an unexplained failed execution path.",
        "",
        `Incident: ${incident.id}`,
        `Failure fingerprint: ${incident.failureFingerprint}`,
        `Affected source issue: ${issue.identifier ?? issue.id} (${issue.id})`,
        `Original owner agent: ${issue.assigneeAgentId ?? "none"}`,
        `Original owner user: ${issue.assigneeUserId ?? "none"}`,
        `Source status/version: ${issue.status}/${issue.statusVersion}`,
        "",
        "Sanitized source evidence:",
        summary,
        "",
        "Diagnose once. Do not retry the source task blindly. Request a scoped repair and independent review when appropriate.",
      ].join("\n").slice(0, 20_000),
      status: "todo",
      priority: "high",
      projectId: config.projectId,
      assigneeAgentId: config.agentId,
      assigneeUserId: null,
      originKind: RECOVERY_ENGINEER_ORIGIN_KINDS.incident,
      originId: incident.id,
      originFingerprint: incident.failureFingerprint,
      idempotencyKey: `recovery-engineer:incident:${incident.id}`,
      allowDuplicate: true,
    });
    const updated = await db
      .update(recoveryEngineerIncidents)
      .set({ maintenanceIssueId: maintenanceIssue.id, updatedAt: new Date() })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        isNull(recoveryEngineerIncidents.maintenanceIssueId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      const winner = await findIncident(incident.companyId, incident.failureFingerprint);
      if (winner?.maintenanceIssueId && winner.maintenanceIssueId !== maintenanceIssue.id) {
        return issuesSvc.getById(winner.maintenanceIssueId).then((row) => row ?? maintenanceIssue);
      }
    }
    return maintenanceIssue;
  }

  /**
   * The maintenance-issue descriptor and activity record that accompany a
   * fresh board escalation. Split from the incident-row update so a dispatch
   * seam that must escalate under its own advisory lock (never across an
   * outer-db callback while holding a connection) can commit the row inside
   * its transaction and apply these follow-ups after it commits.
   */
  async function applyBoardEscalationFollowUps(
    incident: IncidentRow,
    reason: string,
    runId: string | null,
  ) {
    if (incident.maintenanceIssueId) {
      const maintenance = await issuesSvc.getById(incident.maintenanceIssueId);
      if (maintenance && !["done", "cancelled"].includes(maintenance.status)) {
        await issuesSvc.update(maintenance.id, {
          status: "blocked",
          unblockDescriptor: {
            owner: "board",
            action: `Inspect recovery incident ${incident.id}; automatic recovery stopped (${reason}).`,
          },
        });
      }
    }
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: "system",
      actorId: "recovery_engineer",
      agentId: null,
      runId: runId ?? null,
      action: "recovery_engineer.incident_escalated",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: { reason, maintenanceIssueId: incident.maintenanceIssueId },
    });
  }

  async function escalateToBoard(incidentId: string, reason: string, runId?: string | null) {
    const now = new Date();
    const incident = await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "escalated",
        boardEscalatedAt: now,
        boardEscalationReason: reason,
        updatedAt: now,
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incidentId),
        isNull(recoveryEngineerIncidents.boardEscalatedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!incident) {
      // Already escalated: the escalation itself stays single-shot, but a new
      // terminal reason must not be silently swallowed — the recorded reason
      // is refreshed to the exact current one (guarded on the reason it
      // replaces) and the repeat is logged, so the board wait always names
      // why automatic recovery stopped. The maintenance gate a previous
      // escalation (or a later lifecycle stage) wrote is never rewritten here.
      const current = await db
        .select({
          boardEscalationReason: recoveryEngineerIncidents.boardEscalationReason,
        })
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, incidentId))
        .then((rows) => rows[0] ?? null);
      if (!current) return false;
      if (current.boardEscalationReason === reason) return false;
      const refreshed = await db
        .update(recoveryEngineerIncidents)
        .set({ boardEscalationReason: reason, updatedAt: now })
        .where(and(
          eq(recoveryEngineerIncidents.id, incidentId),
          current.boardEscalationReason === null
            ? isNull(recoveryEngineerIncidents.boardEscalationReason)
            : eq(recoveryEngineerIncidents.boardEscalationReason, current.boardEscalationReason),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!refreshed) return false;
      // Keep the board gate exact: when the parked maintenance issue carries
      // this flow's own escalation descriptor, refresh it to the current
      // reason. A descriptor someone else wrote (or a later lifecycle stage's
      // activation wait) is never rewritten, and a live path is never
      // overwritten.
      if (refreshed.maintenanceIssueId) {
        const maintenance = await issuesSvc.getById(refreshed.maintenanceIssueId);
        const action = maintenance?.unblockDescriptor?.action ?? null;
        if (
          maintenance &&
          maintenance.status === "blocked" &&
          action?.startsWith(`${BOARD_ESCALATION_ACTION_PREFIX}${incidentId}`) &&
          !(await hasLiveExecutionPath(maintenance, maintenance.assigneeAgentId))
        ) {
          await issuesSvc.update(maintenance.id, {
            status: "blocked",
            unblockDescriptor: {
              owner: "board",
              action: `Inspect recovery incident ${incidentId}; automatic recovery stopped (${reason}).`,
            },
          });
        }
      }
      await logActivity(db, {
        companyId: refreshed.companyId,
        actorType: "system",
        actorId: "recovery_engineer",
        agentId: null,
        runId: runId ?? null,
        action: "recovery_engineer.incident_escalation_reason_refreshed",
        entityType: "recovery_engineer_incident",
        entityId: incidentId,
        details: {
          previousReason: current.boardEscalationReason,
          reason,
          maintenanceIssueId: refreshed.maintenanceIssueId,
        },
      });
      return false;
    }
    await applyBoardEscalationFollowUps(incident, reason, runId ?? null);
    return true;
  }

  // A configured recovery-engineer participant runs in a constrained native
  // runtime that has no issue-disposition tool. When one of its incident wakes
  // terminalizes successfully on the incident's own maintenance issue while
  // that maintenance is still authoritative and unresolved, the generic
  // successful-run handoff would demand a disposition this role cannot record.
  // Instead, native persists the durable owner-preserving exit here: blocked
  // with a board-owned unblock descriptor naming the existing maintenance
  // wait. Evidence is structural only — configured participant, active
  // incident, maintenance-issue scope, current run generation — never the
  // run's report text. Corrective handoff runs carry no incidentId in their
  // context, so they keep the designed handoff/exhaustion path.
  //
  // Eligibility and the status mutation are one transaction. The issue,
  // incident, and config rows are locked and every guard is re-validated under
  // those locks before issuesSvc.update runs inside the same transaction, so a
  // competing operator decision (reassignment, completion, newer execution
  // generation) that commits between observation and write cannot be
  // overwritten. The wait is also refused when a live run or a queued wake on
  // the maintenance issue already owns the next action. The activity log entry
  // is written only after the transaction commits.
  async function recordTrustedMaintenanceWaitForRun(run: RunRow): Promise<boolean> {
    if (run.status !== "succeeded") return false;
    if (run.runtimeMode === "native" && (run.nativePhase !== null || run.completionContractId !== null)) {
      return false;
    }
    const scopedIssueId = runIssueId(run);
    const context = parseObject(run.contextSnapshot);
    const incidentId = readString(context.incidentId);
    if (!scopedIssueId || !incidentId) return false;
    // Cheap pre-transaction filter: runs from non-recovery participants never
    // open the atomic transaction below.
    const configHint = await getConfigRow(run.companyId);
    if (!configHint?.enabled) return false;
    if (participantRole(configHint, run.agentId) !== "recovery") return false;
    const postCommitActivityPublications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const recorded = await db.transaction(async (tx): Promise<{
      companyId: string;
      issueId: string;
      incidentId: string;
      runId: string;
      previousStatus: string;
    } | null> => {
      const issue = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, scopedIssueId), eq(issues.companyId, run.companyId)))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!issue) return null;
      if (issue.assigneeAgentId !== run.agentId || issue.assigneeUserId) return null;
      if (issue.executionState) return null;
      if (issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt) return null;
      if (issue.status !== "in_progress") return null;
      const incident = await tx
        .select()
        .from(recoveryEngineerIncidents)
        .where(and(
          eq(recoveryEngineerIncidents.id, incidentId),
          eq(recoveryEngineerIncidents.companyId, run.companyId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!incident || incident.maintenanceIssueId !== scopedIssueId) return null;
      if (!RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES.includes(incident.status as never)) return null;
      const config = await tx
        .select()
        .from(recoveryEngineerConfigs)
        .where(eq(recoveryEngineerConfigs.companyId, run.companyId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!config?.enabled) return null;
      if (participantRole(config, run.agentId) !== "recovery") return null;
      // Wrong-generation evidence: a newer run on the issue supersedes this one.
      const newest = await latestIssueRun(issue, tx);
      if (newest && newest.id !== run.id) return null;
      // An existing live execution path or a queued wake on the maintenance
      // issue already owns the next action (including wakes carrying their
      // issue linkage in `_paperclipWakeContext`); recording a wait over it
      // would overwrite that path.
      if (await hasLiveExecutionPath(issue, run.agentId, { excludeRunId: run.id, dbOrTx: tx })) {
        return null;
      }
      const updated = await issuesSvc.update(issue.id, {
        status: "blocked",
        unblockDescriptor: {
          owner: "board",
          action: `Recovery incident ${incident.id} maintenance is still unresolved and this recovery participant runtime cannot record its own issue disposition. Inspect the incident evidence and choose the next maintenance action.`,
        },
      }, tx, postCommitActivityPublications, postCommitActions);
      if (!updated) return null;
      return {
        companyId: issue.companyId,
        issueId: issue.id,
        incidentId: incident.id,
        runId: run.id,
        previousStatus: issue.status,
      };
    });
    if (!recorded) return false;
    if (postCommitActivityPublications.length > 0) {
      for (const publication of postCommitActivityPublications) publishActivity(publication);
    }
    await executeIssuePostCommitActions(db, postCommitActions);
    await logActivity(db, {
      companyId: recorded.companyId,
      actorType: "system",
      actorId: "recovery_engineer",
      agentId: null,
      runId: recorded.runId,
      action: "recovery_engineer.maintenance_wait_recorded",
      entityType: "recovery_engineer_incident",
      entityId: recorded.incidentId,
      details: {
        incidentId: recorded.incidentId,
        maintenanceIssueId: recorded.issueId,
        sourceRunId: recorded.runId,
        previousStatus: recorded.previousStatus,
        nextStatus: "blocked",
      },
    });
    return true;
  }

  /**
   * The newest open failure generation of the incident, used to bind a
   * dispatch intent to the generation it diagnoses (and to the original
   * owner). A dispatch intent without this binding would be detachable from
   * the failure it exists to recover.
   */
  async function newestOpenSourceGeneration(incidentId: string): Promise<IncidentSourceGeneration | null> {
    return db
      .select({
        sourceIssueId: recoveryEngineerIncidentSources.sourceIssueId,
        generationKey: recoveryEngineerIncidentSources.generationKey,
        originalOwnerAgentId: recoveryEngineerIncidentSources.originalOwnerAgentId,
      })
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, incidentId),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function sourceGenerationIntentFields(generation: IncidentSourceGeneration | null) {
    return generation
      ? {
        sourceIssueId: generation.sourceIssueId,
        sourceGenerationKey: generation.generationKey,
        originalOwnerAgentId: generation.originalOwnerAgentId,
      }
      : {};
  }

  /**
   * The source issue describing the incident, for healing a missing
   * maintenance-issue linkage: the newest observed source generation of any
   * close state (a superseded generation still describes the failure the
   * incident was opened for).
   */
  async function newestIncidentSourceIssue(incident: IncidentRow): Promise<IssueRow | null> {
    const source = await db
      .select({ sourceIssueId: recoveryEngineerIncidentSources.sourceIssueId })
      .from(recoveryEngineerIncidentSources)
      .where(eq(recoveryEngineerIncidentSources.incidentId, incident.id))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!source) return null;
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.id, source.sourceIssueId),
        eq(issues.companyId, incident.companyId),
      ))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Claims the incident's single diagnosis attempt and dispatches its wake
   * through the same advisory seam the sweep's re-arm uses, so the original
   * producer and a concurrent sweep can never both enqueue the same
   * diagnose wake. A recognized hold (drain, an unavailable or budget-held
   * participant) parks the intent instead of escalating: the claim and the
   * wake ledger row are the durable dispatch intent, and the sweep re-arms
   * it when the condition clears.
   */
  async function claimDiagnosis(
    incident: IncidentRow,
    config: ConfigRow,
    maintenanceIssue: IssueRow,
  ): Promise<RunRow | null> {
    if (incident.diagnosisAttemptCount >= 1) return null;
    const claimed = await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "diagnosing",
        diagnosisAttemptCount: 1,
        diagnosisRequestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        eq(recoveryEngineerIncidents.diagnosisAttemptCount, 0),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    // Read the source generation before the dispatch pass: the enqueue must
    // never depend on a query issued while this flow holds a connection.
    const generation = await newestOpenSourceGeneration(incident.id);

    const pass = await rearmIncidentWake({
      incidentId: incident.id,
      companyId: config.companyId,
      agentId: config.agentId,
      idempotencyKey: `${DIAGNOSE_DISPATCH_KEY_PREFIX}${incident.id}`,
      exhaustedReason: DIAGNOSIS_DISPATCH_EXHAUSTED_REASON,
      bindingField: "diagnosisRunId",
      guard: (current) => !current.diagnosisRunId && current.diagnosisAttemptCount === 1,
      enqueue: (bindRun) => deps.enqueueWakeup(config.agentId, {
        ...diagnoseWakeInput(
          incident,
          maintenanceIssue,
          // The source generation is read before the dispatch pass, never
          // while a connection-holding transaction is open.
          generation,
        ),
        bindRun,
      }),
      onDispatched: async (runId) => {
        await logActivity(db, {
          companyId: incident.companyId,
          actorType: "system",
          actorId: "recovery_engineer",
          agentId: config.agentId,
          runId,
          action: "recovery_engineer.diagnosis_requested",
          entityType: "recovery_engineer_incident",
          entityId: incident.id,
          details: {
            maintenanceIssueId: maintenanceIssue.id,
            diagnosisAttempt: 1,
            maxAttempts: 1,
          },
        });
      },
      onAdopted: async (wake) => {
        await db
          .update(recoveryEngineerIncidents)
          .set({ diagnosisRunId: wake.runId, updatedAt: new Date() })
          .where(and(
            eq(recoveryEngineerIncidents.id, incident.id),
            isNull(recoveryEngineerIncidents.diagnosisRunId),
          ));
        return "completed";
      },
    });
    if (!pass.runId) return null;
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, pass.runId))
      .then((rows) => rows[0] ?? null);
  }

  async function activateIncident(input: {
    config: ConfigRow;
    issue: IssueRow;
    run: RunRow | null;
    fingerprint: string;
    summary: string;
    evidence: Record<string, unknown>;
    generationKey: string;
  }) {
    const resolved = await createOrResolveIncident(input.issue.companyId, input.fingerprint);
    const source = await addIncidentSource({
      incident: resolved.incident,
      issue: input.issue,
      run: input.run,
      generationKey: input.generationKey,
      evidence: input.evidence,
    });
    if (!source.created) return { incident: resolved.incident, duplicate: true };

    const maintenance = await ensureMaintenanceIssue(
      resolved.incident,
      input.config,
      input.issue,
      input.summary,
    );
    const current = await findIncident(input.issue.companyId, input.fingerprint) ?? resolved.incident;
    if (current.diagnosisAttemptCount >= 1) {
      // The single diagnosis attempt is spent, so a recurring generation is
      // never re-diagnosed and never opened as a second incident (the
      // fingerprint is unique per company). When the incident can no longer act
      // on that generation, the occurrence is recorded once for the board; a
      // generation observed while repair work is still in flight simply joins
      // the incident and stays open.
      if (RECURRENCE_ESCALATION_STATUSES.includes(current.status as never)) {
        await escalateToBoard(current.id, "unchanged_failure_recurred_after_single_attempt", input.run?.id);
      }
      await rollUpIncidentOutcome(current.id);
      return { incident: current, duplicate: false };
    }
    await claimDiagnosis(current, input.config, maintenance);
    return { incident: current, duplicate: false };
  }

  async function observeFailedRun(runOrId: RunRow | string) {
    const run = typeof runOrId === "string"
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runOrId)).then((rows) => rows[0] ?? null)
      : runOrId;
    if (!run || !PARTICIPANT_FAILURE_STATUSES.includes(run.status as never)) {
      return { observed: false };
    }
    const issueId = runIssueId(run);
    if (!issueId) return { observed: false };
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) return { observed: false };
    const config = await getConfigRow(run.companyId);
    if (!config?.enabled) return { observed: false };

    const role = participantRole(config, run.agentId);
    const linked = await resolveIncidentForIssue(issue.id);
    const participantScoped = linked?.participantScoped ?? false;
    if (linked && participantScoped) {
      await handleParticipantRun(linked.incident, config, run, role);
      return { observed: true, participantFailure: true };
    }
    if (isRecoveryEngineerIssueOrigin(issue.originKind)) return { observed: false };
    if (!TERMINAL_FAILURE_STATUSES.includes(run.status as never)) return { observed: false };

    const ignored = await shouldIgnoreSource({ issue, run });
    if (ignored.ignored) return { observed: false, reason: ignored.reason };
    const adapterType = await sourceAgentAdapterType(run);
    const runEvidence = buildRecoveryRunEvidence(run, adapterType, issue.id);
    return {
      observed: true,
      ...(await activateIncident({
        config,
        issue,
        run,
        fingerprint: runEvidence.fingerprint,
        summary: runEvidence.summary,
        evidence: runEvidence.evidence,
        generationKey: `run:${run.id}`,
      })),
    };
  }

  async function observeBlockedIssue(issueOrId: IssueRow | string) {
    const issue = typeof issueOrId === "string"
      ? await db.select().from(issues).where(eq(issues.id, issueOrId)).then((rows) => rows[0] ?? null)
      : issueOrId;
    if (!issue || issue.status !== "blocked") return { observed: false };
    const config = await getConfigRow(issue.companyId);
    if (!config?.enabled) return { observed: false };
    const latestRun = await latestIssueRun(issue);
    const typedResult = parseObject(latestRun?.resultJson);
    const hasSemanticFailure = Boolean(
      latestRun &&
      (
        latestRun.errorCode ||
        latestRun.error ||
        ["error", "failed"].includes(readString(typedResult.stopReason) ?? "") ||
        readString(typedResult.error) ||
        readString(typedResult.errorCode)
      ),
    );
    const ignored = await shouldIgnoreSource({
      issue,
      run: latestRun && (
        TERMINAL_FAILURE_STATUSES.includes(latestRun.status as never) || hasSemanticFailure
      ) ? latestRun : null,
    });
    if (ignored.ignored) return { observed: false, reason: ignored.reason };
    if (latestRun && TERMINAL_FAILURE_STATUSES.includes(latestRun.status as never)) {
      return observeFailedRun(latestRun);
    }
    if (latestRun && hasSemanticFailure) {
      const adapterType = await sourceAgentAdapterType(latestRun);
      const runEvidence = buildRecoveryRunEvidence(latestRun, adapterType, issue.id);
      return {
        observed: true,
        ...(await activateIncident({
          config,
          issue,
          run: latestRun,
          fingerprint: runEvidence.fingerprint,
          summary: runEvidence.summary,
          evidence: runEvidence.evidence,
          generationKey: `run:${latestRun.id}`,
        })),
      };
    }
    const blockedEvidence = buildBlockedIssueEvidence({
      issueId: issue.id,
      title: issue.title,
      description: issue.description,
      statusVersion: issue.statusVersion,
      updatedAt: issue.updatedAt,
    });
    return {
      observed: true,
      ...(await activateIncident({
        config,
        issue,
        run: null,
        fingerprint: blockedEvidence.fingerprint,
        summary: blockedEvidence.summary,
        evidence: blockedEvidence.evidence,
        // The native status generation is the generation of a blocked state. A
        // cosmetic update (comment, description edit) must not mint a new
        // generation, so `updatedAt` is deliberately not part of this key.
        generationKey: `blocked:${issue.statusVersion}`,
      })),
    };
  }

  async function setMaintenanceDisposition(
    incident: IncidentRow,
    config: ConfigRow,
    classification: RecoveryEngineerDiagnoseInput["classification"],
  ) {
    if (!incident.maintenanceIssueId) return;
    const maintenance = await issuesSvc.getById(incident.maintenanceIssueId);
    if (!maintenance || ["done", "cancelled"].includes(maintenance.status)) return;
    if (classification === "already_recovered") {
      // Completion for this classification belongs to the outcome roll-up: it
      // closes the maintenance issue only once every source generation carries
      // recovery evidence, and leaves a board wait when a generation was
      // superseded instead.
      return;
    }
    const gate = classification === "human_gate" || classification === "provider_gate";
    await issuesSvc.update(maintenance.id, {
      status: "blocked",
      unblockDescriptor: gate
        ? {
          owner: "board",
          action: `Resolve the confirmed ${classification} before any source resume.`,
        }
        : {
          owner: { agentId: config.repairAgentId },
          action: "Complete one scoped repair and obtain independent configured-reviewer verification.",
        },
    });
  }

  async function recordDiagnosis(
    incident: IncidentRow,
    config: ConfigRow,
    input: RecoveryEngineerDiagnoseInput,
    actor: RecoveryEngineerActor,
  ) {
    const actorScope = await getActorRun(actor, config, incident, ["recovery"], "maintenance");
    if (!actor.board && actorScope.run?.id !== incident.diagnosisRunId) {
      throw forbidden("Diagnosis must be submitted by the single claimed diagnosis run");
    }
    if (input.repairIssueId && input.repairIssueId !== incident.repairIssueId) {
      throw unprocessable("repairIssueId is not the incident's native repair issue");
    }
    const terminalClassification = ["human_gate", "provider_gate", "already_recovered"].includes(
      input.classification,
    );
    const now = new Date();
    const sanitizedHypothesis = redactSensitiveText(input.hypothesis);
    const sanitizedRootCause = input.rootCause
      ? redactSensitiveText(input.rootCause)
      : null;
    const sanitizedEvidence = input.evidence.map(redactSensitiveText);
    const updated = await db
      .update(recoveryEngineerIncidents)
      .set({
        status: terminalClassification
          ? input.classification === "already_recovered" ? "resolved" : "gated"
          : "diagnosed",
        classification: input.classification,
        hypothesis: sanitizedHypothesis,
        rootCause: sanitizedRootCause,
        evidence: sanitizedEvidence,
        confirmedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        isNull(recoveryEngineerIncidents.classification),
        eq(recoveryEngineerIncidents.diagnosisAttemptCount, 1),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Diagnosis has already been recorded for this incident");
    if (input.classification === "already_recovered") {
      // The diagnosis is the evidence for this close: it asserts the source was
      // already recovered before the incident ran. Every open generation names
      // the diagnosis run, and the roll-up — not this path — decides whether
      // the maintenance issue is complete.
      const openSources = await db
        .select()
        .from(recoveryEngineerIncidentSources)
        .where(and(
          eq(recoveryEngineerIncidentSources.incidentId, incident.id),
          isNull(recoveryEngineerIncidentSources.recoveredAt),
          isNull(recoveryEngineerIncidentSources.supersededAt),
        ));
      for (const openSource of openSources) {
        const sourceIssue = await db
          .select()
          .from(issues)
          .where(and(
            eq(issues.id, openSource.sourceIssueId),
            eq(issues.companyId, incident.companyId),
          ))
          .then((rows) => rows[0] ?? null);
        const generationUnchanged = sourceIssue !== null &&
          sourceIssue.statusVersion === openSource.sourceStatusVersion &&
          sourceIssue.status === openSource.sourceStatus &&
          sourceIssue.assigneeAgentId === openSource.originalOwnerAgentId &&
          sourceIssue.assigneeUserId === null;
        if (generationUnchanged) {
          await closeSourceGeneration({
            incident: updated,
            source: openSource,
            close: {
              kind: "recovered",
              reason: "diagnosis_already_recovered",
              runId: updated.diagnosisRunId,
              evidence: {
                classification: input.classification,
                hypothesis: sanitizedHypothesis.slice(0, 2_000),
                evidenceCount: sanitizedEvidence.length,
                verifiedVerificationId: updated.verifiedVerificationId,
                repairCommit: updated.repairCommit,
              },
            },
          });
          continue;
        }
        // A generation the diagnosis cannot attest — it moved on, changed
        // owner, or gained a gate — is resolved by the same evidence and
        // staleness rules as every other source instead of being closed as
        // recovered on the strength of this classification alone.
        if (sourceIssue) {
          await resolveSourceOutcome({ incident: updated, issue: sourceIssue });
        } else {
          await closeSourceGeneration({
            incident: updated,
            source: openSource,
            close: { kind: "superseded", reason: "source_issue_missing" },
          });
        }
      }
      await rollUpIncidentOutcome(updated.id);
    }
    await setMaintenanceDisposition(updated, config, input.classification);
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: actor.actorType,
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "recovery_engineer.diagnosis_recorded",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: {
        classification: input.classification,
        repairIssueId: input.repairIssueId ?? null,
        evidenceCount: sanitizedEvidence.length,
      },
    });
    return updated;
  }

  async function requestRepair(
    incident: IncidentRow,
    config: ConfigRow,
    input: RecoveryEngineerRepairInput,
    actor: RecoveryEngineerActor,
  ) {
    await getActorRun(actor, config, incident, ["recovery"], "maintenance");
    if (!incident.classification || !["infrastructure", "task_defect"].includes(incident.classification)) {
      throw conflict("A confirmed infrastructure or task-defect diagnosis is required before repair");
    }
    const projectId = config.repairProjectIds?.[input.target];
    if (!projectId) {
      throw unprocessable(`No board-configured ${input.target} repair project is available`, {
        target: input.target,
      });
    }
    if (!incident.maintenanceIssueId) throw conflict("Incident maintenance issue is unavailable");
    if (incident.repairIssueId) {
      if (incident.repairTarget !== input.target) {
        throw conflict("Incident already has a repair in another target");
      }
      const existing = await issuesSvc.getById(incident.repairIssueId);
      if (existing) return { incident, repairIssue: existing, created: false };
    }

    const repairProject = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(
        eq(projects.id, projectId),
        eq(projects.companyId, incident.companyId),
        isNull(projects.archivedAt),
        isNull(projects.pausedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!repairProject) throw unprocessable("Configured repair project is unavailable");
    const repairAgent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, config.repairAgentId), eq(agents.companyId, incident.companyId)))
      .then((rows) => rows[0] ?? null);
    const reviewerAgent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, config.reviewerAgentId), eq(agents.companyId, incident.companyId)))
      .then((rows) => rows[0] ?? null);
    const [repairInvokability, reviewerInvokability] = await Promise.all([
      evaluateAgentInvokabilityFromDb(db, repairAgent),
      evaluateAgentInvokabilityFromDb(db, reviewerAgent),
    ]);
    if (!repairInvokability.invokable || !reviewerInvokability.invokable) {
      throw unprocessable("Repair and independent reviewer must both be invokable", {
        repair: repairInvokability,
        reviewer: reviewerInvokability,
      });
    }

    const executionPolicy = normalizeIssueExecutionPolicy({
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{
          id: randomUUID(),
          type: "agent",
          agentId: config.reviewerAgentId,
          userId: null,
        }],
      }],
    });
    const repairTitle = redactSensitiveText(input.title);
    const repairDescription = redactSensitiveText(input.description);
    const result = await issuesSvc.createChild(incident.maintenanceIssueId, {
      title: repairTitle,
      description: [
        repairDescription,
        "",
        "Recovery repair scope",
        `Incident: ${incident.id}`,
        `Failure fingerprint: ${incident.failureFingerprint}`,
        `Target: ${input.target}`,
        `Repair project: ${projectId}`,
        `Configured repair agent: ${config.repairAgentId}`,
        `Configured independent reviewer: ${config.reviewerAgentId}`,
        "Do not modify the original source task owner, approvals, dependencies, credentials, or policy.",
        "The reviewer must reproduce the failure/fix and submit native verification evidence bound to the exact repair commit and review run.",
      ].join("\n").slice(0, 20_000),
      status: "todo",
      priority: "high",
      projectId,
      assigneeAgentId: config.repairAgentId,
      assigneeUserId: null,
      reviewPolicy: "not_creator",
      executionPolicy: executionPolicy ? { ...executionPolicy } : null,
      originKind: RECOVERY_ENGINEER_ORIGIN_KINDS.repair,
      originId: incident.id,
      originRunId: actor.runId,
      originFingerprint: input.target,
      actorAgentId: actor.agentId,
      actorUserId: actor.userId,
      actorRunId: actor.runId,
      idempotencyKey: `recovery-engineer:repair:${incident.id}:${input.target}`,
      allowDuplicate: true,
      blockParentUntilDone: false,
      executionWorkspaceInheritanceMode: "linkage",
    });
    const updated = await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "repairing",
        repairTarget: input.target,
        repairProjectId: projectId,
        repairIssueId: result.issue.id,
        updatedAt: new Date(),
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        isNull(recoveryEngineerIncidents.repairIssueId),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    const effectiveIncident = updated ?? await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, incident.id))
      .then((rows) => rows[0]!);
    if (effectiveIncident.repairIssueId !== result.issue.id) {
      throw conflict("A concurrent repair request won for this incident");
    }

    // The repair wake dispatches through the same advisory seam the sweep's
    // re-arm uses, so the requesting run and a concurrent sweep serialize on
    // the same intent key. A recognized hold (an unavailable or budget-held
    // repair participant, drain) parks the intent without escalating: the
    // repair issue and the claimed incident row are the durable dispatch
    // intent, and the sweep re-arms it when the condition clears. The
    // materialized repair run is bound to the incident inside the
    // dispatcher's run-creation transaction, before it can be claimed.
    const repairDispatch = await rearmIncidentWake({
      incidentId: incident.id,
      companyId: incident.companyId,
      agentId: config.repairAgentId,
      idempotencyKey: `${REPAIR_WAKE_KEY_PREFIX}${incident.id}:${input.target}`,
      exhaustedReason: REPAIR_DISPATCH_EXHAUSTED_REASON,
      bindingField: "repairRunId",
      guard: (current) =>
        !current.repairRunId && current.repairIssueId === result.issue.id,
      enqueue: (bindRun) => deps.enqueueWakeup(config.repairAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "recovery_engineer_repair",
        idempotencyKey: `${REPAIR_WAKE_KEY_PREFIX}${incident.id}:${input.target}`,
        payload: {
          issueId: result.issue.id,
          incidentId: incident.id,
          target: input.target,
        },
        contextSnapshot: {
          issueId: result.issue.id,
          taskId: result.issue.id,
          incidentId: incident.id,
          wakeReason: "recovery_engineer_repair",
          source: "recovery_engineer.repair_requested",
          recoveryRole: "repair",
        },
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.agentId ?? actor.userId,
        bindRun,
      }),
      onDispatched: async (runId) => {
        await logActivity(db, {
          companyId: incident.companyId,
          actorType: "system",
          actorId: "recovery_engineer",
          agentId: null,
          runId,
          action: "recovery_engineer.repair_dispatch_rearmed",
          entityType: "recovery_engineer_incident",
          entityId: incident.id,
          details: {
            repairIssueId: result.issue.id,
            repairTarget: input.target,
          },
        });
      },
      onAdopted: async (wake) => {
        await reopenDispatchFailureEscalation(incident.id, "repairing");
        if (!wake.runId) return "adopted";
        await db
          .update(recoveryEngineerIncidents)
          .set({ repairRunId: wake.runId, updatedAt: new Date() })
          .where(and(
            eq(recoveryEngineerIncidents.id, incident.id),
            isNull(recoveryEngineerIncidents.repairRunId),
          ));
        const run = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wake.runId))
          .then((rows) => rows[0] ?? null);
        if (
          run &&
          (run.status === "succeeded" ||
            PARTICIPANT_FAILURE_STATUSES.includes(run.status as never))
        ) {
          await handleParticipantRun(effectiveIncident, config, run, "repair");
        }
        return "completed";
      },
    });
    const repairRun = repairDispatch.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, repairDispatch.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: actor.actorType,
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "recovery_engineer.repair_requested",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: {
        target: input.target,
        repairProjectId: projectId,
        repairIssueId: result.issue.id,
        repairRunId: repairRun?.id ?? null,
        dispatchOutcome: repairDispatch.outcome,
      },
    });
    return { incident: effectiveIncident, repairIssue: result.issue, created: Boolean(updated) };
  }

  async function proposeProcedure(
    incident: IncidentRow,
    config: ConfigRow,
    input: RecoveryEngineerProcedureInput,
    actor: RecoveryEngineerActor,
  ) {
    const actorScope = await getActorRun(
      actor,
      config,
      incident,
      ["recovery", "repair", "reviewer"],
    );
    if (!actor.board && actorScope.run?.id !== input.evidenceRunId) {
      throw forbidden("Procedure evidenceRunId must be the submitting participant's current run");
    }
    const evidenceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.evidenceRunId),
        eq(heartbeatRuns.companyId, incident.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!evidenceRun || !participantRole(config, evidenceRun.agentId)) {
      throw unprocessable("Procedure evidence run is not a configured recovery-participant run");
    }
    const scopedIssueId = runIssueId(evidenceRun);
    const incidentIssueIds = await listIncidentIssueIds(incident);
    if (!scopedIssueId || !incidentIssueIds.has(scopedIssueId)) {
      throw unprocessable("Procedure evidence run is not bound to this incident");
    }
    const evidenceAdapterType = await sourceAgentAdapterType(evidenceRun);
    const evidenceSource = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, incident.id),
        eq(recoveryEngineerIncidentSources.sourceIssueId, scopedIssueId),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // The context snapshot is what makes a later reuse reviewable: reuse must
    // re-match the adapter, fingerprint, classification and deployed repair
    // this procedure was actually reviewed against.
    const applicability: RecoveryEngineerProcedureApplicability = {
      adapterType: evidenceAdapterType,
      failureFingerprint: incident.failureFingerprint,
      classification: incident.classification,
      evidenceRunId: evidenceRun.id,
      sourceGenerationKey: evidenceSource?.generationKey ?? null,
      sourceStatusVersion: evidenceSource?.sourceStatusVersion ?? null,
    };
    const procedure = await db
      .insert(recoveryEngineerProcedures)
      .values({
        companyId: incident.companyId,
        incidentId: incident.id,
        status: "proposed",
        title: redactSensitiveText(input.title),
        preconditions: input.preconditions.map(redactSensitiveText),
        steps: input.steps.map(redactSensitiveText),
        successCheck: redactSensitiveText(input.successCheck),
        stopConditions: input.stopConditions.map(redactSensitiveText),
        rollback: redactSensitiveText(input.rollback),
        evidenceRunId: input.evidenceRunId,
        repairCommit: input.repairCommit,
        failureFingerprint: incident.failureFingerprint,
        classification: incident.classification,
        applicability,
        proposedByAgentId: actor.agentId,
        proposedByRunId: actor.runId,
      })
      .returning()
      .then((rows) => rows[0]!);
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: actor.actorType,
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "recovery_engineer.procedure_proposed",
      entityType: "recovery_engineer_procedure",
      entityId: procedure.id,
      details: { incidentId: incident.id, status: "proposed" },
    });
    return procedure;
  }

  async function hasSuccessfulRepairRun(incident: IncidentRow, config: ConfigRow) {
    if (!incident.repairRunId || !incident.repairIssueId) return false;
    const repairRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, incident.repairRunId),
        eq(heartbeatRuns.companyId, incident.companyId),
        eq(heartbeatRuns.agentId, config.repairAgentId),
        eq(heartbeatRuns.status, "succeeded"),
      ))
      .then((rows) => rows[0] ?? null);
    return Boolean(repairRun && runIssueId(repairRun) === incident.repairIssueId);
  }

  async function hasAcceptedNativeReview(
    incident: IncidentRow,
    config: ConfigRow,
    run: RunRow,
  ) {
    if (!incident.repairIssueId || !incident.repairRunId || run.agentId !== config.reviewerAgentId) return false;
    const interactionId = readString(parseObject(run.contextSnapshot).interactionId);
    if (interactionId) {
      const interaction = await db.select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions).where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.companyId, incident.companyId),
          eq(issueThreadInteractions.issueId, incident.repairIssueId),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "accepted"),
          eq(issueThreadInteractions.createdByAgentId, config.repairAgentId),
          eq(issueThreadInteractions.sourceRunId, incident.repairRunId),
          eq(issueThreadInteractions.addresseeAgentId, config.reviewerAgentId),
          eq(issueThreadInteractions.resolvedByAgentId, config.reviewerAgentId),
          eq(issueThreadInteractions.resolvedByRunId, run.id),
        )).limit(1).then((rows) => rows[0] ?? null);
      // An interaction-bound run cannot borrow an unrelated stage decision.
      return Boolean(interaction);
    }
    const decision = await db
      .select({ id: issueExecutionDecisions.id })
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.companyId, incident.companyId),
        eq(issueExecutionDecisions.issueId, incident.repairIssueId),
        eq(issueExecutionDecisions.createdByRunId, run.id),
        eq(issueExecutionDecisions.actorAgentId, config.reviewerAgentId),
        eq(issueExecutionDecisions.stageType, "review"),
        eq(issueExecutionDecisions.outcome, "approved"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(decision);
  }

  async function wakeRecoveryAfterActivation(incident: IncidentRow, config: ConfigRow) {
    if (!incident.maintenanceIssueId) {
      await escalateToBoard(incident.id, "maintenance_issue_missing_after_activation");
      return null;
    }
    const recoveryAgent = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, config.agentId), eq(agents.companyId, incident.companyId)))
      .then((rows) => rows[0] ?? null);
    const invokability = await evaluateAgentInvokabilityFromDb(db, recoveryAgent);
    if (!invokability.invokable) {
      await escalateToBoard(incident.id, "recovery_agent_unavailable_after_activation");
      return null;
    }
    const maintenance = await issuesSvc.getById(incident.maintenanceIssueId);
    if (!maintenance || ["done", "cancelled"].includes(maintenance.status)) {
      await escalateToBoard(incident.id, "maintenance_issue_closed_before_activation");
      return null;
    }
    // The resume instruction wake dispatches through the same advisory seam
    // the sweep's re-arm uses, so the activating request and a concurrent
    // sweep serialize on the same intent key. A recognized hold parks the
    // instruction without escalating: the confirmed activation and the wake
    // ledger are the durable dispatch intent, and the sweep re-arms it when
    // the condition clears.
    const pass = await rearmIncidentWake({
      incidentId: incident.id,
      companyId: incident.companyId,
      agentId: config.agentId,
      idempotencyKey: `${ACTIVATED_WAKE_KEY_PREFIX}${incident.id}:${incident.activatedRepairCommit}`,
      exhaustedReason: ACTIVATED_DISPATCH_EXHAUSTED_REASON,
      // The instruction wake has no dedicated incident run column: the wake
      // ledger row is its durable dispatch record.
      bindingField: null,
      guard: (current) =>
        !current.resumedRunId &&
        current.activatedRepairCommit !== null &&
        current.activatedRepairCommit === current.repairCommit,
      claim: async (tx) => {
        // Mirror the original promotion: the activation is confirmed, so the
        // activation wait is no longer the next action.
        if (["blocked", "todo"].includes(maintenance.status)) {
          await issuesSvc.update(maintenance.id, { status: "in_progress" }, tx);
        }
        return incident;
      },
      enqueue: (bindRun) => deps.enqueueWakeup(config.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "recovery_engineer_activated",
        idempotencyKey: `${ACTIVATED_WAKE_KEY_PREFIX}${incident.id}:${incident.activatedRepairCommit}`,
        payload: {
          issueId: maintenance.id,
          incidentId: incident.id,
          action: "resume",
          repairCommit: incident.activatedRepairCommit,
        },
        contextSnapshot: {
          issueId: maintenance.id,
          taskId: maintenance.id,
          incidentId: incident.id,
          repairCommit: incident.activatedRepairCommit,
          wakeReason: "recovery_engineer_activated",
          source: "recovery_engineer.repair_activated",
          recoveryRole: "resume",
        },
        requestedByActorType: "system",
        requestedByActorId: "recovery_engineer",
        // The instruction wake has no dedicated incident run column: its
        // durable dispatch record is the wake ledger row itself, deduped by
        // the dispatch claim lease.
        bindRun,
      }),
      onDispatched: async (runId) => {
        await logActivity(db, {
          companyId: incident.companyId,
          actorType: "system",
          actorId: "recovery_engineer",
          agentId: null,
          runId,
          action: "recovery_engineer.post_activation_resume_rearmed",
          entityType: "recovery_engineer_incident",
          entityId: incident.id,
          details: {
            maintenanceIssueId: maintenance.id,
            repairCommit: incident.activatedRepairCommit,
          },
        });
      },
      onAdopted: async (wake) => {
        await reopenDispatchFailureEscalation(incident.id, "verified");
        if (!wake.runId) return "adopted";
        const run = await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, wake.runId))
          .then((rows) => rows[0] ?? null);
        if (
          run &&
          (run.status === "succeeded" ||
            PARTICIPANT_FAILURE_STATUSES.includes(run.status as never))
        ) {
          await handleParticipantRun(incident, config, run, "recovery");
        }
        return "completed";
      },
    });
    if (!pass.runId) return null;
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, pass.runId))
      .then((rows) => rows[0] ?? null);
  }

  async function finalizeVerificationForRun(run: RunRow) {
    const verification = await db
      .select()
      .from(recoveryEngineerVerifications)
      .where(and(
        eq(recoveryEngineerVerifications.companyId, run.companyId),
        eq(recoveryEngineerVerifications.reviewRunId, run.id),
        eq(recoveryEngineerVerifications.status, "pending"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!verification) return null;
    const incident = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(eq(recoveryEngineerIncidents.id, verification.incidentId))
      .then((rows) => rows[0] ?? null);
    const config = incident ? await getConfigRow(incident.companyId) : null;
    if (!incident || !config || run.agentId !== config.reviewerAgentId) {
      await db
        .update(recoveryEngineerVerifications)
        .set({
          status: "failed",
          failureReason: "reviewer_authority_changed",
          finalizedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(recoveryEngineerVerifications.id, verification.id));
      return null;
    }
    if (run.status !== "succeeded") {
      if (PARTICIPANT_FAILURE_STATUSES.includes(run.status as never)) {
        await db
          .update(recoveryEngineerVerifications)
          .set({
            status: "failed",
            failureReason: `review_run_${run.status}`,
            finalizedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(recoveryEngineerVerifications.id, verification.id),
            eq(recoveryEngineerVerifications.status, "pending"),
          ));
        await escalateToBoard(incident.id, `independent_review_${run.status}`, run.id);
      }
      return null;
    }
    const repairSucceeded = await hasSuccessfulRepairRun(incident, config);
    const reviewFailureReason = !repairSucceeded
      ? "repair_run_not_successful"
      : runIssueId(run) !== incident.repairIssueId
        ? "review_run_repair_scope_mismatch"
        : await hasAcceptedNativeReview(incident, config, run)
          ? null
          : "review_run_not_approved";
    if (reviewFailureReason) {
      const finalizedAt = new Date();
      await db
        .update(recoveryEngineerVerifications)
        .set({
          status: "failed",
          failureReason: reviewFailureReason,
          finalizedAt,
          updatedAt: finalizedAt,
        })
        .where(and(
          eq(recoveryEngineerVerifications.id, verification.id),
          eq(recoveryEngineerVerifications.status, "pending"),
        ));
      await escalateToBoard(incident.id, reviewFailureReason, run.id);
      return null;
    }

    const now = new Date();
    const verifiedIncident = await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "verified",
        repairCommit: verification.repairCommit,
        verifiedVerificationId: verification.id,
        verifiedReviewRunId: run.id,
        verifiedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        isNull(recoveryEngineerIncidents.verifiedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!verifiedIncident) {
      const current = await db
        .select()
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, incident.id))
        .then((rows) => rows[0] ?? null);
      if (current?.verifiedReviewRunId !== run.id) {
        if (
          current?.verifiedAt &&
          current.repairCommit &&
          current.repairCommit === verification.repairCommit &&
          current.verifiedVerificationId
        ) {
          // The incident is already verified at this exact repair commit by an
          // earlier independent review. This later confirmation is accepted
          // idempotently and attributed to the existing fence: the incident's
          // attribution, the repair issue status, and every gate stay exactly
          // as they are.
          await db
            .update(recoveryEngineerVerifications)
            .set({
              status: "verified",
              failureReason: null,
              duplicateOfVerificationId: current.verifiedVerificationId,
              finalizedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(recoveryEngineerVerifications.id, verification.id),
              eq(recoveryEngineerVerifications.status, "pending"),
            ));
          await logActivity(db, {
            companyId: incident.companyId,
            actorType: "agent",
            actorId: config.reviewerAgentId,
            agentId: config.reviewerAgentId,
            runId: run.id,
            action: "recovery_engineer.verification_duplicate_confirmed",
            entityType: "recovery_engineer_incident",
            entityId: incident.id,
            details: {
              verificationId: verification.id,
              incidentId: incident.id,
              repairCommit: verification.repairCommit,
              existingVerificationId: current.verifiedVerificationId,
              existingReviewRunId: current.verifiedReviewRunId,
            },
          });
          return {
            ...verification,
            status: "verified",
            failureReason: null,
            duplicateOfVerificationId: current.verifiedVerificationId,
            finalizedAt: now,
          };
        }
        await db
          .update(recoveryEngineerVerifications)
          .set({
            status: "failed",
            failureReason: "incident_already_verified_by_another_run",
            finalizedAt: now,
            updatedAt: now,
          })
          .where(eq(recoveryEngineerVerifications.id, verification.id));
        return null;
      }
    }
    await db
      .update(recoveryEngineerVerifications)
      .set({ status: "verified", failureReason: null, finalizedAt: now, updatedAt: now })
      .where(and(
        eq(recoveryEngineerVerifications.id, verification.id),
        eq(recoveryEngineerVerifications.status, "pending"),
      ));
    const effectiveIncident = verifiedIncident ?? incident;
    const repairIssue = await issuesSvc.getById(verification.repairIssueId);
    if (
      repairIssue?.companyId === incident.companyId &&
      repairIssue.originKind === RECOVERY_ENGINEER_ORIGIN_KINDS.repair &&
      repairIssue.originId === incident.id &&
      ["in_progress", "in_review"].includes(repairIssue.status) &&
      !(await hasPendingHumanGate(repairIssue, true)) &&
      !(await hasUnresolvedDependency(repairIssue))
    ) {
      await issuesSvc.update(repairIssue.id, { status: "done" });
    }
    if (effectiveIncident.maintenanceIssueId) {
      const maintenance = await issuesSvc.getById(effectiveIncident.maintenanceIssueId);
      if (maintenance && !["done", "cancelled"].includes(maintenance.status)) {
        await issuesSvc.update(maintenance.id, {
          status: "blocked",
          unblockDescriptor: {
            owner: "board",
            action: `Activate verified repair commit ${verification.repairCommit} in the live runtime and record exact activation evidence before resume.`,
          },
        });
      }
    }
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: "agent",
      actorId: config.reviewerAgentId,
      agentId: config.reviewerAgentId,
      runId: run.id,
      action: "recovery_engineer.verification_finalized",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: {
        verificationId: verification.id,
        repairIssueId: verification.repairIssueId,
        repairCommit: verification.repairCommit,
        nativeReviewAccepted: true,
        activationRequired: true,
      },
    });
    return { ...verification, status: "verified", finalizedAt: now, failureReason: null };
  }

  async function submitVerification(
    incident: IncidentRow,
    config: ConfigRow,
    input: RecoveryEngineerVerifyInput,
    actor: RecoveryEngineerActor,
  ) {
    if (!incident.repairIssueId) throw conflict("Incident has no scoped repair issue");
    const actorScope = await getActorRun(actor, config, incident, ["reviewer"], "repair");
    if (!actor.board && actorScope.run?.id !== input.reviewRunId) {
      throw forbidden("Reviewer may submit evidence only for its current run");
    }
    if (!await hasSuccessfulRepairRun(incident, config)) {
      throw unprocessable("Verification requires a successful configured repair run bound to this incident");
    }
    const reviewRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.reviewRunId),
        eq(heartbeatRuns.companyId, incident.companyId),
        eq(heartbeatRuns.agentId, config.reviewerAgentId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!reviewRun || runIssueId(reviewRun) !== incident.repairIssueId) {
      throw unprocessable("Review run is not bound to the incident repair issue");
    }
    if (reviewRun.agentId === config.repairAgentId) {
      throw forbidden("Repair author cannot verify its own repair");
    }
    if (actor.board && reviewRun.status !== "succeeded") {
      throw unprocessable("Board verification requires a completed successful independent review run");
    }
    if (PARTICIPANT_FAILURE_STATUSES.includes(reviewRun.status as never)) {
      throw unprocessable("An unsuccessful review run cannot verify a repair", {
        reviewRunStatus: reviewRun.status,
      });
    }
    if (reviewRun.status !== "succeeded" && !ACTIVE_RUN_STATUSES.includes(reviewRun.status as never)) {
      throw unprocessable("Review run is not active or successful", {
        reviewRunStatus: reviewRun.status,
      });
    }

    const reproductionCommand = redactSensitiveText(input.reproductionCommand);
    const reproductionResult = redactSensitiveText(input.reproductionResult);
    let verification = await db
      .select()
      .from(recoveryEngineerVerifications)
      .where(and(
        eq(recoveryEngineerVerifications.companyId, incident.companyId),
        eq(recoveryEngineerVerifications.reviewRunId, reviewRun.id),
      ))
      .then((rows) => rows[0] ?? null);
    if (verification) {
      const equivalent = verification.incidentId === incident.id &&
        verification.repairIssueId === incident.repairIssueId &&
        verification.repairCommit === input.repairCommit &&
        verification.reproductionCommand === reproductionCommand &&
        verification.reproductionResult === reproductionResult;
      if (!equivalent) throw conflict("Review run already has different verification evidence");
      if (verification.status === "verified") return verification;
      if (verification.status === "failed") {
        throw conflict("Review run verification has already failed");
      }
    } else {
      try {
        verification = await db
          .insert(recoveryEngineerVerifications)
          .values({
            companyId: incident.companyId,
            incidentId: incident.id,
            repairIssueId: incident.repairIssueId,
            reviewRunId: reviewRun.id,
            status: "pending",
            repairCommit: input.repairCommit,
            reproductionCommand,
            reproductionResult,
            submittedByAgentId: actor.agentId,
            submittedByUserId: actor.userId,
          })
          .returning()
          .then((rows) => rows[0]!);
      } catch (error) {
        if (!isUniqueViolation(error, VERIFICATION_RUN_CONSTRAINT)) throw error;
        verification = await db
          .select()
          .from(recoveryEngineerVerifications)
          .where(and(
            eq(recoveryEngineerVerifications.companyId, incident.companyId),
            eq(recoveryEngineerVerifications.reviewRunId, reviewRun.id),
          ))
          .then((rows) => rows[0] ?? null);
        if (!verification) throw error;
      }
    }
    await db
      .update(recoveryEngineerIncidents)
      .set({
        status: "verifying",
        repairCommit: input.repairCommit,
        activatedRepairCommit: null,
        activationEvidence: null,
        activatedByUserId: null,
        activatedAt: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        isNull(recoveryEngineerIncidents.verifiedAt),
      ));

    if (reviewRun.status === "succeeded") {
      const finalized = await finalizeVerificationForRun(reviewRun);
      if (!finalized) {
        throw unprocessable("Successful review run has no accepted native review decision");
      }
      return finalized;
    }
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: actor.actorType,
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      runId: actor.runId,
      action: "recovery_engineer.verification_submitted",
      entityType: "recovery_engineer_verification",
      entityId: verification.id,
      details: {
        incidentId: incident.id,
        reviewRunId: reviewRun.id,
        status: "pending_terminal_success",
        repairCommit: input.repairCommit,
      },
    });
    return verification;
  }

  async function assertNoResumeGates(issue: IssueRow, ownerAgentId: string) {
    if (issue.checkoutRunId || issue.executionRunId || issue.executionLockedAt) {
      throw conflict("Source issue still has an execution lock; recovery will not disturb live or dirty work");
    }
    // One definition of "a live path already owns the next action", shared with
    // the maintenance wait and the replay re-validation, including wakes that
    // carry their issue linkage only inside `_paperclipWakeContext`.
    if (await hasLiveExecutionPath(issue, ownerAgentId)) {
      throw conflict("Source issue already has an active or queued execution path");
    }
    if (await hasPendingHumanGate(issue)) {
      throw conflict("Source issue has a pause, approval, interaction, review, or human-owner gate");
    }
    if (await hasUnresolvedDependency(issue)) {
      throw conflict("Source issue still has unresolved dependencies");
    }
  }

  async function confirmActivation(
    companyId: string,
    incidentId: string,
    input: RecoveryEngineerActivationRequest,
    userId: string,
  ) {
    const config = await getConfigRow(companyId);
    if (!config?.enabled) {
      throw conflict("Recovery engineer must be enabled to confirm live activation");
    }
    const incident = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(and(
        eq(recoveryEngineerIncidents.id, incidentId),
        eq(recoveryEngineerIncidents.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!incident) throw notFound("Recovery incident not found");
    if (!incident.verifiedVerificationId || !incident.verifiedAt) {
      throw conflict("Only a finalized independently verified repair can be activated");
    }
    const verification = await db
      .select()
      .from(recoveryEngineerVerifications)
      .where(and(
        eq(recoveryEngineerVerifications.id, incident.verifiedVerificationId),
        eq(recoveryEngineerVerifications.incidentId, incident.id),
        eq(recoveryEngineerVerifications.status, "verified"),
      ))
      .then((rows) => rows[0] ?? null);
    if (
      !verification ||
      verification.repairCommit !== input.repairCommit ||
      incident.repairCommit !== input.repairCommit
    ) {
      throw conflict("Activation commit does not match the finalized verified repair");
    }
    const activationEvidence = redactSensitiveText(input.activationEvidence);
    if (incident.activatedAt) {
      if (
        incident.activatedRepairCommit === input.repairCommit &&
        incident.activationEvidence === activationEvidence
      ) {
        return incident;
      }
      throw conflict("Activation confirmation is immutable once recorded");
    }
    if (
      incident.activatedRepairCommit &&
      incident.activatedRepairCommit !== input.repairCommit
    ) {
      throw conflict("A different repair commit is already activated for this incident");
    }
    const activatedAt = new Date();
    const updated = await db
      .update(recoveryEngineerIncidents)
      .set({
        activatedRepairCommit: input.repairCommit,
        activationEvidence,
        activatedByUserId: userId,
        activatedAt,
        updatedAt: activatedAt,
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incident.id),
        eq(recoveryEngineerIncidents.verifiedVerificationId, verification.id),
        eq(recoveryEngineerIncidents.repairCommit, input.repairCommit),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) throw conflict("Verified repair changed before activation was recorded");
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      agentId: null,
      runId: null,
      action: "recovery_engineer.repair_activation_confirmed",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: {
        activationEvidence,
        verificationId: verification.id,
        reviewRunId: verification.reviewRunId,
      },
    });
    await wakeRecoveryAfterActivation(updated, config);
    return updated;
  }

  /**
   * Dispatches (or replays) the resume of one source generation through the
   * normal wake path. The persisted claim key makes replay idempotent: an
   * already-materialized wake or run is adopted instead of duplicated, a crash
   * between claim and dispatch is recovered by re-enqueueing the same key, and
   * only a bounded number of attempts is ever spent before the generation is
   * superseded and the board takes over. Dispatch is not recovery: the source
   * generation stays open until evidence shows the original path overcame the
   * failure.
   */
  async function dispatchResumeWake(input: {
    incident: IncidentRow;
    config: ConfigRow;
    source: SourceRow;
    issue: IssueRow;
    actor: RecoveryEngineerActor | null;
  }): Promise<{ dispatched: boolean; runId: string | null; attempt: number; reason: string | null }> {
    const idempotencyKey = input.source.resumeIdempotencyKey ??
      resumeIdempotencyKeyFor(input.incident.id, input.source.id);
    const ownerAgentId = input.source.originalOwnerAgentId;
    if (!ownerAgentId || input.source.originalOwnerUserId) {
      await closeSourceGeneration({
        incident: input.incident,
        source: input.source,
        close: { kind: "superseded", reason: "source_owner_human" },
      });
      await rollUpIncidentOutcome(input.incident.id);
      return { dispatched: false, runId: null, attempt: input.source.resumeAttemptCount, reason: "owner_not_agent" };
    }
    const existingWake = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, input.incident.companyId),
        eq(agentWakeupRequests.agentId, ownerAgentId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ))
      .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingWake && (
      existingWake.runId ||
      LIVE_WAKE_REQUEST_STATUSES.includes(existingWake.status as never)
    )) {
      // The dispatch already materialized (or still owns a durable queued path):
      // adopt it instead of minting a second wake for the same decision.
      const adoptedAt = existingWake.claimedAt ?? existingWake.requestedAt ?? new Date();
      await db
        .update(recoveryEngineerIncidentSources)
        .set({
          resumeClaimedAt: input.source.resumeClaimedAt ?? adoptedAt,
          resumeIdempotencyKey: idempotencyKey,
          resumeDispatchedAt: input.source.resumeDispatchedAt ?? adoptedAt,
          resumedAt: input.source.resumedAt ?? adoptedAt,
          resumedRunId: input.source.resumedRunId ?? existingWake.runId ?? null,
          resumeFailureReason: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(recoveryEngineerIncidentSources.id, input.source.id),
          isNull(recoveryEngineerIncidentSources.recoveredAt),
          isNull(recoveryEngineerIncidentSources.supersededAt),
        ));
      await rollUpIncidentOutcome(input.incident.id);
      return {
        dispatched: true,
        runId: existingWake.runId ?? input.source.resumedRunId ?? null,
        attempt: input.source.resumeAttemptCount,
        reason: "adopted_existing_wake",
      };
    }
    if (input.source.resumeAttemptCount >= RESUME_DISPATCH_MAX_ATTEMPTS) {
      await closeSourceGeneration({
        incident: input.incident,
        source: input.source,
        close: { kind: "superseded", reason: "resume_attempts_exhausted" },
      });
      await escalateToBoard(input.incident.id, "verified_resume_attempts_exhausted", input.actor?.runId ?? null);
      await rollUpIncidentOutcome(input.incident.id);
      return {
        dispatched: false,
        runId: null,
        attempt: input.source.resumeAttemptCount,
        reason: "resume_attempts_exhausted",
      };
    }

    // A replay the sweep performs later must not wake a stale owner or fight a
    // path that appeared after the claim, so ownership, liveness and gates are
    // re-validated against the issue as it stands now before another attempt is
    // spent. The original owner identity is the contract: a changed owner is
    // superseded, a live path or gate is merely held (the sweep retries later).
    const latestRun = await latestIssueRun(input.issue);
    if (input.issue.assigneeUserId || input.issue.assigneeAgentId !== ownerAgentId) {
      const reason: RecoveryEngineerSourceCloseReason = input.issue.assigneeUserId
        ? "source_owner_human"
        : "source_owner_changed";
      await closeSourceGeneration({
        incident: input.incident,
        source: input.source,
        close: { kind: "superseded", reason },
      });
      await rollUpIncidentOutcome(input.incident.id);
      return { dispatched: false, runId: null, attempt: input.source.resumeAttemptCount, reason };
    }
    if (await hasLiveExecutionPath(input.issue, ownerAgentId)) {
      return {
        dispatched: false,
        runId: null,
        attempt: input.source.resumeAttemptCount,
        reason: "live_execution_path",
      };
    }
    const gate = await sourceGateKind(input.issue, latestRun);
    if (gate !== "none") {
      return {
        dispatched: false,
        runId: null,
        attempt: input.source.resumeAttemptCount,
        reason: `${gate}_gate`,
      };
    }

    const attempt = input.source.resumeAttemptCount + 1;
    const attemptAt = new Date();
    const claimed = await db
      .update(recoveryEngineerIncidentSources)
      .set({
        resumeClaimedAt: input.source.resumeClaimedAt ?? attemptAt,
        resumeIdempotencyKey: idempotencyKey,
        resumeAttemptCount: attempt,
        resumeLastAttemptAt: attemptAt,
        updatedAt: attemptAt,
      })
      .where(and(
        eq(recoveryEngineerIncidentSources.id, input.source.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) {
      return { dispatched: false, runId: null, attempt, reason: "generation_closed" };
    }

    let run: RunRow | null = null;
    let failureReason: string | null = null;
    try {
      run = await deps.enqueueWakeup(ownerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "recovery_engineer_resume",
        idempotencyKey,
        payload: {
          issueId: input.issue.id,
          incidentId: input.incident.id,
          sourceId: input.source.id,
          verificationId: input.incident.verifiedVerificationId,
          repairCommit: input.incident.repairCommit,
        },
        contextSnapshot: {
          issueId: input.issue.id,
          taskId: input.issue.id,
          incidentId: input.incident.id,
          sourceId: input.source.id,
          verificationId: input.incident.verifiedVerificationId,
          repairCommit: input.incident.repairCommit,
          wakeReason: "recovery_engineer_resume",
          source: "recovery_engineer.verified_resume",
          retryOfRunId: input.source.sourceRunId,
        },
        requestedByActorType: input.actor?.actorType ?? "system",
        requestedByActorId: input.actor ? (input.actor.agentId ?? input.actor.userId) : "recovery_engineer",
      });
    } catch {
      failureReason = "resume_enqueue_failed";
    }
    if (!run) {
      const recordedReason = failureReason ?? "resume_not_enqueued";
      await db
        .update(recoveryEngineerIncidentSources)
        .set({ resumeFailureReason: recordedReason, updatedAt: new Date() })
        .where(eq(recoveryEngineerIncidentSources.id, input.source.id));
      await escalateToBoard(input.incident.id, recordedReason, input.actor?.runId ?? null);
      return { dispatched: false, runId: null, attempt, reason: recordedReason };
    }
    const dispatchedAt = new Date();
    await db
      .update(recoveryEngineerIncidentSources)
      .set({
        resumedAt: dispatchedAt,
        resumedRunId: run.id,
        resumeDispatchedAt: dispatchedAt,
        resumeFailureReason: null,
        updatedAt: dispatchedAt,
      })
      .where(and(
        eq(recoveryEngineerIncidentSources.id, input.source.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ));
    await db
      .update(recoveryEngineerIncidents)
      .set({
        resumedSourceIssueId: input.issue.id,
        resumedRunId: run.id,
        resumedAt: dispatchedAt,
        updatedAt: dispatchedAt,
      })
      .where(eq(recoveryEngineerIncidents.id, input.incident.id));
    if (input.issue.status === "blocked") {
      const gate = await sourceGateKind(input.issue, latestRun);
      if (gate === "none") {
        await issuesSvc.update(input.issue.id, { status: "in_progress" });
      }
    }
    await logActivity(db, {
      companyId: input.incident.companyId,
      actorType: input.actor?.actorType ?? "system",
      actorId: input.actor
        ? (input.actor.agentId ?? input.actor.userId ?? "board")
        : "recovery_engineer",
      agentId: input.actor?.agentId ?? null,
      runId: input.actor?.runId ?? null,
      action: "recovery_engineer.source_resumed",
      entityType: "recovery_engineer_incident",
      entityId: input.incident.id,
      details: {
        sourceId: input.source.id,
        sourceIssueId: input.issue.id,
        generationKey: input.source.generationKey,
        originalOwnerAgentId: ownerAgentId,
        resumedRunId: run.id,
        resumeAttempt: attempt,
        automatic: input.actor === null,
        verificationId: input.incident.verifiedVerificationId,
        repairCommit: input.incident.repairCommit,
        outcomePending: true,
      },
    });
    await rollUpIncidentOutcome(input.incident.id);
    return { dispatched: true, runId: run.id, attempt, reason: null };
  }

  async function resumeSource(
    incident: IncidentRow,
    config: ConfigRow,
    input: RecoveryEngineerResumeInput,
    actor: RecoveryEngineerActor,
  ) {
    await getActorRun(actor, config, incident, ["recovery"], "maintenance");
    if (!incident.verifiedAt || !incident.verifiedVerificationId || !incident.verifiedReviewRunId) {
      throw conflict("Incident has no finalized independent verification");
    }
    const verification = await db
      .select()
      .from(recoveryEngineerVerifications)
      .where(and(
        eq(recoveryEngineerVerifications.id, incident.verifiedVerificationId),
        eq(recoveryEngineerVerifications.incidentId, incident.id),
        eq(recoveryEngineerVerifications.status, "verified"),
        eq(recoveryEngineerVerifications.reviewRunId, incident.verifiedReviewRunId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!verification || verification.repairCommit !== incident.repairCommit) {
      throw conflict("Verified repair record is inconsistent");
    }
    if (
      !incident.activatedAt ||
      incident.activatedRepairCommit !== verification.repairCommit ||
      !incident.activationEvidence
    ) {
      throw conflict("Verified repair has not been activated in the live runtime by the board");
    }
    const newestGeneration = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, incident.id),
        eq(recoveryEngineerIncidentSources.sourceIssueId, input.sourceIssueId),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!newestGeneration) throw unprocessable("Source issue is not linked to this incident");
    if (newestGeneration.recoveredAt) {
      throw conflict("This source failure generation has already recovered");
    }
    if (newestGeneration.supersededAt) {
      throw conflict("This source failure generation is no longer recoverable", {
        reason: newestGeneration.supersededReason,
      });
    }
    const source = newestGeneration;
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.sourceIssueId), eq(issues.companyId, incident.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Source issue not found");

    if (source.resumedAt || source.resumeClaimedAt) {
      // A dispatch decision already exists for this generation. Replay it
      // through the persisted key instead of re-validating the generation: the
      // dispatch itself legitimately moves the issue's status, and replaying is
      // how a restart between claim and dispatch is recovered without a second
      // wake.
      const replay = await dispatchResumeWake({ incident, config, source, issue, actor });
      if (!replay.dispatched) {
        throw conflict("Source failure generation was resumed but its dispatch did not complete", {
          reason: replay.reason,
          resumeAttempts: replay.attempt,
        });
      }
      return {
        incident: await findIncident(incident.companyId, incident.failureFingerprint) ?? incident,
        sourceIssueId: issue.id,
        sourceId: source.id,
        resumedRunId: replay.runId,
        replayed: true,
        outcomePending: true,
      };
    }

    if (!source.originalOwnerAgentId || source.originalOwnerUserId) {
      throw conflict("Original source owner is not an invokable agent");
    }
    if (
      issue.assigneeAgentId !== source.originalOwnerAgentId ||
      issue.assigneeUserId !== source.originalOwnerUserId
    ) {
      throw conflict("Source owner changed after failure; recovery will not restore stale ownership");
    }
    // The generation is the native status generation plus the captured status
    // and owner. Cosmetic issue updates (comments, description edits) must not
    // invalidate a source generation, so `updatedAt` is deliberately not part
    // of this check; every remaining gate is verified separately below.
    if (
      issue.statusVersion !== source.sourceStatusVersion ||
      issue.status !== source.sourceStatus
    ) {
      throw conflict("Source failure generation changed after detection");
    }
    if (!["todo", "in_progress", "blocked"].includes(issue.status)) {
      throw conflict("Source issue is not in a resumable state");
    }
    const newestRun = await latestIssueRun(issue);
    if (source.sourceRunId && newestRun?.id !== source.sourceRunId) {
      throw conflict("Source run generation changed after detection");
    }
    const owner = await db
      .select()
      .from(agents)
      .where(and(
        eq(agents.id, source.originalOwnerAgentId),
        eq(agents.companyId, incident.companyId),
      ))
      .then((rows) => rows[0] ?? null);
    const invokability = await evaluateAgentInvokabilityFromDb(db, owner);
    if (!invokability.invokable) {
      throw conflict("Original source owner is not invokable", { reason: invokability.reason });
    }
    await assertNoResumeGates(issue, source.originalOwnerAgentId);

    const dispatched = await dispatchResumeWake({ incident, config, source, issue, actor });
    if (!dispatched.dispatched) {
      throw conflict("Verified resume was claimed but the guarded wake could not be enqueued", {
        reason: dispatched.reason,
        resumeAttempts: dispatched.attempt,
      });
    }
    return {
      incident: await findIncident(incident.companyId, incident.failureFingerprint) ?? incident,
      sourceIssueId: issue.id,
      sourceId: source.id,
      resumedRunId: dispatched.runId,
      replayed: dispatched.reason === "adopted_existing_wake",
      outcomePending: true,
    };
  }

  async function recordAction(
    issueId: string,
    input:
      | RecoveryEngineerDiagnoseInput
      | RecoveryEngineerProcedureInput
      | RecoveryEngineerRepairInput
      | RecoveryEngineerVerifyInput
      | RecoveryEngineerResumeInput
      | RecoveryEngineerProcedureReuseInput,
    actor: RecoveryEngineerActor,
  ) {
    if (input.action === "reuse_procedure") {
      const issue = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      return recordProcedureReuse(issue.companyId, input, actor);
    }
    const resolved = await resolveIncidentForIssue(issueId);
    if (!resolved) throw notFound("Recovery incident not found");
    const config = await getConfigRow(resolved.incident.companyId);
    if (!config) throw notFound("Recovery engineer is not configured");
    if (!config.enabled) throw conflict("Recovery engineer is disabled");
    if (input.action === "diagnose") {
      return recordDiagnosis(resolved.incident, config, input, actor);
    }
    if (input.action === "request_repair") {
      return requestRepair(resolved.incident, config, input, actor);
    }
    if (input.action === "propose_procedure") {
      return proposeProcedure(resolved.incident, config, input, actor);
    }
    if (input.action === "verify") {
      return submitVerification(resolved.incident, config, input, actor);
    }
    return resumeSource(resolved.incident, config, input, actor);
  }

  async function reviewProcedure(
    companyId: string,
    procedureId: string,
    input: RecoveryEngineerProcedureReviewInput,
    userId: string,
  ) {
    const existing = await db
      .select()
      .from(recoveryEngineerProcedures)
      .where(and(
        eq(recoveryEngineerProcedures.id, procedureId),
        eq(recoveryEngineerProcedures.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Recovery procedure not found");
    if (existing.status === "retired" && input.status !== "retired") {
      throw conflict("Retired recovery procedures cannot be promoted again");
    }
    if (input.status === "reviewed" && existing.status !== "proposed" && existing.status !== "reviewed") {
      throw conflict("Only proposed recovery procedures can be reviewed");
    }
    const updated = await db
      .update(recoveryEngineerProcedures)
      .set({
        status: input.status,
        reviewNote: redactSensitiveText(input.reviewNote),
        reviewedByUserId: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
        // A fresh review is a fresh authorization: it clears an invalidation
        // and the consumed failure budget, while the reuse ledger keeps the
        // full history for audit.
        ...(input.status === "reviewed"
          ? { failedReuseCount: 0, invalidatedAt: null, invalidatedReason: null }
          : {}),
      })
      .where(and(
        eq(recoveryEngineerProcedures.id, procedureId),
        eq(recoveryEngineerProcedures.companyId, companyId),
      ))
      .returning()
      .then((rows) => rows[0]!);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      agentId: null,
      runId: null,
      action: input.status === "reviewed"
        ? "recovery_engineer.procedure_reviewed"
        : "recovery_engineer.procedure_retired",
      entityType: "recovery_engineer_procedure",
      entityId: procedureId,
      details: { incidentId: existing.incidentId, status: input.status },
    });
    return updated;
  }

  async function loadProcedureReuses(procedureId: string): Promise<ProcedureReuseRow[]> {
    return db
      .select()
      .from(recoveryEngineerProcedureReuses)
      .where(eq(recoveryEngineerProcedureReuses.procedureId, procedureId))
      .orderBy(desc(recoveryEngineerProcedureReuses.appliedAt), desc(recoveryEngineerProcedureReuses.id))
      .limit(50);
  }

  /**
   * Applies a recorded reuse outcome to the procedure row. A failure consumes
   * the procedure's failure budget and invalidates it once the budget is gone,
   * so a repeated failure demands new evidence or a new review instead of
   * another replay.
   */
  async function applyProcedureReuseOutcome(input: {
    procedureId: string;
    status: RecoveryEngineerProcedureReuseStatus;
    failureReason: string | null;
  }): Promise<ProcedureRow | null> {
    const now = new Date();
    const updated = await db
      .update(recoveryEngineerProcedures)
      .set({
        lastReuseOutcome: input.status,
        lastReusedAt: now,
        updatedAt: now,
        ...(input.status === "failed"
          ? { failedReuseCount: sql`${recoveryEngineerProcedures.failedReuseCount} + 1` as unknown as number }
          : {}),
      })
      .where(eq(recoveryEngineerProcedures.id, input.procedureId))
      .returning()
      .then((rows) => rows[0] ?? null);
    const needsInvalidation = Boolean(
      updated &&
      input.status === "failed" &&
      updated.failedReuseCount >= RECOVERY_ENGINEER_PROCEDURE_MAX_FAILED_REUSES &&
      updated.invalidatedAt === null,
    );
    if (needsInvalidation) {
      await db
        .update(recoveryEngineerProcedures)
        .set({
          invalidatedAt: now,
          invalidatedReason: `repeated_reuse_failure:${input.failureReason ?? "unspecified"}`.slice(0, 200),
          updatedAt: now,
        })
        .where(and(
          eq(recoveryEngineerProcedures.id, input.procedureId),
          isNull(recoveryEngineerProcedures.invalidatedAt),
        ));
    }
    return updated;
  }

  /**
   * Records a procedure reuse against one failure generation. The store is the
   * only authority: an application is refused unless the reviewed context still
   * matches, and a terminal outcome may only finalize an application that was
   * actually recorded — so self-reported success can never enter the ledger
   * without a verdict, and an application can still be closed after its
   * generation (or the whole incident) recovered. Nothing here executes any step
   * of the procedure.
   */
  async function recordProcedureReuse(
    companyId: string,
    input: RecoveryEngineerProcedureReuseInput,
    actor: RecoveryEngineerActor,
  ) {
    const procedure = await db
      .select()
      .from(recoveryEngineerProcedures)
      .where(and(
        eq(recoveryEngineerProcedures.id, input.procedureId),
        eq(recoveryEngineerProcedures.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!procedure) throw notFound("Recovery procedure not found");
    const incident = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(and(
        eq(recoveryEngineerIncidents.id, procedure.incidentId),
        eq(recoveryEngineerIncidents.companyId, companyId),
      ))
      .then((rows) => rows[0] ?? null);
    if (!incident) throw notFound("Recovery incident not found");
    const config = await getConfigRow(companyId);
    if (!config) throw notFound("Recovery engineer is not configured");
    if (!config.enabled) throw conflict("Recovery engineer is disabled");
    await assertReadAuthority(actor, config, incident);

    const requestedOutcome = input.outcome ?? "applied";
    const recordedFor = await db
      .select()
      .from(recoveryEngineerProcedureReuses)
      .where(and(
        eq(recoveryEngineerProcedureReuses.companyId, companyId),
        eq(recoveryEngineerProcedureReuses.procedureId, procedure.id),
        eq(recoveryEngineerProcedureReuses.incidentId, incident.id),
        eq(recoveryEngineerProcedureReuses.evidenceKey, input.evidenceKey),
      ))
      .orderBy(desc(recoveryEngineerProcedureReuses.appliedAt), desc(recoveryEngineerProcedureReuses.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (requestedOutcome === "applied" && recordedFor) {
      if (recordedFor.status === "applied" || recordedFor.status === "refused") {
        // Idempotent replay of an application: the ledger row (including its
        // refusalReason and stored applicability) is the record, so a repeat
        // never re-evaluates the context or overwrites the original verdict.
        return {
          recorded: recordedFor.status === "applied",
          verdict: {
            applicable: recordedFor.status === "applied",
            reason: null,
            requiresNewEvidence: false,
          },
          reuse: recordedFor,
        };
      }
      throw conflict("Procedure reuse for this evidence already has a terminal outcome", {
        status: recordedFor.status,
      });
    }
    if (requestedOutcome !== "applied") {
      if (!recordedFor) {
        throw conflict("No applied procedure reuse exists for this evidence", {
          procedureId: procedure.id,
          evidenceKey: input.evidenceKey,
        });
      }
      if (recordedFor.status !== "applied") {
        if (recordedFor.status === requestedOutcome) {
          return {
            recorded: true,
            verdict: { applicable: true, reason: null, requiresNewEvidence: false },
            reuse: recordedFor,
          };
        }
        throw conflict("Procedure reuse for this evidence already has a different outcome", {
          status: recordedFor.status,
          requestedStatus: requestedOutcome,
        });
      }
      const outcomeAt = new Date();
      const failureReason = input.failureReason ? redactSensitiveText(input.failureReason) : null;
      const finalized = await db
        .update(recoveryEngineerProcedureReuses)
        .set({
          status: requestedOutcome,
          refusalReason: failureReason,
          evidence: { ...recordedFor.evidence, ...(input.evidence ?? {}) },
          outcomeAt,
          outcomeRunId: actor.runId,
          updatedAt: outcomeAt,
        })
        .where(and(
          eq(recoveryEngineerProcedureReuses.id, recordedFor.id),
          eq(recoveryEngineerProcedureReuses.status, "applied"),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!finalized) {
        throw conflict("Procedure reuse already has a different outcome", {
          status: requestedOutcome,
        });
      }
      const procedureAfter = await applyProcedureReuseOutcome({
        procedureId: procedure.id,
        status: requestedOutcome,
        failureReason,
      });
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.agentId ?? actor.userId ?? "board",
        agentId: actor.agentId,
        runId: actor.runId,
        action: requestedOutcome === "failed"
          ? "recovery_engineer.procedure_reuse_failed"
          : "recovery_engineer.procedure_reuse_succeeded",
        entityType: "recovery_engineer_procedure",
        entityId: procedure.id,
        details: {
          incidentId: incident.id,
          reuseId: finalized.id,
          sourceIssueId: finalized.sourceIssueId,
          sourceGenerationKey: finalized.sourceGenerationKey,
          evidenceKey: input.evidenceKey,
          status: requestedOutcome,
          failureReason,
          failedReuseCount: procedureAfter?.failedReuseCount ?? procedure.failedReuseCount,
        },
      });
      return {
        recorded: true,
        verdict: { applicable: true, reason: null, requiresNewEvidence: false },
        reuse: finalized,
      };
    }

    const openSources = await db
      .select()
      .from(recoveryEngineerIncidentSources)
      .where(and(
        eq(recoveryEngineerIncidentSources.incidentId, incident.id),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
      ))
      .orderBy(desc(recoveryEngineerIncidentSources.observedAt), desc(recoveryEngineerIncidentSources.id));
    const targetSource = input.sourceIssueId
      ? openSources.find((source) => source.sourceIssueId === input.sourceIssueId) ?? null
      : openSources[0] ?? null;
    if (!targetSource) {
      throw unprocessable("Source issue has no open failure generation in this incident");
    }
    const contextSource = targetSource;
    const context = await procedureApplicabilityContextForIncident(incident, contextSource);
    const reuseHistory = (await loadProcedureReuses(procedure.id)).map((reuse) => ({
      status: reuse.status,
      evidenceKey: reuse.evidenceKey,
      sourceGenerationKey: reuse.sourceGenerationKey,
    } satisfies RecoveryEngineerProcedureReuseSummary));
    const verdict = evaluateRecoveryEngineerProcedureApplicability({
      procedure,
      context,
      evidenceKey: input.evidenceKey,
      reuseHistory,
    });
    const status: RecoveryEngineerProcedureReuseStatus = verdict.applicable ? "applied" : "refused";
    // Reuse is bound to the generation that is open right now: the ledger key
    // can never be pointed at a generation the caller chooses.
    const generationKey = contextSource.generationKey;
    const reuseValues: typeof recoveryEngineerProcedureReuses.$inferInsert = {
      companyId,
      incidentId: incident.id,
      procedureId: procedure.id,
      sourceIssueId: contextSource.sourceIssueId,
      sourceGenerationKey: generationKey,
      failureFingerprint: incident.failureFingerprint,
      evidenceKey: input.evidenceKey,
      status,
      refusalReason: verdict.applicable ? null : verdict.reason,
      applicability: {
        ...context,
        verdict: verdict.reason,
        requiresNewEvidence: verdict.requiresNewEvidence,
      },
      evidence: input.evidence ?? {},
      appliedByAgentId: actor.agentId,
      appliedByRunId: actor.runId,
      appliedByUserId: actor.userId,
      outcomeAt: null,
      outcomeRunId: null,
    };
    const reuse = await db
      .insert(recoveryEngineerProcedureReuses)
      .values(reuseValues)
      .onConflictDoNothing({
        target: [
          recoveryEngineerProcedureReuses.companyId,
          recoveryEngineerProcedureReuses.procedureId,
          recoveryEngineerProcedureReuses.incidentId,
          recoveryEngineerProcedureReuses.sourceIssueId,
          recoveryEngineerProcedureReuses.sourceGenerationKey,
          recoveryEngineerProcedureReuses.evidenceKey,
        ],
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!reuse) {
      const winner = await db
        .select()
        .from(recoveryEngineerProcedureReuses)
        .where(and(
          eq(recoveryEngineerProcedureReuses.companyId, companyId),
          eq(recoveryEngineerProcedureReuses.procedureId, procedure.id),
          eq(recoveryEngineerProcedureReuses.incidentId, incident.id),
          eq(recoveryEngineerProcedureReuses.sourceIssueId, contextSource.sourceIssueId),
          eq(recoveryEngineerProcedureReuses.sourceGenerationKey, generationKey),
          eq(recoveryEngineerProcedureReuses.evidenceKey, input.evidenceKey),
        ))
        .then((rows) => rows[0] ?? null);
      if (!winner) {
        throw conflict("Procedure reuse raced a concurrent record and could not be re-read", {
          constraint: PROCEDURE_REUSE_CONSTRAINT,
        });
      }
      return { recorded: winner.status !== "refused", verdict, reuse: winner };
    }
    const procedureAfter = await applyProcedureReuseOutcome({
      procedureId: procedure.id,
      status,
      failureReason: verdict.applicable ? null : verdict.reason,
    });
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.agentId ?? actor.userId ?? "board",
      agentId: actor.agentId,
      runId: actor.runId,
      action: status === "refused"
        ? "recovery_engineer.procedure_reuse_refused"
        : "recovery_engineer.procedure_reuse_recorded",
      entityType: "recovery_engineer_procedure",
      entityId: procedure.id,
      details: {
        incidentId: incident.id,
        reuseId: reuse.id,
        sourceIssueId: contextSource.sourceIssueId,
        sourceGenerationKey: generationKey,
        evidenceKey: input.evidenceKey,
        status,
        reason: verdict.reason,
        requiresNewEvidence: verdict.requiresNewEvidence,
        failedReuseCount: procedureAfter?.failedReuseCount ?? procedure.failedReuseCount,
      },
    });
    return { recorded: status === "applied", verdict, reuse };
  }

  async function handleParticipantRun(
    incident: IncidentRow,
    config: ConfigRow,
    run: RunRow,
    role: ParticipantRole | null,
  ) {
    if (run.status === "succeeded") {
      if (
        role === "recovery" &&
        run.id === incident.diagnosisRunId &&
        !incident.classification
      ) {
        await escalateToBoard(incident.id, "diagnosis_run_succeeded_without_diagnosis", run.id);
        return;
      }
      if (
        role === "recovery" &&
        run.id === incident.diagnosisRunId &&
        incident.classification &&
        ["infrastructure", "task_defect"].includes(incident.classification) &&
        !incident.repairIssueId
      ) {
        await escalateToBoard(incident.id, "diagnosis_run_succeeded_without_repair_request", run.id);
        return;
      }
      if (role === "repair" && runIssueId(run) === incident.repairIssueId) {
        await db
          .update(recoveryEngineerIncidents)
          .set({ status: "verifying", repairRunId: run.id, updatedAt: new Date() })
          .where(and(
            eq(recoveryEngineerIncidents.id, incident.id),
            isNull(recoveryEngineerIncidents.verifiedAt),
          ));
      }
      if (role === "reviewer") {
        const finalized = await finalizeVerificationForRun(run);
        if (!finalized) {
          const submitted = await db
            .select({ id: recoveryEngineerVerifications.id })
            .from(recoveryEngineerVerifications)
            .where(and(
              eq(recoveryEngineerVerifications.incidentId, incident.id),
              eq(recoveryEngineerVerifications.reviewRunId, run.id),
            ))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!submitted) {
            await escalateToBoard(incident.id, "review_run_succeeded_without_verification", run.id);
          }
        }
      }
      return;
    }
    if (!PARTICIPANT_FAILURE_STATUSES.includes(run.status as never)) return;
    await finalizeVerificationForRun(run);
    const failureRole = role ?? "participant";
    await escalateToBoard(incident.id, `${failureRole}_run_${run.status}`, run.id);
  }

  async function observeRunTerminal(runOrId: RunRow | string) {
    const run = typeof runOrId === "string"
      ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runOrId)).then((rows) => rows[0] ?? null)
      : runOrId;
    if (!run) return { observed: false };
    if (run.status === "succeeded") {
      const issueId = runIssueId(run);
      if (issueId) {
        const linked = await resolveIncidentForIssue(issueId);
        const config = linked ? await getConfigRow(linked.incident.companyId) : null;
        const role = config ? participantRole(config, run.agentId) : null;
        const participantScoped = linked?.participantScoped ?? false;
        if (linked && config && participantScoped) {
          await handleParticipantRun(linked.incident, config, run, role);
        } else if (linked) {
          // A successful run is only evidence, never recovery by itself: the
          // resolution checks that this exact run is the newest one on the
          // source issue, newer than the captured failure, and that it actually
          // advanced the original path. Anything else leaves the generation
          // open (or supersedes it with a named reason).
          const transition = await resolveSourceOutcome({
            incident: linked.incident,
            issue: linked.issue,
            evidenceRun: run,
          });
          if (transition && transition.kind !== "pending") {
            await rollUpIncidentOutcome(linked.incident.id);
          }
        }
      }
      await finalizeVerificationForRun(run);
      return { observed: true };
    }
    if (PARTICIPANT_FAILURE_STATUSES.includes(run.status as never)) {
      return observeFailedRun(run);
    }
    return { observed: false };
  }

  async function finalizePendingVerifications(companyId?: string) {
    const pending = await db
      .select({ verification: recoveryEngineerVerifications, run: heartbeatRuns })
      .from(recoveryEngineerVerifications)
      .innerJoin(heartbeatRuns, eq(recoveryEngineerVerifications.reviewRunId, heartbeatRuns.id))
      .where(and(
        eq(recoveryEngineerVerifications.status, "pending"),
        companyId ? eq(recoveryEngineerVerifications.companyId, companyId) : undefined,
        inArray(heartbeatRuns.status, ["succeeded", ...PARTICIPANT_FAILURE_STATUSES]),
      ))
      .orderBy(asc(recoveryEngineerVerifications.submittedAt))
      .limit(SWEEP_BATCH_SIZE);
    let finalized = 0;
    for (const candidate of pending) {
      if (await finalizeVerificationForRun(candidate.run)) finalized += 1;
    }
    return finalized;
  }

  /**
   * Closes the loop for open source generations: evaluates each pending one
   * against its current issue/run state and records recovery, supersession, or
   * a pending real wait. Nothing in this pass dispatches work.
   */
  async function reconcileSourceOutcomes(config: ConfigRow) {
    const rows = await db
      .select({
        source: recoveryEngineerIncidentSources,
        incident: recoveryEngineerIncidents,
        issue: issues,
      })
      .from(recoveryEngineerIncidentSources)
      .innerJoin(
        recoveryEngineerIncidents,
        eq(recoveryEngineerIncidents.id, recoveryEngineerIncidentSources.incidentId),
      )
      .innerJoin(issues, eq(issues.id, recoveryEngineerIncidentSources.sourceIssueId))
      .where(and(
        eq(recoveryEngineerIncidentSources.companyId, config.companyId),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
        inArray(recoveryEngineerIncidents.status, RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES),
      ))
      .orderBy(asc(recoveryEngineerIncidentSources.observedAt), asc(recoveryEngineerIncidentSources.id))
      .limit(SWEEP_BATCH_SIZE);
    let recovered = 0;
    let superseded = 0;
    let pending = 0;
    for (const row of rows) {
      const transition = await resolveSourceOutcome({
        incident: row.incident,
        issue: row.issue,
      });
      if (!transition) continue;
      if (transition.kind === "pending") {
        pending += 1;
        continue;
      }
      if (transition.kind === "recovered") recovered += 1;
      else superseded += 1;
      await rollUpIncidentOutcome(row.incident.id);
    }
    return { recovered, superseded, pending, evaluated: rows.length };
  }

  /**
   * Replays claimed-but-undispatched resumes. The persisted claim key is the
   * whole recovery mechanism: a restart before dispatch re-enqueues the same
   * key, a restart after dispatch adopts the wake that already exists, and the
   * attempt cap hands the generation to the board instead of looping forever.
   */
  async function reconcileSourceDispatches(config: ConfigRow) {
    const rows = await db
      .select({ source: recoveryEngineerIncidentSources, incident: recoveryEngineerIncidents })
      .from(recoveryEngineerIncidentSources)
      .innerJoin(
        recoveryEngineerIncidents,
        eq(recoveryEngineerIncidents.id, recoveryEngineerIncidentSources.incidentId),
      )
      .where(and(
        eq(recoveryEngineerIncidentSources.companyId, config.companyId),
        isNull(recoveryEngineerIncidentSources.recoveredAt),
        isNull(recoveryEngineerIncidentSources.supersededAt),
        isNotNull(recoveryEngineerIncidentSources.resumeClaimedAt),
        // Replay covers a claim with no dispatch record and a dispatch whose
        // run never materialized (for example a durable deferred wake). Both
        // converge on the persisted key: the wake that exists is adopted, and
        // only a genuinely missing wake costs another bounded attempt.
        or(
          isNull(recoveryEngineerIncidentSources.resumedAt),
          isNull(recoveryEngineerIncidentSources.resumedRunId),
        ),
        inArray(recoveryEngineerIncidents.status, RECOVERY_ENGINEER_FENCED_INCIDENT_STATUSES),
      ))
      .orderBy(asc(recoveryEngineerIncidentSources.resumeClaimedAt), asc(recoveryEngineerIncidentSources.id))
      .limit(SWEEP_BATCH_SIZE);
    let replayed = 0;
    let adopted = 0;
    let exhausted = 0;
    for (const row of rows) {
      if (
        !row.incident.activatedAt ||
        !row.incident.verifiedVerificationId ||
        row.incident.activatedRepairCommit !== row.incident.repairCommit
      ) {
        // A claim without a verified, activated repair is inconsistent state:
        // never dispatch work from it.
        continue;
      }
      const issue = await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, row.source.sourceIssueId),
          eq(issues.companyId, config.companyId),
        ))
        .then((rows2) => rows2[0] ?? null);
      if (!issue) {
        await closeSourceGeneration({
          incident: row.incident,
          source: row.source,
          close: { kind: "superseded", reason: "source_issue_missing" },
        });
        await rollUpIncidentOutcome(row.incident.id);
        continue;
      }
      const dispatched = await dispatchResumeWake({
        incident: row.incident,
        config,
        source: row.source,
        issue,
        actor: null,
      });
      if (dispatched.reason === "adopted_existing_wake") adopted += 1;
      else if (dispatched.reason === "resume_attempts_exhausted") exhausted += 1;
      else if (dispatched.dispatched) replayed += 1;
    }
    return { replayed, adopted, exhausted, evaluated: rows.length };
  }

  /**
   * Re-opens a dispatch-failure escalation so the bounded re-arm can spend
   * another enqueue attempt on the same incident. Guarded on the exact
   * escalation reason: an escalation that records an outcome or authority
   * decision (a diagnosis that succeeded without its artifact, a human or
   * provider gate, an admission refusal) is never overwritten.
   */
  async function reopenDispatchFailureEscalation(incidentId: string, nextStatus: string) {
    const now = new Date();
    return db
      .update(recoveryEngineerIncidents)
      .set({
        status: nextStatus,
        boardEscalatedAt: null,
        boardEscalationReason: null,
        updatedAt: now,
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, incidentId),
        isNotNull(recoveryEngineerIncidents.boardEscalatedAt),
        inArray(recoveryEngineerIncidents.boardEscalationReason, [...REARMABLE_DISPATCH_ESCALATION_REASONS]),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Restores the maintenance issue to its pre-dispatch state when the only
   * thing that parked it was this flow's own dispatch-failure escalation.
   * Never touches a descriptor someone else wrote, and never touches an
   * issue whose next action a live path already owns.
   */
  async function restoreMaintenanceForDispatch(incident: IncidentRow, config: ConfigRow) {
    if (!incident.maintenanceIssueId) return;
    const maintenance = await issuesSvc.getById(incident.maintenanceIssueId);
    if (!maintenance || maintenance.status !== "blocked") return;
    if (maintenance.assigneeAgentId !== config.agentId || maintenance.assigneeUserId) return;
    if (maintenance.executionState) return;
    if (maintenance.checkoutRunId || maintenance.executionRunId || maintenance.executionLockedAt) return;
    const action = maintenance.unblockDescriptor?.action ?? null;
    if (!action || !action.startsWith(`${BOARD_ESCALATION_ACTION_PREFIX}${incident.id}`)) return;
    if (await hasLiveExecutionPath(maintenance, config.agentId)) return;
    // Leaving `blocked` clears this flow's own unblock descriptor.
    await issuesSvc.update(maintenance.id, { status: "todo" });
  }

  /**
   * Classifies the wake ledger for one incident dispatch intent. Charges
   * follow admitted dispatches and unrecognized failures; a recognized hold
   * (scheduling suppression, a paused or budget-held participant, an issue
   * tree pause, the agent's scheduling policy, a heartbeat daily cap) parks
   * the intent instead: no charge, no escalation, and re-derivation is
   * rate-bounded by an exponential backoff so a parked intent waits for its
   * condition to change instead of writing a row every sweep. A row whose run
   * is a parked scheduled-retry carrier is a durable wait, not an admission:
   * it neither charges the cap nor marks the dispatch executed. A row whose
   * run is a CANCELLED park carrier is a stale intent — the scheduler
   * cancelled the wait at promotion because a gate changed — never execution
   * evidence: it charges the bounded cap and the intent is re-derived under
   * the current gates. This flow's own dispatch-claim rows are bookkeeping of
   * the in-flight enqueue and are neither holds nor charges nor live wakes.
   */
  function classifyIncidentDispatchLedger(
    rows: Array<typeof agentWakeupRequests.$inferSelect>,
    runInfoById: Map<string, DispatchRunInfo>,
  ): IncidentDispatchLedger {
    let charges = 0;
    let newestHoldReason: string | null = null;
    let holdStreak = 0;
    let newestRowAt: Date | null = null;
    let liveRealWake: typeof agentWakeupRequests.$inferSelect | null = null;
    let freshClaim: typeof agentWakeupRequests.$inferSelect | null = null;
    let staleClaim: typeof agentWakeupRequests.$inferSelect | null = null;
    const now = Date.now();
    for (const row of rows) {
      if (row.reason === DISPATCH_CLAIM_REASON) {
        if (row.status === "claimed") {
          const claimedAt = row.claimedAt ?? row.requestedAt ?? row.createdAt;
          const stale = claimedAt === null ||
            now - claimedAt.getTime() >= DISPATCH_CLAIM_STALE_MS;
          if (stale) {
            staleClaim ??= row;
          } else {
            freshClaim ??= row;
          }
        }
        // Finalized claim rows (coalesced/failed/skipped) are bookkeeping of
        // an attempt whose real ledger row (or its absence) already owns the
        // classification.
        continue;
      }
      if (newestRowAt === null) {
        newestRowAt = row.requestedAt ?? row.createdAt;
      }
      if (!liveRealWake && (Boolean(row.runId) || LIVE_WAKE_REQUEST_STATUSES.includes(row.status as never))) {
        liveRealWake = row;
      }
      const isHold = row.status === "skipped" && row.reason !== null &&
        (DISPATCH_HOLD_SKIP_REASONS as readonly string[]).includes(row.reason);
      if (isHold) {
        if (newestHoldReason === null) newestHoldReason = row.reason;
        if (newestHoldReason === row.reason) holdStreak += 1;
        continue;
      }
      const runInfo = row.runId !== null
        ? runInfoById.get(row.runId) ?? null
        : null;
      if (runInfo?.status === "scheduled_retry") {
        // A parked scheduled-retry carrier owns the dispatch durably; it is
        // neither an admitted execution nor a charge.
        if (newestHoldReason === null) newestHoldReason = DISPATCH_PARK_CARRIER_HOLD;
        if (newestHoldReason === DISPATCH_PARK_CARRIER_HOLD) holdStreak += 1;
        continue;
      }
      // Everything else — a terminal run (including a gate-cancelled park
      // carrier, which never executed), an unrecognized skip, a failure — is
      // an attempt the bounded cap must see.
      charges += 1;
    }
    return { charges, newestHoldReason, holdStreak, newestRowAt, liveRealWake, freshClaim, staleClaim };
  }

  function dispatchRearmBackoffMs(holdStreak: number) {
    const doublings = Math.max(0, holdStreak - 1);
    const factor = 2 ** Math.min(doublings, 16);
    return Math.min(DISPATCH_REARM_BASE_BACKOFF_MS * factor, DISPATCH_REARM_MAX_BACKOFF_MS);
  }

  /**
   * Loads the wake ledger for one incident dispatch intent together with each
   * linked run's status and park-carrier marker, so classification can tell
   * an admitted dispatch from a parked or gate-cancelled carrier.
   */
  async function loadDispatchLedger(
    companyId: string,
    agentId: string,
    idempotencyKey: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<{
    rows: Array<typeof agentWakeupRequests.$inferSelect>;
    runInfoById: Map<string, DispatchRunInfo>;
  }> {
    const rows = await dbOrTx
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
      ))
      .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id));
    const runIds = rows.map((row) => row.runId).filter((value): value is string => value !== null);
    const runInfoById = new Map<string, DispatchRunInfo>();
    if (runIds.length > 0) {
      const runRows = await dbOrTx
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds));
      for (const runRow of runRows) {
        runInfoById.set(runRow.id, {
          status: runRow.status,
          parkCarrier: parseObject(runRow.contextSnapshot).suppressedWakePark != null,
        });
      }
    }
    return { rows, runInfoById };
  }

  /**
   * Binds a materialized dispatch run to its incident authority, conditionally
   * on the intent's exact lifecycle pre-state AND on the exact dispatch claim
   * this pass committed. Used as the dispatcher's pre-start binding hook: it
   * runs inside the run-creation transaction, so the incident's run authority
   * is durable before the dispatcher can claim the run (a fast participant
   * observes it on its first action, and a parked carrier stays bound through
   * promotion and restart). The claim check first: a lease another dispatcher
   * already replaced (expired, then converted and re-claimed) makes this
   * late enqueue stand down — it must never produce an executable run,
   * including for intents without an incident run column. A lost race — the
   * incident moved on, another run was already bound, or the claim was
   * replaced — throws, which rolls the enqueue back and refuses admission
   * instead of starting an unbound run.
   */
  function bindIncidentDispatchRun(input: {
    incidentId: string;
    claimId: string;
    bindingField: "diagnosisRunId" | "repairRunId" | null;
    /** The exact lifecycle state the binding is fenced to: a terminal or
     * manual outcome that committed after the dispatch decision is never
     * overridden by a late binding. */
    expectedStatus: string;
  }): RecoveryRunBinding {
    return async (run, tx) => {
      const current = await tx
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.id, input.claimId),
          eq(agentWakeupRequests.status, "claimed"),
        ))
        .limit(1);
      if (current.length === 0) {
        throw conflict(DISPATCH_CLAIM_REPLACED_MESSAGE, {
          incidentId: input.incidentId,
          claimId: input.claimId,
          runId: run.id,
        });
      }
      if (!input.bindingField) {
        // The instruction wake has no incident run column: the exact-current
        // claim IS its admission fence.
        return;
      }
      const runIdColumn = input.bindingField === "diagnosisRunId"
        ? recoveryEngineerIncidents.diagnosisRunId
        : recoveryEngineerIncidents.repairRunId;
      const bound = await tx
        .update(recoveryEngineerIncidents)
        .set(
          input.bindingField === "diagnosisRunId"
            ? { diagnosisRunId: run.id, updatedAt: new Date() }
            : { repairRunId: run.id, updatedAt: new Date() },
        )
        .where(and(
          eq(recoveryEngineerIncidents.id, input.incidentId),
          eq(recoveryEngineerIncidents.status, input.expectedStatus),
          or(isNull(runIdColumn), eq(runIdColumn, run.id)),
        ))
        .returning({ id: recoveryEngineerIncidents.id });
      if (bound.length === 0) {
        throw conflict(DISPATCH_BINDING_LOST_MESSAGE, {
          incidentId: input.incidentId,
          runId: run.id,
          bindingField: input.bindingField,
        });
      }
    };
  }

  function isDispatchBindingLostMessage(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(DISPATCH_BINDING_LOST_MESSAGE);
  }

  function isDispatchStandDownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes(DISPATCH_BINDING_LOST_MESSAGE) ||
      message.includes(DISPATCH_CLAIM_REPLACED_MESSAGE);
  }

  /**
   * The incident-row escalation for an exhausted dispatch intent, fenced to
   * the exact incident pre-state that was validated under the intent's lock.
   * Because the row update carries the validated status and escalation
   * reason in its WHERE clause, a terminal or manual outcome that commits
   * first — even between this transaction's read and its write — wins, and
   * the stale cap decision writes nothing. The maintenance descriptor and
   * activity record are applied by the caller after the transaction commits.
   */
  async function escalateIncidentDispatchExhausted(
    tx: DbTransaction,
    validated: IncidentRow,
    exhaustedReason: string,
  ): Promise<IncidentRow | null> {
    return tx
      .update(recoveryEngineerIncidents)
      .set({
        status: "escalated",
        boardEscalatedAt: new Date(),
        boardEscalationReason: exhaustedReason,
        updatedAt: new Date(),
      })
      .where(and(
        eq(recoveryEngineerIncidents.id, validated.id),
        isNull(recoveryEngineerIncidents.boardEscalatedAt),
        eq(recoveryEngineerIncidents.status, validated.status),
        validated.boardEscalationReason === null
          ? isNull(recoveryEngineerIncidents.boardEscalationReason)
          : eq(recoveryEngineerIncidents.boardEscalationReason, validated.boardEscalationReason),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  /**
   * One bounded, concurrency-safe dispatch pass for an incident dispatch
   * intent, shared by the original producers (claim, repair request,
   * activation) and the sweep's re-arm. The design never holds a pool
   * connection across the enqueue: a short advisory-locked decision
   * transaction validates the guard, the ledger, and the cap, then commits a
   * durable dispatch claim (a `claimed` wake-request row under the intent's
   * own idempotency key); the enqueue runs afterwards with no connection
   * held, so a supported pool size of 1 cannot deadlock. The claim is the
   * in-flight lease — a concurrent dispatcher that reads it fresh stands
   * down, and a lease expired by a crash becomes the failed-attempt row it
   * represents and is re-derived under the bounded cap. The materialized run
   * is bound to its incident authority inside the dispatcher's own
   * run-creation transaction (pre-start, including parked carriers), so
   * execution can never outpace the binding; the enqueue's coalesced,
   * deferred, and parked outcomes are adopted through the ledger instead of
   * minting duplicates.
   */
  async function rearmIncidentWake(input: {
    incidentId: string;
    companyId: string;
    agentId: string;
    idempotencyKey: string;
    exhaustedReason: string;
    /** The incident column the materialized run is durably bound to, when the
     * intent has one (the post-activation instruction wake has none — its
     * durable dispatch record is the wake ledger row itself). */
    bindingField: "diagnosisRunId" | "repairRunId" | null;
    /** Re-validates the intent guard on the freshly read incident row inside
     * the decision transaction (e.g. the dispatch is still unrecorded and the
     * lifecycle state still owns the intent). */
    guard: (incident: IncidentRow) => boolean;
    /** Records the intent's lifecycle claim (status and escalation markers —
     * never the run id) inside the decision transaction, on top of the exact
     * pre-state that was validated under the lock. */
    claim?: (tx: DbTransaction, validated: IncidentRow) => Promise<unknown>;
    enqueue: (bindRun: RecoveryRunBinding | null) => Promise<RunRow | null>;
    /** Post-commit activity logging for a materialized dispatch. */
    onDispatched?: (runId: string) => Promise<void>;
    /** Adopts a wake that already materialized a real (non-carrier) run.
     * Returns "completed" when the adopted wake's outcome was fully applied,
     * "adopted" when a live wake merely owns the dispatch. */
    onAdopted: (wake: typeof agentWakeupRequests.$inferSelect) => Promise<"completed" | "adopted">;
  }): Promise<{ outcome: "rearmed" | "completed" | "adopted" | "held" | "exhausted"; runId: string | null }> {
    const ledger = await loadDispatchLedger(input.companyId, input.agentId, input.idempotencyKey);
    const outer = classifyIncidentDispatchLedger(ledger.rows, ledger.runInfoById);

    // Another dispatcher's enqueue is provably in flight (its lease is
    // fresh): stand down without writing anything. If that enqueue fails or
    // crashes, its lease ages out and a later pass re-derives the intent.
    if (outer.freshClaim) {
      return { outcome: "held", runId: null };
    }

    if (outer.liveRealWake) {
      const liveWake = outer.liveRealWake;
      if (liveWake.runId) {
        const runInfo = ledger.runInfoById.get(liveWake.runId) ?? null;
        if (!runInfo || runInfo.status === null) {
          // A wake whose run vanished cannot be adopted nor safely
          // re-enqueued: hold it for the next sweep instead of minting a
          // duplicate.
          return { outcome: "held", runId: null };
        }
        if (runInfo.status === "scheduled_retry") {
          // A parked scheduled-retry carrier is a durable wait owned by the
          // scheduler: stand down and preserve it — never record the intent's
          // run from it, never charge it.
          return { outcome: "adopted", runId: null };
        }
        if (runInfo.status === "cancelled" && runInfo.parkCarrier) {
          // A gate-cancelled park carrier: the scheduler cancelled the wait
          // at promotion because a gate (issue, assignee, agent, company)
          // changed. It never executed, so it is not execution evidence —
          // fall through and re-derive the dispatch under the current gates
          // (charged against the bounded cap like any unrecognized refusal).
        } else {
          await input.onAdopted(liveWake);
          return { outcome: "completed", runId: liveWake.runId };
        }
      } else {
        await input.onAdopted(liveWake);
        return { outcome: "adopted", runId: null };
      }
    }

    // A recognized hold parks the intent without spending a charge. An
    // agent-not-invokable row cannot be fresh here: the caller's
    // invokability pre-flight just proved the participant runnable, so the
    // hold re-arms immediately. Every other hold re-derives only after a
    // bounded, exponentially growing backoff (a long drain or pause ages its
    // hold row past the backoff while the sweep is itself gated, so a lifted
    // condition re-arms within one pass), never writing a ledger row per
    // sweep. A parked scheduled-retry carrier waits for its own owner.
    if (outer.newestHoldReason !== null) {
      const probedCleared = outer.newestHoldReason === "agent.not_invokable" ||
        outer.newestHoldReason === DISPATCH_PARK_CARRIER_HOLD;
      const backoff = dispatchRearmBackoffMs(outer.holdStreak);
      const heldFresh = !probedCleared &&
        outer.newestRowAt !== null &&
        Date.now() - outer.newestRowAt.getTime() < backoff;
      if (heldFresh) {
        return { outcome: "held", runId: null };
      }
    }

    const decision = await db.transaction(async (tx): Promise<{
      action: "stand_down" | "exhausted" | "proceed";
      escalated: IncidentRow | null;
      claimId: string | null;
    }> => {
      // The advisory lock is the concurrency barrier shared by every
      // producer of this intent (the original claim/repair/activation path
      // and any re-arm): concurrent decision transactions serialize here,
      // and the loser re-validates against the committed state instead of
      // enqueueing a duplicate wake. The enqueue itself deliberately runs
      // AFTER this transaction commits — never while a connection is held —
      // so a supported pool size of 1 cannot deadlock; the committed claim
      // row below keeps the post-commit enqueue single-flight.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`recovery-engineer:dispatch:${input.idempotencyKey}`}, 0))`);
      let incidentNow = await tx
        .select()
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, input.incidentId))
        .then((rows) => rows[0] ?? null);
      if (!incidentNow) {
        return { action: "stand_down", escalated: null, claimId: null };
      }
      const ledgerInside = await loadDispatchLedger(
        input.companyId,
        input.agentId,
        input.idempotencyKey,
        tx,
      );
      const inside = classifyIncidentDispatchLedger(ledgerInside.rows, ledgerInside.runInfoById);
      // The one live wake a re-derivation may proceed past: a gate-cancelled
      // park carrier — the scheduler cancelled the wait at promotion, so the
      // intent is stale and must be re-derived, not adopted as execution.
      const insideStaleCarrierRunId = ledgerInside.rows.find((row) =>
        row.runId !== null &&
        row.reason !== DISPATCH_CLAIM_REASON &&
        (ledgerInside.runInfoById.get(row.runId)?.status === "cancelled") &&
        (ledgerInside.runInfoById.get(row.runId)?.parkCarrier ?? false),
      )?.runId ?? null;
      if (inside.freshClaim) {
        // A concurrent dispatcher holds the in-flight lease: stand down and
        // let the next sweep adopt its outcome.
        return { action: "stand_down", escalated: null, claimId: null };
      }
      if (inside.liveRealWake && inside.liveRealWake.runId !== insideStaleCarrierRunId) {
        // A concurrent dispatcher's enqueue landed between the outer read and
        // the lock: stand down and let the next sweep adopt its outcome.
        return { action: "stand_down", escalated: null, claimId: null };
      }
      if (inside.staleClaim) {
        // The previous dispatch lease expired without the enqueue landing (a
        // crash between claim and enqueue): convert the expired lease into
        // the failed-attempt row it represents so the cap stays exact, then
        // re-derive under that cap.
        await tx
          .update(agentWakeupRequests)
          .set({
            status: "failed",
            reason: DISPATCH_ENQUEUE_FAILED_REASON,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(agentWakeupRequests.id, inside.staleClaim.id),
            eq(agentWakeupRequests.status, "claimed"),
          ));
      }
      if (input.bindingField) {
        // A gate-cancelled park carrier left the intent's run authority bound
        // to a run that never executed: clear exactly that stale binding
        // (fenced on the carrier's own run id) before the guard re-validates.
        if (insideStaleCarrierRunId) {
          const cleared = await tx
            .update(recoveryEngineerIncidents)
            .set(
              input.bindingField === "diagnosisRunId"
                ? { diagnosisRunId: null, updatedAt: new Date() }
                : { repairRunId: null, updatedAt: new Date() },
            )
            .where(and(
              eq(recoveryEngineerIncidents.id, input.incidentId),
              input.bindingField === "diagnosisRunId"
                ? eq(recoveryEngineerIncidents.diagnosisRunId, insideStaleCarrierRunId)
                : eq(recoveryEngineerIncidents.repairRunId, insideStaleCarrierRunId),
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (cleared) incidentNow = cleared;
        }
      }
      if (!incidentNow || !input.guard(incidentNow)) {
        return { action: "stand_down", escalated: null, claimId: null };
      }
      const charges = inside.charges + (inside.staleClaim ? 1 : 0);
      if (charges >= INCIDENT_DISPATCH_MAX_ATTEMPTS) {
        // The cap decision and its escalation commit under the intent lock,
        // fenced to the exact validated incident state, so a terminal or
        // manual outcome that committed first always wins.
        const escalated = await escalateIncidentDispatchExhausted(tx, incidentNow, input.exhaustedReason);
        return { action: escalated ? "exhausted" : "stand_down", escalated, claimId: null };
      }
      if (inside.newestHoldReason !== null) {
        const probedCleared = inside.newestHoldReason === "agent.not_invokable" ||
          inside.newestHoldReason === DISPATCH_PARK_CARRIER_HOLD;
        const backoff = dispatchRearmBackoffMs(inside.holdStreak);
        const heldFresh = !probedCleared &&
          inside.newestRowAt !== null &&
          Date.now() - inside.newestRowAt.getTime() < backoff;
        if (heldFresh) {
          return { action: "stand_down", escalated: null, claimId: null };
        }
      }
      const claimRow = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: DISPATCH_CLAIM_REASON,
          payload: null,
          status: "claimed",
          requestedByActorType: "system",
          requestedByActorId: "recovery_engineer",
          idempotencyKey: input.idempotencyKey,
          claimedAt: new Date(),
        })
        .returning({ id: agentWakeupRequests.id })
        .then((rows) => rows[0]!);
      if (input.claim) await input.claim(tx, incidentNow);
      return { action: "proceed", escalated: null, claimId: claimRow.id };
    });

    if (decision.action === "exhausted") {
      if (decision.escalated) {
        await applyBoardEscalationFollowUps(decision.escalated, input.exhaustedReason, null);
      }
      return { outcome: "exhausted", runId: null };
    }
    if (decision.action === "stand_down") {
      return { outcome: "held", runId: null };
    }

    // The enqueue runs with NO connection held by this flow: the decision
    // transaction has committed, so the dispatcher's own transactions (and
    // the pool it needs) are always available — a supported pool size of 1
    // completes instead of deadlocking. The pre-start hook carries the exact
    // claim row this pass committed, for every intent: it fences the enqueue
    // on that still-current lease (a lease another dispatcher replaced after
    // expiry refuses the late enqueue) and, for intents with an incident run
    // column, binds the run atomically in the same transaction.
    const claimId = decision.claimId;
    if (!claimId) {
      return { outcome: "held", runId: null };
    }
    const binding = bindIncidentDispatchRun({
      incidentId: input.incidentId,
      claimId,
      bindingField: input.bindingField,
      expectedStatus: input.bindingField
        ? bindingExpectedStatus(input.bindingField)
        : "verified",
    });
    let run: RunRow | null = null;
    try {
      run = await input.enqueue(binding);
    } catch (error) {
      if (isDispatchStandDownError(error)) {
        // The incident moved on (a terminal or manual outcome won), or this
        // pass's lease was replaced while the enqueue was in flight: the
        // enqueue rolled back and the dispatch stands down without a charge.
        // Finalization is fenced to THIS pass's own claim id, so it can never
        // touch a replacement lease.
        await finalizeDispatchClaim(claimId, {
          status: "coalesced",
          error: isDispatchBindingLostMessage(error)
            ? DISPATCH_BINDING_LOST_MESSAGE
            : DISPATCH_CLAIM_REPLACED_MESSAGE,
        });
        return { outcome: "held", runId: null };
      }
      // A refusal that wrote its own ledger row (a recognized hold or an
      // unrecognized skip) is classified from that row. A refusal that wrote
      // nothing converts this pass's dispatch claim into the durable
      // failed-attempt row the cap counts.
      const rowsNow = await db
        .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        ));
      const realRows = rowsNow.filter((row) => row.reason !== DISPATCH_CLAIM_REASON);
      const ledgerRows = ledger.rows.filter((row) => row.reason !== DISPATCH_CLAIM_REASON);
      await finalizeDispatchClaim(claimId, realRows.length > ledgerRows.length
        ? { status: "coalesced", error: "enqueue refused after recording its own ledger row" }
        : { status: "failed", reason: DISPATCH_ENQUEUE_FAILED_REASON, error: null, finishedAt: new Date() });
      return { outcome: "held", runId: null };
    }

    await finalizeDispatchClaim(claimId, {
      status: "coalesced",
      runId: run?.id ?? null,
      finishedAt: new Date(),
    });
    if (run) {
      if (input.bindingField) {
        // A coalesced or merged wake returns an existing run that predates
        // this pass, so its pre-start binding never ran: adopt it now, the
        // same way the ledger adoption path records a converged wake. A
        // freshly created run is already bound inside the enqueue
        // transaction; this conditional record is a no-op for it.
        await db
          .update(recoveryEngineerIncidents)
          .set(
            input.bindingField === "diagnosisRunId"
              ? { diagnosisRunId: run.id, updatedAt: new Date() }
              : { repairRunId: run.id, updatedAt: new Date() },
          )
          .where(and(
            eq(recoveryEngineerIncidents.id, input.incidentId),
            isNull(
              input.bindingField === "diagnosisRunId"
                ? recoveryEngineerIncidents.diagnosisRunId
                : recoveryEngineerIncidents.repairRunId,
            ),
          ));
      }
      if (input.onDispatched) await input.onDispatched(run.id);
      return { outcome: "rearmed", runId: run.id };
    }
    // The dispatcher refused without a run (its own ledger row — a hold or an
    // unrecognized skip — owns the classification). The intent waits for the
    // next bounded re-arm.
    return { outcome: "held", runId: null };
  }

  /** The lifecycle state a binding fences on, derived from the intent's
   * binding field (the claim this pass just recorded set that state). */
  function bindingExpectedStatus(bindingField: "diagnosisRunId" | "repairRunId"): string {
    return bindingField === "diagnosisRunId" ? "diagnosing" : "repairing";
  }

  /** Finalizes THIS pass's exact dispatch claim row by id, and only while it
   * is still the claimed lease: a late producer whose lease was replaced can
   * never finalize (or resurrect) a replacement dispatcher's claim. */
  async function finalizeDispatchClaim(
    claimId: string,
    patch: {
      status: "coalesced" | "failed";
      reason?: string;
      runId?: string | null;
      error?: string | null;
      finishedAt?: Date | null;
    },
  ) {
    await db
      .update(agentWakeupRequests)
      .set({
        status: patch.status,
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(agentWakeupRequests.id, claimId),
        eq(agentWakeupRequests.reason, DISPATCH_CLAIM_REASON),
        eq(agentWakeupRequests.status, "claimed"),
      ));
  }

  function diagnoseWakeInput(
    incident: IncidentRow,
    maintenanceIssue: IssueRow,
    generation: IncidentSourceGeneration | null,
  ) {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "recovery_engineer_diagnose",
      idempotencyKey: `${DIAGNOSE_DISPATCH_KEY_PREFIX}${incident.id}`,
      payload: {
        issueId: maintenanceIssue.id,
        incidentId: incident.id,
        action: "diagnose",
        ...sourceGenerationIntentFields(generation),
      },
      contextSnapshot: {
        issueId: maintenanceIssue.id,
        taskId: maintenanceIssue.id,
        incidentId: incident.id,
        wakeReason: "recovery_engineer_diagnose",
        source: "recovery_engineer.incident_detected",
        recoveryRole: "diagnosis",
      },
      requestedByActorType: "system" as const,
      requestedByActorId: "recovery_engineer",
    };
  }

  /**
   * Re-arms the incident's own dispatch intents (diagnose wake, repair wake,
   * post-activation resume wake) whose wake never materialized a run — a
   * scheduling suppression or drain, an unavailable participant, or a crash
   * between the durable claim and the enqueue. The same incident is re-armed
   * in place under the same idempotency key: no second incident, no second
   * maintenance issue, no duplicate wake. An unavailable participant holds
   * the re-arm without spending an attempt; past the bounded attempt cap the
   * board owns the next action.
   */
  async function reconcileIncidentDispatches(config: ConfigRow): Promise<IncidentDispatchReconciliation> {
    const rows = await db
      .select()
      .from(recoveryEngineerIncidents)
      .where(and(
        eq(recoveryEngineerIncidents.companyId, config.companyId),
        inArray(recoveryEngineerIncidents.status, [
          "suspected",
          "diagnosing",
          "repairing",
          "verified",
          "escalated",
        ]),
        or(
          // Interrupted activation: the maintenance issue may or may not have
          // been linked before the crash (the claim never happened). The
          // dispatch seam's advisory lock keeps a mid-activation observation
          // path and this sweep from both enqueuing the same intent.
          and(
            eq(recoveryEngineerIncidents.diagnosisAttemptCount, 0),
            eq(recoveryEngineerIncidents.status, "suspected"),
          ),
          // Claimed diagnosis whose dispatch never produced a run.
          and(
            eq(recoveryEngineerIncidents.diagnosisAttemptCount, 1),
            isNull(recoveryEngineerIncidents.diagnosisRunId),
          ),
          // Claimed diagnosis whose bound run was a park carrier that the
          // scheduler gate-cancelled at promotion: the never-executed wait is
          // a stale intent to re-derive, never execution evidence.
          and(
            eq(recoveryEngineerIncidents.diagnosisAttemptCount, 1),
            isNotNull(recoveryEngineerIncidents.diagnosisRunId),
            eq(recoveryEngineerIncidents.status, "diagnosing"),
            sql`exists (
              select 1 from agent_wakeup_requests w
              join heartbeat_runs r on r.id = w.run_id
              where w.company_id = ${config.companyId}
                and w.agent_id = ${config.agentId}
                and w.idempotency_key = ${DIAGNOSE_DISPATCH_KEY_PREFIX} || recovery_engineer_incidents.id::text
                and w.run_id = recovery_engineer_incidents.diagnosis_run_id
                and r.status = 'cancelled'
                and r.context_snapshot -> 'suppressedWakePark' is not null
            )`,
          ),
          // Requested repair whose wake never produced a run.
          and(
            isNotNull(recoveryEngineerIncidents.repairIssueId),
            isNull(recoveryEngineerIncidents.repairRunId),
            isNotNull(recoveryEngineerIncidents.repairTarget),
          ),
          // Requested repair whose bound run was a gate-cancelled park
          // carrier: the same stale-intent rule as the diagnosis intent.
          and(
            isNotNull(recoveryEngineerIncidents.repairIssueId),
            isNotNull(recoveryEngineerIncidents.repairRunId),
            isNotNull(recoveryEngineerIncidents.repairTarget),
            eq(recoveryEngineerIncidents.status, "repairing"),
            sql`exists (
              select 1 from agent_wakeup_requests w
              join heartbeat_runs r on r.id = w.run_id
              where w.company_id = ${config.companyId}
                and w.agent_id = ${config.repairAgentId}
                and w.idempotency_key = ${REPAIR_WAKE_KEY_PREFIX} || recovery_engineer_incidents.id::text || ':' || recovery_engineer_incidents.repair_target::text
                and w.run_id = recovery_engineer_incidents.repair_run_id
                and r.status = 'cancelled'
                and r.context_snapshot -> 'suppressedWakePark' is not null
            )`,
          ),
          // Confirmed activation whose resume instruction never produced a
          // run (a source resume dispatch is replayed by
          // reconcileSourceDispatches; this covers the instruction wake).
          and(
            isNotNull(recoveryEngineerIncidents.activatedAt),
            isNotNull(recoveryEngineerIncidents.activatedRepairCommit),
            isNull(recoveryEngineerIncidents.resumedRunId),
          ),
        ),
      ))
      .orderBy(asc(recoveryEngineerIncidents.createdAt), asc(recoveryEngineerIncidents.id))
      .limit(SWEEP_BATCH_SIZE);

    const result: IncidentDispatchReconciliation = {
      evaluated: rows.length,
      rearmed: 0,
      adopted: 0,
      completed: 0,
      held: 0,
      exhausted: 0,
    };

    const agentInvokable = async (agentId: string) => {
      const agent = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, config.companyId)))
        .then((rows2) => rows2[0] ?? null);
      if (!agent) return false;
      return (await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
    };

    for (const candidate of rows) {
      const incident = await db
        .select()
        .from(recoveryEngineerIncidents)
        .where(eq(recoveryEngineerIncidents.id, candidate.id))
        .then((rows2) => rows2[0] ?? null);
      if (!incident) continue;

      const escalationRearmable = incident.status !== "escalated" || (
        incident.boardEscalationReason !== null &&
        (REARMABLE_DISPATCH_ESCALATION_REASONS as readonly string[]).includes(incident.boardEscalationReason)
      );
      if (!escalationRearmable) continue;

      // ---- diagnosis dispatch intent ----
      if (
        (incident.diagnosisAttemptCount === 0 && incident.status === "suspected") ||
        (incident.diagnosisAttemptCount === 1 && (
          (!incident.diagnosisRunId && (
            incident.status === "diagnosing" ||
            (incident.status === "escalated" &&
              incident.boardEscalationReason !== null &&
              (DIAGNOSIS_DISPATCH_ESCALATION_REASONS as readonly string[]).includes(incident.boardEscalationReason)))
          ) ||
          // The bound run is a gate-cancelled park carrier: the seam clears
          // the stale binding and re-derives the dispatch under the cap.
          (incident.diagnosisRunId && incident.status === "diagnosing"))
        )
      ) {
        let maintenance = incident.maintenanceIssueId
          ? await issuesSvc.getById(incident.maintenanceIssueId)
          : null;
        if (!maintenance) {
          // The maintenance issue was never linked or disappeared: heal the
          // linkage from the incident's own sources under the same
          // idempotency key instead of minting a second incident. With no
          // source generation left to describe, the board owns the incident.
          const sourceIssue = await newestIncidentSourceIssue(incident);
          if (!sourceIssue) {
            await escalateToBoard(incident.id, "diagnosis_maintenance_issue_missing");
            result.exhausted += 1;
            continue;
          }
          maintenance = await ensureMaintenanceIssue(
            incident,
            config,
            sourceIssue,
            incident.evidence.slice(0, 20).join("\n"),
          );
        }
        if (["done", "cancelled"].includes(maintenance.status)) continue;
        if (maintenance.assigneeAgentId !== config.agentId || maintenance.assigneeUserId) continue;
        if (incident.diagnosisAttemptCount === 0) {
          // Complete the interrupted activation exactly as the observation
          // path would have: claim, then enqueue under the dispatch key.
          const claimed = await claimDiagnosis(incident, config, maintenance);
          if (claimed) result.rearmed += 1;
          else result.held += 1;
          continue;
        }
        if (!(await agentInvokable(config.agentId))) {
          result.held += 1;
          continue;
        }
        const generation = await newestOpenSourceGeneration(incident.id);
        const outcome = await rearmIncidentWake({
          incidentId: incident.id,
          companyId: config.companyId,
          agentId: config.agentId,
          idempotencyKey: `${DIAGNOSE_DISPATCH_KEY_PREFIX}${incident.id}`,
          exhaustedReason: DIAGNOSIS_DISPATCH_EXHAUSTED_REASON,
          bindingField: "diagnosisRunId",
          guard: (current) =>
            !current.diagnosisRunId &&
            (current.status === "diagnosing" || (
              current.status === "escalated" &&
              current.boardEscalationReason !== null &&
              (DIAGNOSIS_DISPATCH_ESCALATION_REASONS as readonly string[]).includes(current.boardEscalationReason))),
          claim: (tx, validated) => tx
            .update(recoveryEngineerIncidents)
            .set({
              status: "diagnosing",
              boardEscalatedAt: null,
              boardEscalationReason: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(recoveryEngineerIncidents.id, incident.id),
              isNull(recoveryEngineerIncidents.diagnosisRunId),
              validated.status === "escalated" && validated.boardEscalationReason !== null
                ? eq(recoveryEngineerIncidents.boardEscalationReason, validated.boardEscalationReason)
                : undefined,
            ))
            .returning()
            .then((rows2) => rows2[0] ?? null),
          // The run id is bound inside the dispatcher's own run-creation
          // transaction (pre-start), never recorded after the enqueue.
          enqueue: (bindRun) => deps.enqueueWakeup(config.agentId, {
            ...diagnoseWakeInput(incident, maintenance!, generation),
            bindRun,
          }),
          onAdopted: async (wake) => {
            await reopenDispatchFailureEscalation(incident.id, "diagnosing");
            if (!wake.runId) return "adopted";
            const claimed = await db
              .update(recoveryEngineerIncidents)
              .set({ diagnosisRunId: wake.runId, updatedAt: new Date() })
              .where(and(
                eq(recoveryEngineerIncidents.id, incident.id),
                isNull(recoveryEngineerIncidents.diagnosisRunId),
              ))
              .returning()
              .then((rows2) => rows2[0] ?? null);
            const current = claimed ?? await db
              .select()
              .from(recoveryEngineerIncidents)
              .where(eq(recoveryEngineerIncidents.id, incident.id))
              .then((rows2) => rows2[0] ?? null);
            if (!current) return "adopted";
            const run = await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, wake.runId))
              .then((rows2) => rows2[0] ?? null);
            if (
              run &&
              (run.status === "succeeded" ||
                PARTICIPANT_FAILURE_STATUSES.includes(run.status as never))
            ) {
              // The adopted wake's run already terminalized while the claim
              // was unreconciled: run the exact participant-outcome handling
              // (a bounded board escalation with the precise reason) instead
              // of leaving an unowned success or a generic failure.
              await handleParticipantRun(current, config, run, "recovery");
            }
            return "completed";
          },
          onDispatched: async (runId) => {
            await restoreMaintenanceForDispatch(incident, config);
            await logActivity(db, {
              companyId: config.companyId,
              actorType: "system",
              actorId: "recovery_engineer",
              agentId: null,
              runId,
              action: "recovery_engineer.diagnosis_dispatch_rearmed",
              entityType: "recovery_engineer_incident",
              entityId: incident.id,
              details: {
                maintenanceIssueId: maintenance!.id,
                diagnosisAttempt: incident.diagnosisAttemptCount,
                resumedClaim: true,
              },
            });
          },
        });
        if (outcome.outcome === "rearmed" || outcome.outcome === "completed") result.rearmed += 1;
        else if (outcome.outcome === "adopted") result.adopted += 1;
        else if (outcome.outcome === "exhausted") result.exhausted += 1;
        else result.held += 1;
        continue;
      }

      // ---- repair dispatch intent ----
      if (incident.repairIssueId && incident.repairTarget && (
        (!incident.repairRunId && (
          incident.status === "repairing" ||
          (incident.status === "escalated" &&
            incident.boardEscalationReason !== null &&
            (REPAIR_DISPATCH_ESCALATION_REASONS as readonly string[]).includes(incident.boardEscalationReason))
        )) ||
        // The bound run is a gate-cancelled park carrier: the seam clears
        // the stale binding and re-derives the dispatch under the cap.
        (incident.repairRunId && incident.status === "repairing")
      )) {
        const repairIssue = await issuesSvc.getById(incident.repairIssueId);
        if (
          !repairIssue ||
          ["done", "cancelled"].includes(repairIssue.status) ||
          repairIssue.assigneeAgentId !== config.repairAgentId ||
          repairIssue.assigneeUserId
        ) {
          result.held += 1;
          continue;
        }
        if (!(await agentInvokable(config.repairAgentId))) {
          result.held += 1;
          continue;
        }
        const outcome = await rearmIncidentWake({
          incidentId: incident.id,
          companyId: config.companyId,
          agentId: config.repairAgentId,
          idempotencyKey: `${REPAIR_WAKE_KEY_PREFIX}${incident.id}:${incident.repairTarget}`,
          exhaustedReason: REPAIR_DISPATCH_EXHAUSTED_REASON,
          bindingField: "repairRunId",
          guard: (current) =>
            !current.repairRunId &&
            (current.status === "repairing" || (
              current.status === "escalated" &&
              current.boardEscalationReason !== null &&
              (REPAIR_DISPATCH_ESCALATION_REASONS as readonly string[]).includes(current.boardEscalationReason))),
          claim: (tx, validated) => tx
            .update(recoveryEngineerIncidents)
            .set({
              status: "repairing",
              boardEscalatedAt: null,
              boardEscalationReason: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(recoveryEngineerIncidents.id, incident.id),
              isNull(recoveryEngineerIncidents.repairRunId),
              validated.status === "escalated" && validated.boardEscalationReason !== null
                ? eq(recoveryEngineerIncidents.boardEscalationReason, validated.boardEscalationReason)
                : undefined,
            ))
            .returning()
            .then((rows2) => rows2[0] ?? null),
          // The run id is bound inside the dispatcher's own run-creation
          // transaction (pre-start), never recorded after the enqueue.
          enqueue: (bindRun) => deps.enqueueWakeup(config.repairAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: "recovery_engineer_repair",
            idempotencyKey: `${REPAIR_WAKE_KEY_PREFIX}${incident.id}:${incident.repairTarget}`,
            payload: {
              issueId: repairIssue.id,
              incidentId: incident.id,
              target: incident.repairTarget!,
            },
            contextSnapshot: {
              issueId: repairIssue.id,
              taskId: repairIssue.id,
              incidentId: incident.id,
              wakeReason: "recovery_engineer_repair",
              source: "recovery_engineer.repair_requested",
              recoveryRole: "repair",
            },
            requestedByActorType: "system",
            requestedByActorId: "recovery_engineer",
            bindRun,
          }),
          onAdopted: async (wake) => {
            await reopenDispatchFailureEscalation(incident.id, "repairing");
            if (!wake.runId) return "adopted";
            const claimed = await db
              .update(recoveryEngineerIncidents)
              .set({ repairRunId: wake.runId, updatedAt: new Date() })
              .where(and(
                eq(recoveryEngineerIncidents.id, incident.id),
                isNull(recoveryEngineerIncidents.repairRunId),
              ))
              .returning()
              .then((rows2) => rows2[0] ?? null);
            const current = claimed ?? incident;
            const run = await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, wake.runId))
              .then((rows2) => rows2[0] ?? null);
            if (
              run &&
              (run.status === "succeeded" ||
                PARTICIPANT_FAILURE_STATUSES.includes(run.status as never))
            ) {
              await handleParticipantRun(current, config, run, "repair");
            }
            return "completed";
          },
          onDispatched: async (runId) => {
            await logActivity(db, {
              companyId: config.companyId,
              actorType: "system",
              actorId: "recovery_engineer",
              agentId: null,
              runId,
              action: "recovery_engineer.repair_dispatch_rearmed",
              entityType: "recovery_engineer_incident",
              entityId: incident.id,
              details: {
                repairIssueId: repairIssue.id,
                repairTarget: incident.repairTarget,
              },
            });
          },
        });
        if (outcome.outcome === "rearmed" || outcome.outcome === "completed") result.rearmed += 1;
        else if (outcome.outcome === "adopted") result.adopted += 1;
        else if (outcome.outcome === "exhausted") result.exhausted += 1;
        else result.held += 1;
        continue;
      }

      // ---- post-activation resume instruction intent ----
      if (
        incident.activatedAt &&
        incident.activatedRepairCommit &&
        incident.activatedRepairCommit === incident.repairCommit &&
        !incident.resumedRunId && (
          incident.status === "verified" || (
            incident.status === "escalated" &&
            incident.boardEscalationReason === "post_activation_resume_wake_not_enqueued")
        )
      ) {
        const maintenance = incident.maintenanceIssueId
          ? await issuesSvc.getById(incident.maintenanceIssueId)
          : null;
        if (!maintenance || ["done", "cancelled"].includes(maintenance.status)) {
          result.held += 1;
          continue;
        }
        if (!(await agentInvokable(config.agentId))) {
          result.held += 1;
          continue;
        }
        const outcome = await rearmIncidentWake({
          incidentId: incident.id,
          companyId: config.companyId,
          agentId: config.agentId,
          idempotencyKey: `${ACTIVATED_WAKE_KEY_PREFIX}${incident.id}:${incident.activatedRepairCommit}`,
          exhaustedReason: ACTIVATED_DISPATCH_EXHAUSTED_REASON,
          // The instruction wake has no dedicated incident run column: the
          // wake ledger row is its durable dispatch record.
          bindingField: null,
          // The verified activation state itself is re-armable: the primary
          // path leaves the incident `verified` with no resume run when the
          // instruction wake never materialized, so the guard accepts both
          // that state and the legacy not-enqueued escalation (with the same
          // activation/repair commit fence either way).
          guard: (current) =>
            !current.resumedRunId &&
            current.activatedRepairCommit !== null &&
            current.activatedRepairCommit === current.repairCommit && (
              current.status === "verified" || (
                current.status === "escalated" &&
                current.boardEscalationReason === "post_activation_resume_wake_not_enqueued")
            ),
          claim: (tx, validated) => tx
            .update(recoveryEngineerIncidents)
            .set({
              status: "verified",
              boardEscalatedAt: null,
              boardEscalationReason: null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(recoveryEngineerIncidents.id, incident.id),
              isNull(recoveryEngineerIncidents.resumedRunId),
              eq(recoveryEngineerIncidents.status, validated.status),
              validated.boardEscalationReason === null
                ? isNull(recoveryEngineerIncidents.boardEscalationReason)
                : eq(recoveryEngineerIncidents.boardEscalationReason, validated.boardEscalationReason),
            ))
            .returning()
            .then((rows2) => rows2[0] ?? null),
          enqueue: (bindRun) => deps.enqueueWakeup(config.agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "recovery_engineer_activated",
            idempotencyKey: `${ACTIVATED_WAKE_KEY_PREFIX}${incident.id}:${incident.activatedRepairCommit}`,
            payload: {
              issueId: maintenance.id,
              incidentId: incident.id,
              action: "resume",
              repairCommit: incident.activatedRepairCommit!,
            },
            contextSnapshot: {
              issueId: maintenance.id,
              taskId: maintenance.id,
              incidentId: incident.id,
              repairCommit: incident.activatedRepairCommit!,
              wakeReason: "recovery_engineer_activated",
              source: "recovery_engineer.repair_activated",
              recoveryRole: "resume",
            },
            requestedByActorType: "system",
            requestedByActorId: "recovery_engineer",
            // The instruction wake's run id has no dedicated incident field;
            // the durable dispatch record is the wake ledger row itself.
            bindRun,
          }),
          onAdopted: async (wake) => {
            await reopenDispatchFailureEscalation(incident.id, "verified");
            if (!wake.runId) return "adopted";
            const run = await db
              .select()
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, wake.runId))
              .then((rows2) => rows2[0] ?? null);
            if (
              run &&
              (run.status === "succeeded" ||
                PARTICIPANT_FAILURE_STATUSES.includes(run.status as never))
            ) {
              await handleParticipantRun(incident, config, run, "recovery");
            }
            return "completed";
          },
          // The instruction wake's run id has no dedicated incident field;
          // the durable dispatch record is the wake ledger row itself.
          onDispatched: async (runId) => {
            // Mirror wakeRecoveryAfterActivation: the activation is
            // confirmed, so the activation wait is no longer the next action.
            if (["blocked", "todo"].includes(maintenance.status)) {
              await issuesSvc.update(maintenance.id, { status: "in_progress" });
            }
            await logActivity(db, {
              companyId: config.companyId,
              actorType: "system",
              actorId: "recovery_engineer",
              agentId: null,
              runId,
              action: "recovery_engineer.post_activation_resume_rearmed",
              entityType: "recovery_engineer_incident",
              entityId: incident.id,
              details: {
                maintenanceIssueId: maintenance.id,
                repairCommit: incident.activatedRepairCommit,
              },
            });
          },
        });
        if (outcome.outcome === "rearmed" || outcome.outcome === "completed") result.rearmed += 1;
        else if (outcome.outcome === "adopted") result.adopted += 1;
        else if (outcome.outcome === "exhausted") result.exhausted += 1;
        else result.held += 1;
      }
    }
    return result;
  }

  /**
   * Retries the maintenance close for incidents that already reached
   * `recovered`. The close can legitimately be refused while the participant
   * run that observed the recovery still holds a live path on the maintenance
   * issue, so the sweep actualizes it later instead of leaving a recovered
   * incident with an open maintenance issue.
   */
  async function reconcileRecoveredIncidentClosures(config: ConfigRow) {
    const rows = await db
      .select({ incident: recoveryEngineerIncidents })
      .from(recoveryEngineerIncidents)
      .innerJoin(issues, eq(issues.id, recoveryEngineerIncidents.maintenanceIssueId))
      .where(and(
        eq(recoveryEngineerIncidents.companyId, config.companyId),
        eq(recoveryEngineerIncidents.outcome, "recovered"),
        notInArray(issues.status, ["done", "cancelled"]),
      ))
      .limit(SWEEP_BATCH_SIZE);
    let closed = 0;
    for (const row of rows) {
      if (await transitionMaintenanceWait({
        incident: row.incident,
        config,
        mode: "close",
        action: `All source generations of recovery incident ${row.incident.id} recovered with evidence.`,
      })) {
        closed += 1;
      }
    }
    return { closed };
  }

  async function reconcileCompany(config: ConfigRow, now: Date) {
    const lowerBound = config.lastSweepAt ?? new Date(now.getTime() - INITIAL_SWEEP_LOOKBACK_MS);
    const failedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, config.companyId),
        inArray(heartbeatRuns.status, TERMINAL_FAILURE_STATUSES),
        gt(heartbeatRuns.updatedAt, lowerBound),
        lte(heartbeatRuns.updatedAt, now),
      ))
      .orderBy(asc(heartbeatRuns.updatedAt), asc(heartbeatRuns.id))
      .limit(SWEEP_BATCH_SIZE + 1);
    const blockedIssues = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, config.companyId),
        eq(issues.status, "blocked"),
        isNull(issues.hiddenAt),
        gt(issues.updatedAt, lowerBound),
        lte(issues.updatedAt, now),
      ))
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(SWEEP_BATCH_SIZE + 1);

    let failedObserved = 0;
    for (const run of failedRuns.slice(0, SWEEP_BATCH_SIZE)) {
      const result = await observeFailedRun(run);
      if (result.observed) failedObserved += 1;
    }
    let blockedObserved = 0;
    for (const issue of blockedIssues.slice(0, SWEEP_BATCH_SIZE)) {
      const result = await observeBlockedIssue(issue);
      if (result.observed) blockedObserved += 1;
    }
    const verificationFinalized = await finalizePendingVerifications(config.companyId);
    const sourceOutcomes = await reconcileSourceOutcomes(config);
    const dispatches = await reconcileSourceDispatches(config);
    const incidentDispatches = await reconcileIncidentDispatches(config);
    const recoveredClosures = await reconcileRecoveredIncidentClosures(config);

    const cursors: Date[] = [];
    if (failedRuns.length > SWEEP_BATCH_SIZE) {
      const last = failedRuns[SWEEP_BATCH_SIZE - 1];
      if (last) cursors.push(new Date(last.updatedAt.getTime() - 1));
    }
    if (blockedIssues.length > SWEEP_BATCH_SIZE) {
      const last = blockedIssues[SWEEP_BATCH_SIZE - 1];
      if (last) cursors.push(new Date(last.updatedAt.getTime() - 1));
    }
    const nextSweepAt = cursors.length > 0
      ? new Date(Math.min(...cursors.map((cursor) => cursor.getTime())))
      : now;
    await db
      .update(recoveryEngineerConfigs)
      .set({ lastSweepAt: nextSweepAt, updatedAt: new Date() })
      .where(and(
        eq(recoveryEngineerConfigs.companyId, config.companyId),
        config.lastSweepAt
          ? eq(recoveryEngineerConfigs.lastSweepAt, config.lastSweepAt)
          : isNull(recoveryEngineerConfigs.lastSweepAt),
      ));
    return {
      companyId: config.companyId,
      failedObserved,
      blockedObserved,
      verificationFinalized,
      sourcesRecovered: sourceOutcomes.recovered,
      sourcesSuperseded: sourceOutcomes.superseded,
      sourcesPending: sourceOutcomes.pending,
      resumesReplayed: dispatches.replayed,
      resumesAdopted: dispatches.adopted,
      resumesExhausted: dispatches.exhausted,
      incidentDispatchesEvaluated: incidentDispatches.evaluated,
      incidentDispatchesRearmed: incidentDispatches.rearmed,
      incidentDispatchesAdopted: incidentDispatches.adopted,
      incidentDispatchesExhausted: incidentDispatches.exhausted,
      recoveredClosures: recoveredClosures.closed,
      backlog: cursors.length > 0,
    };
  }

  async function reconcileDue(now = new Date()) {
    const cutoff = new Date(now.getTime() - 300 * 1_000);
    const dueConfigs = await db
      .select()
      .from(recoveryEngineerConfigs)
      .where(and(
        eq(recoveryEngineerConfigs.enabled, true),
        or(
          isNull(recoveryEngineerConfigs.lastSweepAt),
          lte(recoveryEngineerConfigs.lastSweepAt, cutoff),
        ),
      ))
      .orderBy(asc(recoveryEngineerConfigs.lastSweepAt))
      .limit(50);
    const results: Array<Awaited<ReturnType<typeof reconcileCompany>>> = [];
    for (const config of dueConfigs) {
      if (sweepingCompanies.has(config.companyId)) continue;
      sweepingCompanies.add(config.companyId);
      try {
        results.push(await reconcileCompany(config, now));
      } finally {
        sweepingCompanies.delete(config.companyId);
      }
    }
    return {
      companies: results.length,
      failedObserved: results.reduce((total, row) => total + row.failedObserved, 0),
      blockedObserved: results.reduce((total, row) => total + row.blockedObserved, 0),
      verificationFinalized: results.reduce((total, row) => total + row.verificationFinalized, 0),
      sourcesRecovered: results.reduce((total, row) => total + row.sourcesRecovered, 0),
      sourcesSuperseded: results.reduce((total, row) => total + row.sourcesSuperseded, 0),
      sourcesPending: results.reduce((total, row) => total + row.sourcesPending, 0),
      resumesReplayed: results.reduce((total, row) => total + row.resumesReplayed, 0),
      resumesAdopted: results.reduce((total, row) => total + row.resumesAdopted, 0),
      resumesExhausted: results.reduce((total, row) => total + row.resumesExhausted, 0),
      incidentDispatchesEvaluated: results.reduce((total, row) => total + row.incidentDispatchesEvaluated, 0),
      incidentDispatchesRearmed: results.reduce((total, row) => total + row.incidentDispatchesRearmed, 0),
      incidentDispatchesAdopted: results.reduce((total, row) => total + row.incidentDispatchesAdopted, 0),
      incidentDispatchesExhausted: results.reduce((total, row) => total + row.incidentDispatchesExhausted, 0),
      recoveredClosures: results.reduce((total, row) => total + row.recoveredClosures, 0),
      backlogCompanies: results.filter((row) => row.backlog).length,
    };
  }

  return {
    getConfig,
    putConfig,
    resolveIncidentForIssue,
    readContext,
    recordAction,
    recordTrustedMaintenanceWaitForRun,
    reviewProcedure,
    confirmActivation,
    observeBlockedIssue,
    observeRunTerminal,
    reconcileIncidentOutcome: rollUpIncidentOutcome,
    reconcileSourceOutcomes,
    reconcileSourceDispatches,
    reconcileIncidentDispatches,
    reconcileRecoveredIncidentClosures,
    finalizePendingVerifications,
    reconcileDue,
  };
}
