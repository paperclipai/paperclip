import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentConfigRevisions,
  agentApiKeys,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  activityLog,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
  issueComments,
  providerCredentials,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import {
  buildIssueMonitorClearedPatch,
  normalizeIssueExecutionPolicy,
} from "./issue-execution-policy.js";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return `pcp_${randomBytes(24).toString("hex")}`;
}

const CONFIG_REVISION_FIELDS = [
  "name",
  "role",
  "title",
  "reportsTo",
  "capabilities",
  "adapterType",
  "adapterConfig",
  "runtimeConfig",
  "defaultEnvironmentId",
  "budgetMonthlyCents",
  "metadata",
] as const;

type ConfigRevisionField = (typeof CONFIG_REVISION_FIELDS)[number];
type AgentConfigSnapshot = Pick<typeof agents.$inferSelect, ConfigRevisionField>;

interface RevisionMetadata {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  source?: string;
  rolledBackFromRevisionId?: string | null;
}

interface UpdateAgentOptions {
  recordRevision?: RevisionMetadata;
  terminationAudit?: TerminationAuditMetadata;
}

interface TerminationAuditMetadata {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  source?: string;
}

interface AgentServiceRuntimeOptions {
  driveQueuedRunsForAgent?: (agentId: string) => Promise<unknown>;
  cancelRecoveryRun?: (runId: string) => Promise<unknown>;
}

class RecoveryGenerationCancellationRequired extends Error {
  constructor(readonly runIds: string[]) {
    super("Running recovery work must be cancelled before its generation can be superseded");
  }
}

interface AgentShortnameRow {
  id: string;
  name: string;
  status: string;
}

interface AgentShortnameCollisionOptions {
  excludeAgentId?: string | null;
}

const TERMINATION_RECOVERY_TIMEOUT_MS = 15 * 60 * 1000;
const TERMINATION_CANCELLED_WAKE_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TERMINATION_EXECUTIVE_ROLES = new Set(["ceo", "cto"]);

function isInvokableAgent(agent: Pick<typeof agents.$inferSelect, "status"> | null | undefined) {
  return Boolean(
    agent && !["paused", "terminated", "pending_approval"].includes(agent.status),
  );
}

