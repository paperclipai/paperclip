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
    if (!incident) return false;
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

  async function claimDiagnosis(
    incident: IncidentRow,
    config: ConfigRow,
    maintenanceIssue: IssueRow,
  ) {
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

    let run: RunRow | null = null;
    try {
      run = await deps.enqueueWakeup(config.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "recovery_engineer_diagnose",
        idempotencyKey: `recovery-engineer:diagnose:${incident.id}`,
        payload: {
          issueId: maintenanceIssue.id,
          incidentId: incident.id,
          action: "diagnose",
        },
        contextSnapshot: {
          issueId: maintenanceIssue.id,
          taskId: maintenanceIssue.id,
          incidentId: incident.id,
          wakeReason: "recovery_engineer_diagnose",
          source: "recovery_engineer.incident_detected",
          recoveryRole: "diagnosis",
        },
        requestedByActorType: "system",
        requestedByActorId: "recovery_engineer",
      });
    } catch {
      await escalateToBoard(incident.id, "diagnosis_enqueue_failed");
      return null;
    }
    if (!run) {
      await escalateToBoard(incident.id, "diagnosis_not_enqueued");
      return null;
    }
    await db
      .update(recoveryEngineerIncidents)
      .set({ diagnosisRunId: run.id, updatedAt: new Date() })
      .where(eq(recoveryEngineerIncidents.id, incident.id));
    await logActivity(db, {
      companyId: incident.companyId,
      actorType: "system",
      actorId: "recovery_engineer",
      agentId: config.agentId,
      runId: run.id,
      action: "recovery_engineer.diagnosis_requested",
      entityType: "recovery_engineer_incident",
      entityId: incident.id,
      details: {
        maintenanceIssueId: maintenanceIssue.id,
        diagnosisAttempt: 1,
        maxAttempts: 1,
      },
    });
    return run;
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

    let repairRun: RunRow | null = null;
    try {
      repairRun = await deps.enqueueWakeup(config.repairAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "recovery_engineer_repair",
        idempotencyKey: `recovery-engineer:repair-wake:${incident.id}:${input.target}`,
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
      });
    } catch {
      await escalateToBoard(incident.id, "repair_enqueue_failed", actor.runId);
    }
    if (repairRun) {
      await db
        .update(recoveryEngineerIncidents)
        .set({ repairRunId: repairRun.id, updatedAt: new Date() })
        .where(eq(recoveryEngineerIncidents.id, incident.id));
    } else {
      await escalateToBoard(incident.id, "repair_not_enqueued", actor.runId);
    }
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
    if (maintenance.status === "blocked" || maintenance.status === "todo") {
      await issuesSvc.update(maintenance.id, { status: "in_progress" });
    }
    const run = await deps.enqueueWakeup(config.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "recovery_engineer_activated",
      idempotencyKey: `recovery-engineer:activated:${incident.id}:${incident.activatedRepairCommit}`,
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
    });
    if (!run) await escalateToBoard(incident.id, "post_activation_resume_wake_not_enqueued");
    return run;
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
    reconcileRecoveredIncidentClosures,
    finalizePendingVerifications,
    reconcileDue,
  };
}