function normalizedCapabilityText(value: string | null | undefined) {
  return (value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function isExactCapabilityPeer(
  source: Pick<typeof agents.$inferSelect, "role" | "capabilities">,
  candidate: Pick<typeof agents.$inferSelect, "role" | "capabilities">,
) {
  return (
    source.role.trim().toLocaleLowerCase() === candidate.role.trim().toLocaleLowerCase() &&
    normalizedCapabilityText(source.capabilities) === normalizedCapabilityText(candidate.capabilities)
  );
}

function principalReferencesAgent(value: unknown, agentId: string) {
  return isPlainRecord(value) && value.type === "agent" && value.agentId === agentId;
}

function quiesceExecutionPrincipals(value: unknown, agentId: string) {
  if (!isPlainRecord(value)) {
    return { value, changed: false, currentParticipantCleared: false, returnAssigneeCleared: false };
  }
  const currentParticipantCleared = principalReferencesAgent(value.currentParticipant, agentId);
  const returnAssigneeCleared = principalReferencesAgent(value.returnAssignee, agentId);
  if (!currentParticipantCleared && !returnAssigneeCleared) {
    return { value, changed: false, currentParticipantCleared, returnAssigneeCleared };
  }
  return {
    value: {
      ...value,
      ...(currentParticipantCleared ? { currentParticipant: null } : {}),
      ...(returnAssigneeCleared ? { returnAssignee: null } : {}),
    },
    changed: true,
    currentParticipantCleared,
    returnAssigneeCleared,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildConfigSnapshot(
  row: Pick<typeof agents.$inferSelect, ConfigRevisionField>,
): AgentConfigSnapshot {
  const adapterConfig =
    typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
      ? sanitizeRecord(row.adapterConfig as Record<string, unknown>)
      : {};
  const runtimeConfig =
    typeof row.runtimeConfig === "object" && row.runtimeConfig !== null && !Array.isArray(row.runtimeConfig)
      ? sanitizeRecord(row.runtimeConfig as Record<string, unknown>)
      : {};
  const metadata =
    typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata)
      ? sanitizeRecord(row.metadata as Record<string, unknown>)
      : row.metadata ?? null;
  return {
    name: row.name,
    role: row.role,
    title: row.title,
    reportsTo: row.reportsTo,
    capabilities: row.capabilities,
    adapterType: row.adapterType,
    adapterConfig,
    runtimeConfig,
    defaultEnvironmentId: row.defaultEnvironmentId,
    budgetMonthlyCents: row.budgetMonthlyCents,
    metadata,
  };
}

function containsRedactedMarker(value: unknown): boolean {
  if (value === REDACTED_EVENT_VALUE) return true;
  if (Array.isArray(value)) return value.some((item) => containsRedactedMarker(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((entry) => containsRedactedMarker(entry));
}

function hasConfigPatchFields(data: Partial<typeof agents.$inferInsert>) {
  return CONFIG_REVISION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(data, field));
}

function parseFiniteNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRuntimeConfigForNewAgent(runtimeConfig: unknown): Record<string, unknown> {
  const normalizedRuntimeConfig = isPlainRecord(runtimeConfig) ? { ...runtimeConfig } : {};
  const heartbeat = isPlainRecord(normalizedRuntimeConfig.heartbeat)
    ? { ...normalizedRuntimeConfig.heartbeat }
    : {};
  if (parseFiniteNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  }
  normalizedRuntimeConfig.heartbeat = heartbeat;
  return normalizedRuntimeConfig;
}

function diffConfigSnapshot(
  before: AgentConfigSnapshot,
  after: AgentConfigSnapshot,
): string[] {
  return CONFIG_REVISION_FIELDS.filter((field) => !jsonEqual(before[field], after[field]));
}

function configPatchFromSnapshot(snapshot: unknown): Partial<typeof agents.$inferInsert> {
  if (!isPlainRecord(snapshot)) throw unprocessable("Invalid revision snapshot");

  if (typeof snapshot.name !== "string" || snapshot.name.length === 0) {
    throw unprocessable("Invalid revision snapshot: name");
  }
  if (typeof snapshot.role !== "string" || snapshot.role.length === 0) {
    throw unprocessable("Invalid revision snapshot: role");
  }
  if (typeof snapshot.adapterType !== "string" || snapshot.adapterType.length === 0) {
    throw unprocessable("Invalid revision snapshot: adapterType");
  }
  if (typeof snapshot.budgetMonthlyCents !== "number" || !Number.isFinite(snapshot.budgetMonthlyCents)) {
    throw unprocessable("Invalid revision snapshot: budgetMonthlyCents");
  }

  return {
    name: snapshot.name,
    role: snapshot.role,
    title: typeof snapshot.title === "string" || snapshot.title === null ? snapshot.title : null,
    reportsTo:
      typeof snapshot.reportsTo === "string" || snapshot.reportsTo === null ? snapshot.reportsTo : null,
    capabilities:
      typeof snapshot.capabilities === "string" || snapshot.capabilities === null
        ? snapshot.capabilities
        : null,
    adapterType: snapshot.adapterType,
    adapterConfig: isPlainRecord(snapshot.adapterConfig) ? snapshot.adapterConfig : {},
    runtimeConfig: isPlainRecord(snapshot.runtimeConfig) ? snapshot.runtimeConfig : {},
    defaultEnvironmentId:
      typeof snapshot.defaultEnvironmentId === "string" || snapshot.defaultEnvironmentId === null
        ? snapshot.defaultEnvironmentId
        : null,
    budgetMonthlyCents: Math.max(0, Math.floor(snapshot.budgetMonthlyCents)),
    metadata: isPlainRecord(snapshot.metadata) || snapshot.metadata === null ? snapshot.metadata : null,
  };
}

export function hasAgentShortnameCollision(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
  options?: AgentShortnameCollisionOptions,
): boolean {
  const candidateShortname = normalizeAgentUrlKey(candidateName);
  if (!candidateShortname) return false;

  return existingAgents.some((agent) => {
    if (agent.status === "terminated") return false;
    if (options?.excludeAgentId && agent.id === options.excludeAgentId) return false;
    return normalizeAgentUrlKey(agent.name) === candidateShortname;
  });
}

export function deduplicateAgentName(
  candidateName: string,
  existingAgents: AgentShortnameRow[],
): string {
  if (!hasAgentShortnameCollision(candidateName, existingAgents)) {
    return candidateName;
  }
  for (let i = 2; i <= 100; i++) {
    const suffixed = `${candidateName} ${i}`;
    if (!hasAgentShortnameCollision(suffixed, existingAgents)) {
      return suffixed;
    }
  }
  return `${candidateName} ${Date.now()}`;
}

export function agentService(db: Db, serviceOptions: AgentServiceRuntimeOptions = {}) {
  async function runningRecoveryRunIdsForAction(
    executor: Db,
    companyId: string,
    actionId: string,
    attemptCount: number,
  ) {
    return executor
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "running"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${actionId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryAttempt' = ${attemptCount}::text`,
        ),
      )
      .orderBy(asc(heartbeatRuns.id))
      .then((rows) => rows.map((row) => row.id));
  }

  function currentUtcMonthWindow(now = new Date()) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
      start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
    };
  }

  function withUrlKey<T extends { id: string; name: string }>(row: T) {
    return {
      ...row,
      urlKey: normalizeAgentUrlKey(row.name) ?? row.id,
    };
  }

  function normalizeAgentRow(row: typeof agents.$inferSelect) {
    return withUrlKey({
      ...row,
      permissions: normalizeAgentPermissions(row.permissions, row.role),
    });
  }

  async function getMonthlySpendByAgentIds(companyId: string, agentIds: string[]) {
    if (agentIds.length === 0) return new Map<string, number>();
    const { start, end } = currentUtcMonthWindow();
    const rows = await db
      .select({
        agentId: costEvents.agentId,
        spentMonthlyCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          inArray(costEvents.agentId, agentIds),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      )
      .groupBy(costEvents.agentId);
    return new Map(rows.map((row) => [row.agentId, Number(row.spentMonthlyCents ?? 0)]));
  }

  async function hydrateAgentSpend<T extends { id: string; companyId: string; spentMonthlyCents: number }>(rows: T[]) {
    const agentIds = rows.map((row) => row.id);
    const companyId = rows[0]?.companyId;
    if (!companyId || agentIds.length === 0) return rows;
    const spendByAgentId = await getMonthlySpendByAgentIds(companyId, agentIds);
    return rows.map((row) => ({
      ...row,
      spentMonthlyCents: spendByAgentId.get(row.id) ?? 0,
    }));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [hydrated] = await hydrateAgentSpend([row]);
    return normalizeAgentRow(hydrated);
  }

  async function ensureManager(companyId: string, managerId: string) {
    const manager = await getById(managerId);
    if (!manager) throw notFound("Manager not found");
    if (manager.companyId !== companyId) {
      throw unprocessable("Manager must belong to same company");
    }
    return manager;
  }

  async function assertCredentialBelongsToCompany(companyId: string, credentialId: string) {
    const cred = await db
      .select({ companyId: providerCredentials.companyId })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, credentialId))
      .then((rows) => rows[0] ?? null);
    if (!cred) throw notFound("Credential not found");
    if (cred.companyId !== companyId) {
      throw unprocessable("Credential must belong to same company");
    }
  }

  async function assertNoCycle(agentId: string, reportsTo: string | null | undefined) {
    if (!reportsTo) return;
    if (reportsTo === agentId) throw unprocessable("Agent cannot report to itself");

    let cursor: string | null = reportsTo;
    while (cursor) {
      if (cursor === agentId) throw unprocessable("Reporting relationship would create cycle");
      const next = await getById(cursor);
      cursor = next?.reportsTo ?? null;
    }
  }

  async function assertCompanyShortnameAvailable(
    companyId: string,
    candidateName: string,
    options?: AgentShortnameCollisionOptions,
  ) {
    const candidateShortname = normalizeAgentUrlKey(candidateName);
    if (!candidateShortname) return;

    const existingAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const hasCollision = hasAgentShortnameCollision(candidateName, existingAgents, options);
    if (hasCollision) {
      throw conflict(
        `Agent shortname '${candidateShortname}' is already in use in this company`,
      );
    }
  }

  function resolveTerminationAudit(options?: UpdateAgentOptions): TerminationAuditMetadata {
    if (options?.terminationAudit) return options.terminationAudit;
    if (options?.recordRevision?.createdByAgentId) {
      return {
        actorType: "agent",
        actorId: options.recordRevision.createdByAgentId,
        agentId: options.recordRevision.createdByAgentId,
        source: options.recordRevision.source ?? "agent_update",
      };
    }
    if (options?.recordRevision?.createdByUserId) {
      return {
        actorType: "user",
        actorId: options.recordRevision.createdByUserId,
        source: options.recordRevision.source ?? "agent_update",
      };
    }
    return { actorType: "system", actorId: "system", source: "agent_service" };
  }

  async function applyTerminationInvariant(
    executor: Db,
    agent: typeof agents.$inferSelect,
    previousStatus: string,
    lockedCompanyAgents: Array<typeof agents.$inferSelect>,
    options?: UpdateAgentOptions,
  ): Promise<string[]> {
    const now = new Date();
    const audit = resolveTerminationAudit(options);
    const companyAgentsById = new Map(lockedCompanyAgents.map((row) => [row.id, row]));
    companyAgentsById.set(agent.id, agent);

    const terminatedSubtreeIds = new Set<string>([agent.id]);
    let subtreeExpanded = true;
    while (subtreeExpanded) {
      subtreeExpanded = false;
      for (const candidate of companyAgentsById.values()) {
        if (
          !terminatedSubtreeIds.has(candidate.id) &&
          candidate.reportsTo &&
          terminatedSubtreeIds.has(candidate.reportsTo)
        ) {
          terminatedSubtreeIds.add(candidate.id);
          subtreeExpanded = true;
        }
      }
    }

    const outsideSubtree = [...companyAgentsById.values()].filter(
      (candidate) => candidate.id !== agent.id && !terminatedSubtreeIds.has(candidate.id),
    );
    const capabilityPeers = [...companyAgentsById.values()].filter(
      (candidate) => candidate.id !== agent.id,
    );
    const reportingReplacement = [
      agent.reportsTo ? companyAgentsById.get(agent.reportsTo) ?? null : null,
      ...outsideSubtree
        .filter((candidate) => TERMINATION_EXECUTIVE_ROLES.has(candidate.role.toLocaleLowerCase()))
        .sort((left, right) => {
          const leftRank = left.role.toLocaleLowerCase() === "ceo" ? 0 : 1;
          const rightRank = right.role.toLocaleLowerCase() === "ceo" ? 0 : 1;
          return leftRank - rightRank || left.id.localeCompare(right.id);
        }),
    ].find((candidate) =>
      candidate &&
      !terminatedSubtreeIds.has(candidate.id) &&
      isInvokableAgent(candidate),
    ) ?? null;

    const exactCapabilityPeerFor = (input: { role: string; capabilities: string | null }) =>
      capabilityPeers
        .filter((candidate) =>
          isInvokableAgent(candidate) &&
          !TERMINATION_EXECUTIVE_ROLES.has(candidate.role.toLocaleLowerCase()) &&
          isExactCapabilityPeer(input, candidate),
        )
        .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
    const capabilityPeer = exactCapabilityPeerFor({
      role: agent.role,
      capabilities: agent.capabilities,
    });
    const recoveryCoordinator = capabilityPeer ?? reportingReplacement;

    const assignedRoutineRows = await executor
      .select({
        id: routines.id,
        title: routines.title,
        status: routines.status,
        projectId: routines.projectId,
        goalId: routines.goalId,
        parentIssueId: routines.parentIssueId,
        priority: routines.priority,
        concurrencyPolicy: routines.concurrencyPolicy,
        catchUpPolicy: routines.catchUpPolicy,
        latestRevisionId: routines.latestRevisionId,
        latestRevisionNumber: routines.latestRevisionNumber,
      })
      .from(routines)
      .where(and(eq(routines.companyId, agent.companyId), eq(routines.assigneeAgentId, agent.id)))
      .orderBy(asc(routines.id))
      .for("update");
    const assignedRoutineIds = assignedRoutineRows.map((row) => row.id);
    const triggerSnapshots = assignedRoutineIds.length > 0
      ? await executor
          .select({
            id: routineTriggers.id,
            routineId: routineTriggers.routineId,
            kind: routineTriggers.kind,
            label: routineTriggers.label,
            enabled: routineTriggers.enabled,
            cronExpression: routineTriggers.cronExpression,
            timezone: routineTriggers.timezone,
            nextRunAt: routineTriggers.nextRunAt,
            lastFiredAt: routineTriggers.lastFiredAt,
            publicId: routineTriggers.publicId,
            secretId: routineTriggers.secretId,
            signingMode: routineTriggers.signingMode,
            replayWindowSec: routineTriggers.replayWindowSec,
            lastRotatedAt: routineTriggers.lastRotatedAt,
          })
          .from(routineTriggers)
          .where(
            and(
              eq(routineTriggers.companyId, agent.companyId),
              inArray(routineTriggers.routineId, assignedRoutineIds),
            ),
          )
          .orderBy(asc(routineTriggers.id))
          .for("update")
      : [];

    const pausedRoutines = await executor
      .update(routines)
      .set({ status: "paused", updatedAt: now })
      .where(
        and(
          eq(routines.companyId, agent.companyId),
          eq(routines.assigneeAgentId, agent.id),
          eq(routines.status, "active"),
        ),
      )
      .returning({ id: routines.id });

    const disabledTriggers = assignedRoutineIds.length > 0
      ? await executor
        .update(routineTriggers)
        .set({
          enabled: false,
          nextRunAt: null,
          // Containment is a system action, not an explicit recovery
          // disposition. Clear user/agent attribution so resolution cannot
          // mistake this automatic disable for a reviewed trigger decision.
          updatedByAgentId: null,
          updatedByUserId: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(routineTriggers.companyId, agent.companyId),
            inArray(routineTriggers.routineId, assignedRoutineIds),
            eq(routineTriggers.enabled, true),
          ),
        )
        .returning({ id: routineTriggers.id, routineId: routineTriggers.routineId })
      : [];

    const revokedKeys = await executor
      .update(agentApiKeys)
      .set({ revokedAt: now })
      .where(and(eq(agentApiKeys.agentId, agent.id), isNull(agentApiKeys.revokedAt)))
      .returning({ id: agentApiKeys.id });

    const cancelledWakeups = await executor
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to agent termination",
        updatedAt: now,
      })
      .where(
        and(
          eq(agentWakeupRequests.companyId, agent.companyId),
          eq(agentWakeupRequests.agentId, agent.id),
          inArray(agentWakeupRequests.status, [...TERMINATION_CANCELLED_WAKE_STATUSES]),
        ),
      )
      .returning({ id: agentWakeupRequests.id });

    const cancelledNonRunningRuns = await executor
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to agent termination",
        errorCode: "agent_terminated",
        updatedAt: now,
      })
      .where(
        and(
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
          inArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
        ),
      )
      .returning({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId });
    const cancelledNonRunningRunIds = cancelledNonRunningRuns.map((run) => run.id);
    const linkedWakeupIds = cancelledNonRunningRuns
      .map((run) => run.wakeupRequestId)
      .filter((wakeupId): wakeupId is string => Boolean(wakeupId));
    if (linkedWakeupIds.length > 0) {
      await executor
        .update(agentWakeupRequests)
        .set({
          status: "cancelled",
          finishedAt: now,
          error: "Cancelled due to agent termination",
          updatedAt: now,
        })
        .where(inArray(agentWakeupRequests.id, linkedWakeupIds));
    }
    if (cancelledNonRunningRunIds.length > 0) {
      await executor
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.companyId, agent.companyId),
            inArray(issues.executionRunId, cancelledNonRunningRunIds),
          ),
        );
    }

    let routineRecovery: {
      issueId: string;
      actionId: string;
      ownerAgentId: string | null;
      ownerType: "agent" | "board";
      wakeupRequestId: string | null;
      runId: string | null;
    } | null = null;
    let routineRecoveryOpened = false;
    const existingRoutineRecoveryIssue = assignedRoutineRows.length > 0
      ? await executor
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, agent.companyId),
              eq(issues.originKind, "harness_liveness_escalation"),
              eq(issues.originId, `agent_termination_routine_handoff:${agent.id}`),
              notInArray(issues.status, ["done", "cancelled"]),
            ),
          )
          .orderBy(desc(issues.createdAt))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    const existingRoutineRecoveryAction = existingRoutineRecoveryIssue
      ? await executor
          .select()
          .from(issueRecoveryActions)
          .where(
            and(
              eq(issueRecoveryActions.companyId, agent.companyId),
              eq(issueRecoveryActions.sourceIssueId, existingRoutineRecoveryIssue.id),
              inArray(issueRecoveryActions.status, ["active", "escalated"]),
            ),
          )
          .orderBy(desc(issueRecoveryActions.updatedAt))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    if (existingRoutineRecoveryIssue && existingRoutineRecoveryAction) {
      const existingContract = isPlainRecord(existingRoutineRecoveryIssue.executionContract)
        ? existingRoutineRecoveryIssue.executionContract
        : {};
      const existingInventory = isPlainRecord(existingContract.routineRecovery)
        ? existingContract.routineRecovery
        : {};
      const priorRoutineEntries = Array.isArray(existingInventory.routines)
        ? existingInventory.routines.filter(isPlainRecord)
        : [];
      const priorTriggerEntries = Array.isArray(existingInventory.triggers)
        ? existingInventory.triggers.filter(isPlainRecord)
        : [];
      const priorRoutineIds = new Set(
        priorRoutineEntries
          .map((entry) => typeof entry.id === "string" ? entry.id : null)
          .filter((id): id is string => Boolean(id)),
      );
      const priorTriggerIds = new Set(
        priorTriggerEntries
          .map((entry) => typeof entry.id === "string" ? entry.id : null)
          .filter((id): id is string => Boolean(id)),
      );
      const addedRoutineIds = assignedRoutineIds.filter((id) => !priorRoutineIds.has(id));
      const addedTriggerIds = triggerSnapshots
        .map((trigger) => trigger.id)
        .filter((id) => !priorTriggerIds.has(id));
      const inventoryChanged = addedRoutineIds.length > 0 || addedTriggerIds.length > 0;
      const typedAuthorityNeedsRepair =
        existingRoutineRecoveryAction.cause !== "terminated_routine_owner";

      if (inventoryChanged || typedAuthorityNeedsRepair) {
        const runningPriorGeneration = await runningRecoveryRunIdsForAction(
          executor,
          agent.companyId,
          existingRoutineRecoveryAction.id,
          existingRoutineRecoveryAction.attemptCount,
        );
        if (runningPriorGeneration.length > 0) {
          throw new RecoveryGenerationCancellationRequired(runningPriorGeneration);
        }
        const mergedRoutineById = new Map<string, Record<string, unknown>>();
        for (const entry of priorRoutineEntries) {
          if (typeof entry.id === "string") mergedRoutineById.set(entry.id, entry);
        }
        for (const entry of assignedRoutineRows) {
          mergedRoutineById.set(entry.id, entry);
        }
        const mergedTriggerById = new Map<string, Record<string, unknown>>();
        for (const entry of priorTriggerEntries) {
          if (typeof entry.id === "string") mergedTriggerById.set(entry.id, entry);
        }
        for (const entry of triggerSnapshots) {
          mergedTriggerById.set(entry.id, entry);
        }
        const mergedRoutines = [...mergedRoutineById.values()]
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        const mergedTriggers = [...mergedTriggerById.values()]
          .sort((left, right) => String(left.id).localeCompare(String(right.id)));
        const requiredRole = typeof existingInventory.terminatedAgentRole === "string"
          ? existingInventory.terminatedAgentRole
          : agent.role;
        const requiredCapabilities = typeof existingInventory.terminatedAgentCapabilities === "string"
          ? existingInventory.terminatedAgentCapabilities
          : null;
        const typedCapabilityPeer = exactCapabilityPeerFor({
          role: requiredRole,
          capabilities: requiredCapabilities,
        });
        const currentActionOwner = existingRoutineRecoveryAction.ownerAgentId
          ? companyAgentsById.get(existingRoutineRecoveryAction.ownerAgentId) ?? null
          : null;
        const retainedRoutineOwner = currentActionOwner &&
          currentActionOwner.id !== agent.id &&
          isInvokableAgent(currentActionOwner)
          ? currentActionOwner
          : null;
        const refreshedCoordinator = typedCapabilityPeer ?? retainedRoutineOwner ?? reportingReplacement;
        const refreshedAttempt = existingRoutineRecoveryAction.attemptCount + 1;
        const refreshedTimeoutAt = refreshedCoordinator
          ? new Date(now.getTime() + TERMINATION_RECOVERY_TIMEOUT_MS)
          : null;
        const refreshedContract = {
          ...existingContract,
          routineRecovery: {
            ...existingInventory,
            terminatedAgentId: typeof existingInventory.terminatedAgentId === "string"
              ? existingInventory.terminatedAgentId
              : agent.id,
            terminatedAgentRole: requiredRole,
            terminatedAgentCapabilities: requiredCapabilities,
            routines: mergedRoutines,
            triggers: mergedTriggers,
            inventoryGeneration: refreshedAttempt,
            inventoryRefreshedAt: now.toISOString(),
          },
        };
        await executor
          .update(issues)
          .set({
            executionContract: refreshedContract,
            assigneeAgentId: refreshedCoordinator?.id ?? null,
            assigneeUserId: null,
            status: refreshedCoordinator ? "todo" : "blocked",
            updatedAt: now,
          })
          .where(eq(issues.id, existingRoutineRecoveryIssue.id));
        const refreshedAction = await executor
          .update(issueRecoveryActions)
          .set({
            cause: "terminated_routine_owner",
            previousOwnerAgentId: typeof existingInventory.terminatedAgentId === "string"
              ? existingInventory.terminatedAgentId
              : agent.id,
            fingerprint: `terminated_routine_owner:${agent.companyId}:${
              typeof existingInventory.terminatedAgentId === "string"
                ? existingInventory.terminatedAgentId
                : agent.id
            }`,
            status: refreshedCoordinator ? "active" : "escalated",
            ownerType: refreshedCoordinator ? "agent" : "board",
            ownerAgentId: refreshedCoordinator?.id ?? null,
            ownerUserId: null,
            evidence: {
              ...(isPlainRecord(existingRoutineRecoveryAction.evidence)
                ? existingRoutineRecoveryAction.evidence
                : {}),
              routineIds: mergedRoutines.map((entry) => entry.id),
              triggerIds: mergedTriggers.map((entry) => entry.id),
              inventoryRefresh: {
                addedRoutineIds,
                addedTriggerIds,
                refreshedAt: now.toISOString(),
                recoveryAttempt: refreshedAttempt,
                typedAuthorityRepaired: typedAuthorityNeedsRepair,
              },
            },
            nextAction: refreshedCoordinator
              ? "Review the refreshed routine inventory, explicitly disposition every routine and trigger, then resolve the handoff."
              : "Board action required: assign a capable automation recovery owner or archive the refreshed routine inventory.",
            wakePolicy: refreshedCoordinator
              ? {
                  type: "wake_owner",
                  reason: "source_scoped_recovery_action",
                  ownerAgentId: refreshedCoordinator.id,
                  maxAttempts: 1,
                  timeoutAt: refreshedTimeoutAt!.toISOString(),
                }
              : { type: "board_escalation", reason: "no_capable_routine_recovery_owner" },
            attemptCount: refreshedAttempt,
            maxAttempts: refreshedCoordinator ? 1 : null,
            timeoutAt: refreshedTimeoutAt,
            lastAttemptAt: now,
            outcome: null,
            resolutionNote: null,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(eq(issueRecoveryActions.id, existingRoutineRecoveryAction.id))
          .returning()
          .then((rows) => rows[0]);
        if (!refreshedAction) throw conflict("Failed to refresh routine recovery action; retry");

        let wakeupRequestId: string | null = null;
        let runId: string | null = null;
        if (refreshedCoordinator) {
          const mergedRoutineIds = mergedRoutines
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string");
          const contextSnapshot = {
            issueId: existingRoutineRecoveryIssue.id,
            taskId: existingRoutineRecoveryIssue.id,
            sourceIssueId: existingRoutineRecoveryIssue.id,
            recoveryActionId: refreshedAction.id,
            recoveryAttempt: refreshedAction.attemptCount,
            wakeReason: "source_scoped_recovery_action",
            source: "issue_recovery_action",
            recoveryCause: "terminated_routine_owner",
            terminatedAgentId: typeof existingInventory.terminatedAgentId === "string"
              ? existingInventory.terminatedAgentId
              : agent.id,
            routineRecoveryIssueId: existingRoutineRecoveryIssue.id,
            routineIds: mergedRoutineIds,
            skipIssueComment: true,
          };
          const wakeup = await executor
            .insert(agentWakeupRequests)
            .values({
              companyId: agent.companyId,
              agentId: refreshedCoordinator.id,
              source: "automation",
              triggerDetail: "system",
              reason: "source_scoped_recovery_action",
              payload: {
                issueId: existingRoutineRecoveryIssue.id,
                sourceIssueId: existingRoutineRecoveryIssue.id,
                recoveryActionId: refreshedAction.id,
                recoveryAttempt: refreshedAction.attemptCount,
                recoveryCause: "terminated_routine_owner",
                routineIds: mergedRoutineIds,
              },
              status: "queued",
              requestedByActorType: "system",
              requestedByActorId: null,
              idempotencyKey: `agent_termination_routine_recovery:${refreshedAction.id}:${refreshedAction.attemptCount}`,
              updatedAt: now,
            })
            .returning()
            .then((rows) => rows[0]);
          const run = await executor
            .insert(heartbeatRuns)
            .values({
              companyId: agent.companyId,
              agentId: refreshedCoordinator.id,
              invocationSource: "automation",
              triggerDetail: "system",
              status: "queued",
              wakeupRequestId: wakeup.id,
              contextSnapshot,
              updatedAt: now,
            })
            .returning()
            .then((rows) => rows[0]);
          await executor
            .update(agentWakeupRequests)
            .set({ runId: run.id, updatedAt: now })
            .where(eq(agentWakeupRequests.id, wakeup.id));
          wakeupRequestId = wakeup.id;
          runId = run.id;
        }
        routineRecovery = {
          issueId: existingRoutineRecoveryIssue.id,
          actionId: refreshedAction.id,
          ownerAgentId: refreshedCoordinator?.id ?? null,
          ownerType: refreshedCoordinator ? "agent" : "board",
          wakeupRequestId,
          runId,
        };
        routineRecoveryOpened = true;
      } else {
        routineRecovery = {
          issueId: existingRoutineRecoveryIssue.id,
          actionId: existingRoutineRecoveryAction.id,
          ownerAgentId: existingRoutineRecoveryAction.ownerAgentId,
          ownerType: existingRoutineRecoveryAction.ownerType === "agent" ? "agent" : "board",
          wakeupRequestId: null,
          runId: null,
        };
      }
    }
    if (assignedRoutineRows.length > 0 && !routineRecovery) {
      const routineRecoveryIssue = existingRoutineRecoveryIssue ?? await executor
        .insert(issues)
        .values({
          companyId: agent.companyId,
          title: `Recover automations owned by terminated agent ${agent.name}`,
          description: [
            "Paperclip paused these automations during agent termination.",
            "",
            "Required disposition: inspect the typed routine handoff contract, then explicitly accept each routine by assigning it to a capable live owner and restoring only intended triggers, or archive it. Resolve this recovery action only after every routine has a recorded disposition.",
          ].join("\n"),
          status: recoveryCoordinator ? "todo" : "blocked",
          priority: "high",
          assigneeAgentId: recoveryCoordinator?.id ?? null,
          assigneeUserId: null,
          originKind: "harness_liveness_escalation",
          originId: `agent_termination_routine_handoff:${agent.id}`,
          originFingerprint: `agent_termination_routine_handoff:${agent.id}:${now.toISOString()}`,
          executionContract: {
            schemaVersion: 1,
            contractType: "routine_termination_handoff",
            taskType: "recovery_coordination",
            core: {
              objective: "Restore, reassign, or retire every automation owned by the terminated agent.",
              why: "Paused routines and disabled triggers must not disappear from the operating queue.",
              sourceOfTruth: ["routine rows", "routine trigger rows", "latest routine revisions"],
              acceptanceChecks: [
                "Every routine has a capable live assignee or is archived.",
                "Only intentionally restored triggers are enabled.",
                "The recovery action is resolved with a recorded disposition.",
              ],
              handoffNotes: {
                managerReasoning: "Termination containment stopped automation execution before ownership recovery.",
                currentBlocker: "The previous routine owner is terminated.",
                nextAction: "Accept/reassign or archive each routine, verify trigger state, then resolve this action.",
              },
            },
            routineRecovery: {
              terminatedAgentId: agent.id,
              terminatedAgentRole: agent.role,
              terminatedAgentCapabilities: agent.capabilities,
              inventoryGeneration: 1,
              routines: assignedRoutineRows,
              triggers: triggerSnapshots,
            },
          },
        })
        .returning()
        .then((rows) => rows[0]);
      if (!routineRecoveryIssue) {
        throw conflict("Failed to persist routine termination recovery issue; retry");
      }
      const timeoutAt = recoveryCoordinator
        ? new Date(now.getTime() + TERMINATION_RECOVERY_TIMEOUT_MS)
        : null;
      const routineRecoveryAction = await executor
        .insert(issueRecoveryActions)
        .values({
          companyId: agent.companyId,
          sourceIssueId: routineRecoveryIssue.id,
          kind: "stranded_assigned_issue",
          status: recoveryCoordinator ? "active" : "escalated",
          ownerType: recoveryCoordinator ? "agent" : "board",
          ownerAgentId: recoveryCoordinator?.id ?? null,
          ownerUserId: null,
          previousOwnerAgentId: agent.id,
          returnOwnerAgentId: null,
          cause: "terminated_routine_owner",
          fingerprint: `terminated_routine_owner:${agent.companyId}:${agent.id}`,
          evidence: {
            source: "agent_termination",
            terminatedAgentId: agent.id,
            routineIds: assignedRoutineIds,
            triggerIds: triggerSnapshots.map((trigger) => trigger.id),
            pausedRoutineIds: assignedRoutineRows
              .filter((routine) => routine.status === "active")
              .map((routine) => routine.id),
            disabledTriggerIds: triggerSnapshots
              .filter((trigger) => trigger.enabled)
              .map((trigger) => trigger.id),
          },
          nextAction: recoveryCoordinator
            ? "Explicitly accept/reassign or archive each routine, restore only intended triggers, verify the schedule, and resolve this recovery action."
            : "Board action required: assign a capable automation recovery owner or archive the paused routines.",
          wakePolicy: recoveryCoordinator
            ? {
                type: "wake_owner",
                reason: "source_scoped_recovery_action",
                ownerAgentId: recoveryCoordinator.id,
                maxAttempts: 1,
                timeoutAt: timeoutAt!.toISOString(),
              }
            : {
                type: "board_escalation",
                reason: "no_capable_routine_recovery_owner",
              },
          monitorPolicy: null,
          attemptCount: 1,
          maxAttempts: recoveryCoordinator ? 1 : null,
          timeoutAt,
          lastAttemptAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      let routineWakeupRequestId: string | null = null;
      let routineRunId: string | null = null;
      if (recoveryCoordinator) {
        const contextSnapshot = {
          issueId: routineRecoveryIssue.id,
          taskId: routineRecoveryIssue.id,
          sourceIssueId: routineRecoveryIssue.id,
          recoveryActionId: routineRecoveryAction.id,
          recoveryAttempt: routineRecoveryAction.attemptCount,
          wakeReason: "source_scoped_recovery_action",
          source: "issue_recovery_action",
          recoveryCause: "terminated_routine_owner",
          terminatedAgentId: agent.id,
          routineRecoveryIssueId: routineRecoveryIssue.id,
          routineIds: assignedRoutineIds,
          skipIssueComment: true,
        };
        const wakeup = await executor
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId: recoveryCoordinator.id,
            source: "automation",
            triggerDetail: "system",
            reason: "source_scoped_recovery_action",
            payload: {
              issueId: routineRecoveryIssue.id,
              sourceIssueId: routineRecoveryIssue.id,
              recoveryActionId: routineRecoveryAction.id,
              recoveryAttempt: routineRecoveryAction.attemptCount,
              recoveryCause: "terminated_routine_owner",
              routineIds: assignedRoutineIds,
            },
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: null,
            idempotencyKey: `agent_termination_routine_recovery:${routineRecoveryAction.id}:1`,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);
        const run = await executor
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId: recoveryCoordinator.id,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "queued",
            wakeupRequestId: wakeup.id,
            contextSnapshot,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);
        await executor
          .update(agentWakeupRequests)
          .set({ runId: run.id, updatedAt: now })
          .where(eq(agentWakeupRequests.id, wakeup.id));
        routineWakeupRequestId = wakeup.id;
        routineRunId = run.id;
      }
      routineRecovery = {
        issueId: routineRecoveryIssue.id,
        actionId: routineRecoveryAction.id,
        ownerAgentId: recoveryCoordinator?.id ?? null,
        ownerType: recoveryCoordinator ? "agent" : "board",
        wakeupRequestId: routineWakeupRequestId,
        runId: routineRunId,
      };
      routineRecoveryOpened = true;
    }

    const affectedIssues = await executor
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          or(
            eq(issues.assigneeAgentId, agent.id),
            sql`${issues.executionState} -> 'currentParticipant' ->> 'type' = 'agent'
              and ${issues.executionState} -> 'currentParticipant' ->> 'agentId' = ${agent.id}`,
            sql`${issues.executionState} -> 'returnAssignee' ->> 'type' = 'agent'
              and ${issues.executionState} -> 'returnAssignee' ->> 'agentId' = ${agent.id}`,
            // Recovery ownership is an execution responsibility in its own
            // right. A coordinator can own a recovery action without being
            // the source issue assignee, so terminating that coordinator must
            // migrate the action instead of leaving the active-source unique
            // row permanently stranded.
            sql`exists (
              select 1
              from ${issueRecoveryActions}
              where ${issueRecoveryActions.companyId} = ${agent.companyId}
                and ${issueRecoveryActions.sourceIssueId} = ${issues.id}
                and ${issueRecoveryActions.ownerAgentId} = ${agent.id}
                and ${issueRecoveryActions.status} in ('active', 'escalated')
            )`,
          ),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(asc(issues.id))
      .for("update");

    const recoveryActions: Array<{
      id: string;
      issueId: string;
      ownerAgentId: string | null;
      ownerType: "agent" | "board";
      monitorQuiesced: boolean;
      executionPrincipalQuiesced: boolean;
      wakeupRequestId: string | null;
      runId: string | null;
    }> = [];
    for (const issue of affectedIssues) {
      const sourceOwnedByTerminatedAgent = issue.assigneeAgentId === agent.id;
      const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
      const hasActiveMonitor = sourceOwnedByTerminatedAgent && Boolean(
        issue.monitorNextCheckAt || issue.monitorWakeRequestedAt || policy?.monitor,
      );
      const persistedExecutionState = isPlainRecord(issue.executionState)
        ? issue.executionState
        : null;
      const monitorSnapshot = hasActiveMonitor
        ? {
            nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? null,
            wakeRequestedAt: issue.monitorWakeRequestedAt?.toISOString() ?? null,
            lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? null,
            attemptCount: issue.monitorAttemptCount,
            notes: issue.monitorNotes,
            scheduledBy: issue.monitorScheduledBy,
            policy: policy?.monitor ?? null,
            state: persistedExecutionState?.monitor ?? null,
          }
        : null;
      const monitorPatch: Partial<typeof issues.$inferInsert> = hasActiveMonitor
        ? buildIssueMonitorClearedPatch({
            issue,
            policy,
            clearReason: "invalid_assignee",
            clearedAt: now,
          })
        : {};
      const stateAfterMonitor = Object.prototype.hasOwnProperty.call(monitorPatch, "executionState")
        ? monitorPatch.executionState
        : issue.executionState;
      const quiescedState = quiesceExecutionPrincipals(stateAfterMonitor, agent.id);
      const issuePatch = {
        ...monitorPatch,
        ...(quiescedState.changed
          ? { executionState: quiescedState.value as Record<string, unknown> }
          : {}),
        updatedAt: now,
      };
      await executor
        .update(issues)
        .set(issuePatch)
        .where(
          and(
            eq(issues.id, issue.id),
            eq(issues.companyId, agent.companyId),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        );

      const existingAction = await executor
        .select()
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.companyId, agent.companyId),
            eq(issueRecoveryActions.sourceIssueId, issue.id),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
          ),
        )
        .orderBy(desc(issueRecoveryActions.updatedAt))
        .limit(1)
        .for("update")
        .then((rows) => rows[0] ?? null);
      const issueExecutionContract = isPlainRecord(issue.executionContract)
        ? issue.executionContract
        : {};
      const issueRoutineRecovery = isPlainRecord(issueExecutionContract.routineRecovery)
        ? issueExecutionContract.routineRecovery
        : null;
      const issueRoutineIds = issueRoutineRecovery && Array.isArray(issueRoutineRecovery.routines)
        ? issueRoutineRecovery.routines
            .map((routine) => isPlainRecord(routine) && typeof routine.id === "string" ? routine.id : null)
            .filter((routineId): routineId is string => Boolean(routineId))
        : [];
      const routineTerminationRecovery =
        existingAction?.cause === "terminated_routine_owner" &&
        issue.originKind === "harness_liveness_escalation" &&
        issue.originId?.startsWith("agent_termination_routine_handoff:") &&
        issueRoutineRecovery &&
        typeof issueRoutineRecovery.terminatedAgentId === "string"
          ? {
              terminatedAgentId: issueRoutineRecovery.terminatedAgentId,
              requiredRole: typeof issueRoutineRecovery.terminatedAgentRole === "string"
                ? issueRoutineRecovery.terminatedAgentRole
                : agent.role,
              requiredCapabilities: typeof issueRoutineRecovery.terminatedAgentCapabilities === "string"
                ? issueRoutineRecovery.terminatedAgentCapabilities
                : null,
              routineIds: issueRoutineIds,
            }
          : null;
      const routineCapabilityPeer = routineTerminationRecovery
        ? exactCapabilityPeerFor({
            role: routineTerminationRecovery.requiredRole,
            capabilities: routineTerminationRecovery.requiredCapabilities,
          })
        : null;
      const preferredRecoveryCoordinator = routineTerminationRecovery
        ? routineCapabilityPeer ?? reportingReplacement
        : recoveryCoordinator;
      const existingOwner = existingAction?.ownerAgentId
        ? companyAgentsById.get(existingAction.ownerAgentId) ?? null
        : null;
      const retainedOwner = existingOwner &&
        existingOwner.id !== agent.id &&
        isInvokableAgent(existingOwner)
        ? existingOwner
        : null;
      const existingEvidence = isPlainRecord(existingAction?.evidence)
        ? existingAction.evidence
        : {};
      const existingTerminationContainment = isPlainRecord(existingEvidence.terminationContainment)
        ? existingEvidence.terminationContainment
        : null;
      const existingActionHasLivePath = Boolean(
        existingAction &&
        (
          (existingAction.ownerType === "board" && existingAction.status === "escalated") ||
          retainedOwner
        ),
      );
      if (
        previousStatus === "terminated" &&
        existingAction &&
        existingTerminationContainment?.terminatedAgentId === agent.id &&
        existingActionHasLivePath &&
        !hasActiveMonitor &&
        !quiescedState.changed
      ) {
        continue;
      }
      if (existingAction) {
        const runningPriorGeneration = await runningRecoveryRunIdsForAction(
          executor,
          agent.companyId,
          existingAction.id,
          existingAction.attemptCount,
        );
        if (runningPriorGeneration.length > 0) {
          throw new RecoveryGenerationCancellationRequired(runningPriorGeneration);
        }
      }
      const actionOwner = retainedOwner ?? preferredRecoveryCoordinator;
      const ownerType = actionOwner ? "agent" as const : "board" as const;
      const actionStatus = actionOwner ? "active" as const : "escalated" as const;
      const timeoutAt = actionOwner
        ? new Date(now.getTime() + TERMINATION_RECOVERY_TIMEOUT_MS)
        : null;
      const terminationEvidence = {
        source: "agent_termination",
        terminatedAgentId: agent.id,
        terminatedAgentRole: agent.role,
        terminatedAgentCapabilities: agent.capabilities,
        sourceIssueStatus: issue.status,
        sourceOwnedByTerminatedAgent,
        currentParticipantCleared: quiescedState.currentParticipantCleared,
        returnAssigneeCleared: quiescedState.returnAssigneeCleared,
        monitorQuiesced: hasActiveMonitor,
        monitorSnapshot,
        recoveryOwnerSelection: retainedOwner
          ? "existing_action_owner"
          : routineCapabilityPeer ?? capabilityPeer
            ? "exact_role_capability_peer"
            : reportingReplacement
              ? "reporting_coordinator"
              : "board",
      };
      const actionValues = {
        kind: existingAction?.kind ?? "stranded_assigned_issue",
        status: actionStatus,
        ownerType,
        ownerAgentId: actionOwner?.id ?? null,
        ownerUserId: null,
        previousOwnerAgentId: routineTerminationRecovery?.terminatedAgentId ?? agent.id,
        returnOwnerAgentId: null,
        cause: existingAction?.cause ?? "terminated_owner",
        fingerprint: existingAction?.fingerprint ?? [
          "terminated_owner",
          agent.companyId,
          issue.id,
          agent.id,
        ].join(":"),
        evidence: {
          ...existingEvidence,
          terminationContainment: terminationEvidence,
        },
        nextAction: routineTerminationRecovery
          ? actionOwner
            ? "Review the typed routine inventory, explicitly disposition every routine and trigger, then resolve the automation handoff."
            : "Board action required: assign a capable automation recovery owner or archive the typed routine inventory."
          : actionOwner
            ? "Triage the terminated-owner handoff, explicitly accept or reassign the source issue to a capable live owner, and record the resulting disposition."
            : "Board action required: assign a capable live recovery owner or record an intentional resolution for work stranded by agent termination.",
        wakePolicy: actionOwner
          ? {
              type: "wake_owner",
              reason: "source_scoped_recovery_action",
              ownerAgentId: actionOwner.id,
              maxAttempts: 1,
              timeoutAt: timeoutAt!.toISOString(),
            }
          : {
              type: "board_escalation",
              reason: routineTerminationRecovery
                ? "no_capable_routine_recovery_owner"
                : "no_capable_termination_recovery_owner",
            },
        monitorPolicy: monitorSnapshot,
        attemptCount: (existingAction?.attemptCount ?? 0) + 1,
        maxAttempts: actionOwner ? 1 : null,
        timeoutAt,
        lastAttemptAt: now,
        outcome: null,
        resolutionNote: null,
        resolvedAt: null,
        updatedAt: now,
      };

      let action = existingAction
        ? await executor
            .update(issueRecoveryActions)
            .set(actionValues)
            .where(eq(issueRecoveryActions.id, existingAction.id))
            .returning()
            .then((rows) => rows[0] ?? null)
        : await executor
            .insert(issueRecoveryActions)
            .values({
              companyId: agent.companyId,
              sourceIssueId: issue.id,
              ...actionValues,
            })
            .onConflictDoNothing()
            .returning()
            .then((rows) => rows[0] ?? null);
      if (!action) {
        const raced = await executor
          .select()
          .from(issueRecoveryActions)
          .where(
            and(
              eq(issueRecoveryActions.companyId, agent.companyId),
              eq(issueRecoveryActions.sourceIssueId, issue.id),
              inArray(issueRecoveryActions.status, ["active", "escalated"]),
            ),
          )
          .orderBy(desc(issueRecoveryActions.updatedAt))
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!raced) throw conflict("Recovery action changed during agent termination; retry");
        action = await executor
          .update(issueRecoveryActions)
          .set(actionValues)
          .where(eq(issueRecoveryActions.id, raced.id))
          .returning()
          .then((rows) => rows[0] ?? null);
      }
      if (!action) throw conflict("Failed to persist termination recovery action; retry");

      if (routineTerminationRecovery && issue.assigneeAgentId === agent.id) {
        await executor
          .update(issues)
          .set({
            assigneeAgentId: actionOwner?.id ?? null,
            assigneeUserId: null,
            status: actionOwner ? "todo" : "blocked",
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, issue.id),
              eq(issues.companyId, agent.companyId),
              eq(issues.assigneeAgentId, agent.id),
            ),
          );
      }

      let wakeupRequestId: string | null = null;
      let runId: string | null = null;
      if (actionOwner) {
        const contextSnapshot = {
          issueId: issue.id,
          taskId: issue.id,
          sourceIssueId: issue.id,
          recoveryActionId: action.id,
          recoveryAttempt: action.attemptCount,
          wakeReason: "source_scoped_recovery_action",
          source: "issue_recovery_action",
          recoveryCause: action.cause,
          terminatedAgentId: routineTerminationRecovery?.terminatedAgentId ?? agent.id,
          ...(routineTerminationRecovery
            ? {
                routineRecoveryIssueId: issue.id,
                routineIds: routineTerminationRecovery.routineIds,
              }
            : {}),
          skipIssueComment: true,
        };
        const wakeup = await executor
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId: actionOwner.id,
            source: "automation",
            triggerDetail: "system",
            reason: "source_scoped_recovery_action",
            payload: {
              issueId: issue.id,
              sourceIssueId: issue.id,
              recoveryActionId: action.id,
              recoveryAttempt: action.attemptCount,
              recoveryCause: action.cause,
              ...(routineTerminationRecovery
                ? { routineIds: routineTerminationRecovery.routineIds }
                : {}),
            },
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: null,
            idempotencyKey: `agent_termination_recovery:${action.id}:${action.attemptCount}`,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);
        const run = await executor
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId: actionOwner.id,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "queued",
            wakeupRequestId: wakeup.id,
            contextSnapshot,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]);
        await executor
          .update(agentWakeupRequests)
          .set({ runId: run.id, updatedAt: now })
          .where(eq(agentWakeupRequests.id, wakeup.id));
        wakeupRequestId = wakeup.id;
        runId = run.id;
      }

      recoveryActions.push({
        id: action.id,
        issueId: issue.id,
        ownerAgentId: actionOwner?.id ?? null,
        ownerType,
        monitorQuiesced: hasActiveMonitor,
        executionPrincipalQuiesced: quiescedState.changed,
        wakeupRequestId,
        runId,
      });
    }

    const directReports = [...companyAgentsById.values()]
      .filter((candidate) => candidate.reportsTo === agent.id && candidate.status !== "terminated")
      .sort((left, right) => left.id.localeCompare(right.id));
    const reparentedAgents: Array<{ id: string; reportsTo: string | null }> = [];
    for (const subordinate of directReports) {
      let reportsTo = reportingReplacement?.id ?? null;
      if (reportsTo) {
        const visited = new Set<string>([subordinate.id]);
        let cursor: string | null = reportsTo;
        while (cursor) {
          if (visited.has(cursor)) {
            reportsTo = null;
            break;
          }
          visited.add(cursor);
          cursor = cursor === agent.id
            ? null
            : companyAgentsById.get(cursor)?.reportsTo ?? null;
        }
      }
      const updatedSubordinate = await executor
        .update(agents)
        .set({ reportsTo, updatedAt: now })
        .where(
          and(
            eq(agents.id, subordinate.id),
            eq(agents.companyId, agent.companyId),
            eq(agents.reportsTo, agent.id),
            ne(agents.status, "terminated"),
          ),
        )
        .returning({ id: agents.id })
        .then((rows) => rows[0] ?? null);
      if (updatedSubordinate) reparentedAgents.push({ ...updatedSubordinate, reportsTo });
    }

    const baseActivity = {
      companyId: agent.companyId,
      actorType: audit.actorType,
      actorId: audit.actorId,
      agentId: audit.agentId ?? null,
      runId: audit.runId ?? null,
    };
    await executor.insert(activityLog).values([
      {
        ...baseActivity,
        action: "agent.termination_invariant_applied",
        entityType: "agent",
        entityId: agent.id,
        details: {
          source: audit.source ?? "agent_service",
          previousStatus,
          pausedRoutineCount: pausedRoutines.length,
          disabledTriggerCount: disabledTriggers.length,
          revokedApiKeyCount: revokedKeys.length,
          cancelledWakeupCount: cancelledWakeups.length,
          cancelledNonRunningRunCount: cancelledNonRunningRuns.length,
          affectedOpenIssueCount: affectedIssues.length,
          recoveryActionCount: recoveryActions.length,
          boardRecoveryActionCount: recoveryActions.filter((action) => action.ownerType === "board").length,
          quiescedIssueMonitorCount: recoveryActions.filter((action) => action.monitorQuiesced).length,
          quiescedExecutionPrincipalCount: recoveryActions.filter(
            (action) => action.executionPrincipalQuiesced,
          ).length,
          reparentedAgentCount: reparentedAgents.length,
          reportingReplacementAgentId: reportingReplacement?.id ?? null,
          recoveryCoordinatorAgentId: recoveryCoordinator?.id ?? null,
          recoveryCoordinatorSelection: capabilityPeer
            ? "exact_role_capability_peer"
            : reportingReplacement
              ? "reporting_coordinator"
              : "board",
          routineRecoveryIssueId: routineRecovery?.issueId ?? null,
          routineRecoveryActionId: routineRecovery?.actionId ?? null,
        },
      },
      ...pausedRoutines.map((routine) => ({
        ...baseActivity,
        action: "routine.updated",
        entityType: "routine",
        entityId: routine.id,
        details: { source: "agent_termination", status: "paused", assigneeAgentId: agent.id },
      })),
      ...disabledTriggers.map((trigger) => ({
        ...baseActivity,
        action: "routine.trigger_updated",
        entityType: "routine_trigger",
        entityId: trigger.id,
        details: {
          source: "agent_termination",
          routineId: trigger.routineId,
          enabled: false,
          nextRunAt: null,
        },
      })),
      ...revokedKeys.map((key) => ({
        ...baseActivity,
        action: "agent.key_revoked",
        entityType: "agent_api_key",
        entityId: key.id,
        details: { source: "agent_termination", agentId: agent.id },
      })),
      ...cancelledWakeups.map((wakeup) => ({
        ...baseActivity,
        action: "agent.wakeup_cancelled",
        entityType: "agent_wakeup_request",
        entityId: wakeup.id,
        details: {
          source: "agent_termination",
          agentId: agent.id,
          reason: "agent_terminated",
        },
      })),
      ...recoveryActions.map((action) => ({
        ...baseActivity,
        action: action.ownerType === "board"
          ? "issue.recovery_action_escalated"
          : "issue.recovery_action_opened",
        entityType: "issue",
        entityId: action.issueId,
        details: {
          source: "agent_termination",
          recoveryActionId: action.id,
          previousOwnerAgentId: agent.id,
          recoveryOwnerAgentId: action.ownerAgentId,
          recoveryOwnerType: action.ownerType,
          monitorQuiesced: action.monitorQuiesced,
          executionPrincipalQuiesced: action.executionPrincipalQuiesced,
          wakeupRequestId: action.wakeupRequestId,
          recoveryRunId: action.runId,
        },
      })),
      ...(routineRecovery && routineRecoveryOpened
        ? [{
            ...baseActivity,
            action: routineRecovery.ownerType === "board"
              ? "issue.recovery_action_escalated"
              : "issue.recovery_action_opened",
            entityType: "issue",
            entityId: routineRecovery.issueId,
            details: {
              source: "agent_termination_routine_handoff",
              recoveryActionId: routineRecovery.actionId,
              previousOwnerAgentId: agent.id,
              recoveryOwnerAgentId: routineRecovery.ownerAgentId,
              recoveryOwnerType: routineRecovery.ownerType,
              routineIds: assignedRoutineIds,
              triggerIds: triggerSnapshots.map((trigger) => trigger.id),
              wakeupRequestId: routineRecovery.wakeupRequestId,
              recoveryRunId: routineRecovery.runId,
            },
          }]
        : []),
      ...reparentedAgents.map((subordinate) => ({
        ...baseActivity,
        action: "agent.reporting_line_migrated",
        entityType: "agent",
        entityId: subordinate.id,
        details: {
          source: "agent_termination",
          previousReportsTo: agent.id,
          reportsTo: subordinate.reportsTo,
        },
      })),
    ]);
    return [...new Set(
      [
        ...recoveryActions.map((action) => action.ownerAgentId),
        routineRecoveryOpened ? routineRecovery?.ownerAgentId ?? null : null,
      ]
        .filter((agentId): agentId is string => Boolean(agentId)),
    )];
  }

  async function updateAgent(
    id: string,
    data: Partial<typeof agents.$inferInsert>,
    options?: UpdateAgentOptions,
  ) {
    const existing = await getById(id);
    if (!existing) return null;

    if (existing.status === "terminated" && data.status && data.status !== "terminated") {
      throw conflict("Terminated agents cannot be resumed");
    }
    if (
      existing.status === "pending_approval" &&
      data.status &&
      data.status !== "pending_approval" &&
      data.status !== "terminated"
    ) {
      throw conflict("Pending approval agents cannot be activated directly");
    }

    if (data.reportsTo !== undefined) {
      if (data.reportsTo) {
        await ensureManager(existing.companyId, data.reportsTo);
      }
      await assertNoCycle(id, data.reportsTo);
    }

    if (data.credentialId) {
      await assertCredentialBelongsToCompany(existing.companyId, data.credentialId);
    }

    if (data.name !== undefined) {
      const previousShortname = normalizeAgentUrlKey(existing.name);
      const nextShortname = normalizeAgentUrlKey(data.name);
      if (previousShortname !== nextShortname) {
        await assertCompanyShortnameAvailable(existing.companyId, data.name, { excludeAgentId: id });
      }
    }

    const normalizedPatch = { ...data } as Partial<typeof agents.$inferInsert>;
    if (data.permissions !== undefined) {
      const role = (data.role ?? existing.role) as string;
      normalizedPatch.permissions = normalizeAgentPermissions(data.permissions, role);
    }

    const shouldRecordRevision = Boolean(options?.recordRevision) && hasConfigPatchFields(normalizedPatch);

    let recoveryQueueAgentIds: string[] = [];
    const persistUpdate = async (executor: Db) => {
      // Serialize every agent mutation with termination. Several callers validate
      // the row before reaching this point, so without a row lock an ordinary
      // status update could read `active`, wait for a concurrent termination to
      // commit, and then overwrite `terminated` with its stale patch.
      const lockedAgentRows = await executor
        .select()
        .from(agents)
        .where(
          normalizedPatch.status === "terminated"
            ? eq(agents.companyId, existing.companyId)
            : eq(agents.id, id),
        )
        .orderBy(asc(agents.id))
        .for("update");
      const lockedAgentsById = new Map(lockedAgentRows.map((agent) => [agent.id, agent]));
      const lockedExisting = lockedAgentsById.get(id) ?? null;
      if (!lockedExisting) return null;

      if (
        lockedExisting.status === "terminated" &&
        normalizedPatch.status &&
        normalizedPatch.status !== "terminated"
      ) {
        throw conflict("Terminated agents cannot be resumed");
      }
      if (
        lockedExisting.status === "pending_approval" &&
        normalizedPatch.status &&
        normalizedPatch.status !== "pending_approval" &&
        normalizedPatch.status !== "terminated"
      ) {
        throw conflict("Pending approval agents cannot be activated directly");
      }

      const beforeConfig = shouldRecordRevision ? buildConfigSnapshot(lockedExisting) : null;
      const updated = await executor
        .update(agents)
        .set({ ...normalizedPatch, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      const normalizedUpdated = updated ? normalizeAgentRow(updated) : null;

      if (
        normalizedUpdated &&
        normalizedPatch.status === "terminated"
      ) {
        recoveryQueueAgentIds = await applyTerminationInvariant(
          executor,
          updated!,
          lockedExisting.status,
          lockedAgentRows,
          options,
        );
      }

      if (normalizedUpdated && shouldRecordRevision && beforeConfig) {
        const afterConfig = buildConfigSnapshot(normalizedUpdated);
        const changedKeys = diffConfigSnapshot(beforeConfig, afterConfig);
        if (changedKeys.length > 0) {
          await executor.insert(agentConfigRevisions).values({
            companyId: normalizedUpdated.companyId,
            agentId: normalizedUpdated.id,
            createdByAgentId: options?.recordRevision?.createdByAgentId ?? null,
            createdByUserId: options?.recordRevision?.createdByUserId ?? null,
            source: options?.recordRevision?.source ?? "patch",
            rolledBackFromRevisionId: options?.recordRevision?.rolledBackFromRevisionId ?? null,
            changedKeys,
            beforeConfig: beforeConfig as unknown as Record<string, unknown>,
            afterConfig: afterConfig as unknown as Record<string, unknown>,
          });
        }
      }

      return normalizedUpdated;
    };

    let result: Awaited<ReturnType<typeof persistUpdate>> | undefined;
    let transactionCompleted = false;
    const cancelledRecoveryRunIds = new Set<string>();
    while (!transactionCompleted) {
      recoveryQueueAgentIds = [];
      try {
        result = await db.transaction(async (tx) => persistUpdate(tx as unknown as Db));
        transactionCompleted = true;
      } catch (error) {
        if (!(error instanceof RecoveryGenerationCancellationRequired)) throw error;
        if (!serviceOptions.cancelRecoveryRun) {
          throw conflict(
            "Cannot supersede a running recovery generation without heartbeat control-plane cancellation",
            { runIds: error.runIds },
          );
        }
        const newRunIds = error.runIds.filter((runId) => !cancelledRecoveryRunIds.has(runId));
        if (newRunIds.length === 0) {
          throw conflict("Running recovery cancellation made no progress", {
            runIds: error.runIds,
          });
        }
        for (const runId of newRunIds) {
          await serviceOptions.cancelRecoveryRun(runId);
          cancelledRecoveryRunIds.add(runId);
        }
      }
    }
    if (!transactionCompleted) {
      throw conflict("Agent update did not reach a durable result");
    }
    if (serviceOptions.driveQueuedRunsForAgent && recoveryQueueAgentIds.length > 0) {
      for (const recoveryAgentId of recoveryQueueAgentIds) {
        try {
          await serviceOptions.driveQueuedRunsForAgent(recoveryAgentId);
        } catch (error) {
          await db.insert(activityLog).values({
            companyId: existing.companyId,
            actorType: "system",
            actorId: "system",
            agentId: recoveryAgentId,
            action: "agent.termination_recovery_kick_failed",
            entityType: "agent",
            entityId: recoveryAgentId,
            details: {
              source: "agent_termination",
              terminatedAgentId: id,
              error: error instanceof Error ? error.message : String(error),
              durableQueuedRunPreserved: true,
            },
          });
        }
      }
    }
    return result;
  }

  return {
    list: async (companyId: string, options?: { includeTerminated?: boolean }) => {
      const conditions = [eq(agents.companyId, companyId)];
      if (!options?.includeTerminated) {
        conditions.push(ne(agents.status, "terminated"));
      }
      const rows = await db.select().from(agents).where(and(...conditions));
      const hydrated = await hydrateAgentSpend(rows);
      return hydrated.map(normalizeAgentRow);
    },

    getById,

    create: async (companyId: string, data: Omit<typeof agents.$inferInsert, "companyId">) => {
      if (data.reportsTo) {
        await ensureManager(companyId, data.reportsTo);
      }

      if (data.credentialId) {
        await assertCredentialBelongsToCompany(companyId, data.credentialId);
      }

      const existingAgents = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      const uniqueName = deduplicateAgentName(data.name, existingAgents);

      const role = data.role ?? "general";
      const normalizedPermissions = normalizeAgentPermissions(data.permissions, role);
      const runtimeConfig = normalizeRuntimeConfigForNewAgent(data.runtimeConfig);
      const created = await db
        .insert(agents)
        .values({ ...data, name: uniqueName, companyId, role, permissions: normalizedPermissions, runtimeConfig })
        .returning()
        .then((rows) => rows[0]);

      return normalizeAgentRow(created);
    },

    update: updateAgent,

    pause: async (id: string, reason: "manual" | "budget" | "system" = "manual") => {
      return updateAgent(id, {
        status: "paused",
        pauseReason: reason,
        pausedAt: new Date(),
      });
    },

    resume: async (id: string) => {
      return updateAgent(id, {
        status: "idle",
        pauseReason: null,
        pausedAt: null,
      });
    },

    terminate: async (id: string, audit?: TerminationAuditMetadata) =>
      updateAgent(
        id,
        { status: "terminated", pauseReason: null, pausedAt: null },
        { terminationAudit: audit },
      ),

    remove: async (id: string) => {
      const existing = await getById(id);
      if (!existing) return null;

      return db.transaction(async (tx) => {
        await tx.update(agents).set({ reportsTo: null }).where(eq(agents.reportsTo, id));
        await tx
          .update(issues)
          .set({ assigneeAgentId: null, createdByAgentId: null })
          .where(or(eq(issues.assigneeAgentId, id), eq(issues.createdByAgentId, id)));
        await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.agentId, id));
        await tx.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, id));
        await tx.delete(activityLog).where(
          or(
            eq(activityLog.agentId, id),
            sql`${activityLog.runId} in (select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.agentId} = ${id})`,
          ),
        );
        await tx.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.actorAgentId, id));
        await tx.delete(issueComments).where(eq(issueComments.authorAgentId, id));
        await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, id));
        await tx.delete(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, id));
        await tx.delete(agentApiKeys).where(eq(agentApiKeys.agentId, id));
        await tx.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, id));
        const deleted = await tx
          .delete(agents)
          .where(eq(agents.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        return deleted ? normalizeAgentRow(deleted) : null;
      });
    },

    activatePendingApproval: async (id: string) => {
      const updated = await db
        .update(agents)
        .set({ status: "idle", updatedAt: new Date() })
        .where(and(eq(agents.id, id), eq(agents.status, "pending_approval")))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        return { agent: normalizeAgentRow(updated), activated: true };
      }

      const existing = await getById(id);
      return existing ? { agent: existing, activated: false } : null;
    },

    updatePermissions: async (id: string, permissions: { canCreateAgents: boolean }) => {
      const existing = await getById(id);
      if (!existing) return null;

      const updated = await db
        .update(agents)
        .set({
          permissions: normalizeAgentPermissions(permissions, existing.role),
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);

      return updated ? normalizeAgentRow(updated) : null;
    },

    listConfigRevisions: async (id: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(eq(agentConfigRevisions.agentId, id))
        .orderBy(desc(agentConfigRevisions.createdAt)),

    getConfigRevision: async (id: string, revisionId: string) =>
      db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null),

    rollbackConfigRevision: async (
      id: string,
      revisionId: string,
      actor: { agentId?: string | null; userId?: string | null },
    ) => {
      const revision = await db
        .select()
        .from(agentConfigRevisions)
        .where(and(eq(agentConfigRevisions.agentId, id), eq(agentConfigRevisions.id, revisionId)))
        .then((rows) => rows[0] ?? null);
      if (!revision) return null;
      if (containsRedactedMarker(revision.afterConfig)) {
        throw unprocessable("Cannot roll back a revision that contains redacted secret values");
      }

      const patch = configPatchFromSnapshot(revision.afterConfig);
      return updateAgent(id, patch, {
        recordRevision: {
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          source: "rollback",
          rolledBackFromRevisionId: revision.id,
        },
      });
    },

    createApiKey: async (id: string, name: string) => {
      const token = createToken();
      const keyHash = hashToken(token);
      const created = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const existing = await txDb
          .select({ id: agents.id, companyId: agents.companyId, status: agents.status })
          .from(agents)
          .where(eq(agents.id, id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!existing) throw notFound("Agent not found");
        if (existing.status === "pending_approval") {
          throw conflict("Cannot create keys for pending approval agents");
        }
        if (existing.status === "terminated") {
          throw conflict("Cannot create keys for terminated agents");
        }

        return txDb
          .insert(agentApiKeys)
          .values({
            agentId: id,
            companyId: existing.companyId,
            name,
            keyHash,
          })
          .returning()
          .then((rows) => rows[0]);
      });

      return {
        id: created.id,
        name: created.name,
        token,
        createdAt: created.createdAt,
      };
    },

    listKeys: (id: string) =>
      db
        .select({
          id: agentApiKeys.id,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, id)),

    getKeyById: async (keyId: string) =>
      db
        .select({
          id: agentApiKeys.id,
          agentId: agentApiKeys.agentId,
          companyId: agentApiKeys.companyId,
          name: agentApiKeys.name,
          createdAt: agentApiKeys.createdAt,
          revokedAt: agentApiKeys.revokedAt,
        })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.id, keyId))
        .then((rows) => rows[0] ?? null),

    revokeKey: async (agentId: string, keyId: string) => {
      const rows = await db
        .update(agentApiKeys)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, agentId)))
        .returning();
      return rows[0] ?? null;
    },

    orgForCompany: async (companyId: string) => {
      const rows = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
      const normalizedRows = rows.map(normalizeAgentRow);
      const byManager = new Map<string | null, typeof normalizedRows>();
      for (const row of normalizedRows) {
        const key = row.reportsTo ?? null;
        const group = byManager.get(key) ?? [];
        group.push(row);
        byManager.set(key, group);
      }

      const build = (managerId: string | null): Array<Record<string, unknown>> => {
        const members = byManager.get(managerId) ?? [];
        return members.map((member) => ({
          ...member,
          reports: build(member.id),
        }));
      };

      return build(null);
    },

    getChainOfCommand: async (agentId: string) => {
      const chain: { id: string; name: string; role: string; title: string | null }[] = [];
      const visited = new Set<string>([agentId]);
      const start = await getById(agentId);
      let currentId = start?.reportsTo ?? null;
      while (currentId && !visited.has(currentId) && chain.length < 50) {
        visited.add(currentId);
        const mgr = await getById(currentId);
        if (!mgr) break;
        chain.push({ id: mgr.id, name: mgr.name, role: mgr.role, title: mgr.title ?? null });
        currentId = mgr.reportsTo ?? null;
      }
      return chain;
    },

    runningForAgent: (agentId: string) =>
      db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"]))),

    listQueuedTerminationRecoveryOwnerIds: async (companyId: string, terminatedAgentId: string) =>
      db
        .select({ agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "queued"),
            sql`${heartbeatRuns.contextSnapshot} ->> 'terminatedAgentId' = ${terminatedAgentId}`,
          ),
        )
        .then((rows) => [...new Set(rows.map((row) => row.agentId))]),

    resolveByReference: async (companyId: string, reference: string) => {
      const raw = reference.trim();
      if (raw.length === 0) {
        return { agent: null, ambiguous: false } as const;
      }

      if (isUuidLike(raw)) {
        const byId = await getById(raw);
        if (!byId || byId.companyId !== companyId) {
          return { agent: null, ambiguous: false } as const;
        }
        return { agent: byId, ambiguous: false } as const;
      }

      const urlKey = normalizeAgentUrlKey(raw);
      if (!urlKey) {
        return { agent: null, ambiguous: false } as const;
      }

      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      const matches = rows
        .map(normalizeAgentRow)
        .filter((agent) => agent.urlKey === urlKey && agent.status !== "terminated");
      if (matches.length === 1) {
        return { agent: matches[0] ?? null, ambiguous: false } as const;
      }
      if (matches.length > 1) {
        return { agent: null, ambiguous: true } as const;
      }
      return { agent: null, ambiguous: false } as const;
    },
  };
}
