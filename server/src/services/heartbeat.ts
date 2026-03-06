import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  costEvents,
  issueLabels,
  issues,
  labels,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, asString, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { secretService } from "./secrets.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { getNotifications } from "./notifications.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const DEFERRED_COMPANY_PAUSED_REASON_KEY = "_paperclipDeferredReason";
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const BOOT_MARKER_RELATIVE_PATH = ".paperclip/runtime/boot-marker.json";
const SAFE_HTTP_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const STUCK_RUN_SWEEPER_ACTOR_ID = "heartbeat_stuck_run_sweeper";
const STUCK_RUN_DEFAULT_QUEUED_THRESHOLD_MS = 20 * 60 * 1000;
const STUCK_RUN_DEFAULT_RUNNING_NO_PROGRESS_THRESHOLD_MS = 20 * 60 * 1000;
const STUCK_RUN_DEFAULT_RECOVERY_WINDOW_MS = 60 * 60 * 1000;
const STUCK_RUN_DEFAULT_MAX_AUTO_REQUEUES = 2;
const SENSITIVE_LABEL_TOKENS = [
  "prod",
  "production",
  "deploy",
  "payment",
  "billing",
  "database",
  "secret",
  "token",
];

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

async function withAgentStartLock<T>(agentId: string, fn: () => Promise<T>) {
  const previous = startLocksByAgent.get(agentId) ?? Promise.resolve();
  const run = previous.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  startLocksByAgent.set(agentId, marker);
  try {
    return await run;
  } finally {
    if (startLocksByAgent.get(agentId) === marker) {
      startLocksByAgent.delete(agentId);
    }
  }
}

interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
}

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

export interface StuckRunSweepThresholds {
  queuedThresholdMs: number;
  runningNoProgressThresholdMs: number;
}

export interface StuckRunEvaluationInput {
  status: string;
  now: Date;
  queuedReferenceAt: Date | null;
  runningReferenceAt: Date | null;
  thresholds: StuckRunSweepThresholds;
}

export interface StuckRunEvaluation {
  reason: "queued_stale" | "running_no_progress";
  staleForMs: number;
  referenceAt: Date;
}

export type StuckRunRecoveryAction =
  | { action: "already_requeued"; nextAttempt: number | null; circuitOpen: false }
  | { action: "enqueue_recovery"; nextAttempt: number; circuitOpen: false }
  | { action: "circuit_open"; nextAttempt: number; circuitOpen: true };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseIssueAssigneeAdapterOverrides(
  raw: unknown,
): ParsedIssueAssigneeAdapterOverrides | null {
  const parsed = parseObject(raw);
  const parsedAdapterConfig = parseObject(parsed.adapterConfig);
  const adapterConfig =
    Object.keys(parsedAdapterConfig).length > 0 ? parsedAdapterConfig : null;
  const useProjectWorkspace =
    typeof parsed.useProjectWorkspace === "boolean"
      ? parsed.useProjectWorkspace
      : null;
  if (!adapterConfig && useProjectWorkspace === null) return null;
  return {
    adapterConfig,
    useProjectWorkspace,
  };
}

function deriveTaskKey(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.taskKey) ??
    readNonEmptyString(contextSnapshot?.taskId) ??
    readNonEmptyString(contextSnapshot?.issueId) ??
    readNonEmptyString(payload?.taskKey) ??
    readNonEmptyString(payload?.taskId) ??
    readNonEmptyString(payload?.issueId) ??
    null
  );
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  return (
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

function enrichWakeContextSnapshot(input: {
  contextSnapshot: Record<string, unknown>;
  reason: string | null;
  source: WakeupOptions["source"];
  triggerDetail: WakeupOptions["triggerDetail"] | null;
  payload: Record<string, unknown> | null;
}) {
  const { contextSnapshot, reason, source, triggerDetail, payload } = input;
  const issueIdFromPayload = readNonEmptyString(payload?.["issueId"]);
  const commentIdFromPayload = readNonEmptyString(payload?.["commentId"]);
  const taskKey = deriveTaskKey(contextSnapshot, payload);
  const wakeCommentId = deriveCommentId(contextSnapshot, payload);

  if (!readNonEmptyString(contextSnapshot["wakeReason"]) && reason) {
    contextSnapshot.wakeReason = reason;
  }
  if (!readNonEmptyString(contextSnapshot["issueId"]) && issueIdFromPayload) {
    contextSnapshot.issueId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskId"]) && issueIdFromPayload) {
    contextSnapshot.taskId = issueIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["taskKey"]) && taskKey) {
    contextSnapshot.taskKey = taskKey;
  }
  if (!readNonEmptyString(contextSnapshot["commentId"]) && commentIdFromPayload) {
    contextSnapshot.commentId = commentIdFromPayload;
  }
  if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
    contextSnapshot.wakeCommentId = wakeCommentId;
  }
  if (!readNonEmptyString(contextSnapshot["wakeSource"]) && source) {
    contextSnapshot.wakeSource = source;
  }
  if (!readNonEmptyString(contextSnapshot["wakeTriggerDetail"]) && triggerDetail) {
    contextSnapshot.wakeTriggerDetail = triggerDetail;
  }

  return {
    contextSnapshot,
    issueIdFromPayload,
    commentIdFromPayload,
    taskKey,
    wakeCommentId,
  };
}

function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const commentId = deriveCommentId(incoming, null);
  if (commentId) {
    merged.commentId = commentId;
    merged.wakeCommentId = commentId;
  }
  return merged;
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  return (left ?? null) === (right ?? null);
}

function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function asPositiveInteger(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.floor(numeric);
  return rounded > 0 ? rounded : null;
}

function resolveStuckRunSweepThresholds(opts?: {
  queuedThresholdMs?: number;
  runningNoProgressThresholdMs?: number;
}) {
  const queuedThresholdMs =
    opts?.queuedThresholdMs != null
      ? Math.max(1_000, Math.floor(opts.queuedThresholdMs))
      : Math.max(
        1_000,
        (asPositiveInteger(process.env.PAPERCLIP_STUCK_RUN_QUEUED_THRESHOLD_SEC) ??
          STUCK_RUN_DEFAULT_QUEUED_THRESHOLD_MS / 1_000) * 1_000,
      );
  const runningNoProgressThresholdMs =
    opts?.runningNoProgressThresholdMs != null
      ? Math.max(1_000, Math.floor(opts.runningNoProgressThresholdMs))
      : Math.max(
        1_000,
        (asPositiveInteger(process.env.PAPERCLIP_STUCK_RUN_RUNNING_NO_PROGRESS_THRESHOLD_SEC) ??
          STUCK_RUN_DEFAULT_RUNNING_NO_PROGRESS_THRESHOLD_MS / 1_000) * 1_000,
      );
  return {
    queuedThresholdMs,
    runningNoProgressThresholdMs,
  };
}

function latestTimestamp(values: Array<Date | null | undefined>) {
  let latest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    if (!latest || value.getTime() > latest.getTime()) {
      latest = value;
    }
  }
  return latest;
}

export function evaluateStuckRun(input: StuckRunEvaluationInput): StuckRunEvaluation | null {
  const { status, now, queuedReferenceAt, runningReferenceAt, thresholds } = input;

  if (status === "queued" && queuedReferenceAt) {
    const staleForMs = now.getTime() - queuedReferenceAt.getTime();
    if (staleForMs >= thresholds.queuedThresholdMs) {
      return {
        reason: "queued_stale",
        staleForMs,
        referenceAt: queuedReferenceAt,
      };
    }
    return null;
  }

  if (status === "running" && runningReferenceAt) {
    const staleForMs = now.getTime() - runningReferenceAt.getTime();
    if (staleForMs >= thresholds.runningNoProgressThresholdMs) {
      return {
        reason: "running_no_progress",
        staleForMs,
        referenceAt: runningReferenceAt,
      };
    }
  }

  return null;
}

export function decideStuckRunRecoveryAction(input: {
  recentAutoRequeues: number;
  maxAutoRequeues: number;
  hasPromotedDeferredRun: boolean;
}): StuckRunRecoveryAction {
  if (input.hasPromotedDeferredRun) {
    return {
      action: "already_requeued",
      nextAttempt: null,
      circuitOpen: false,
    };
  }
  const nextAttempt = Math.max(1, input.recentAutoRequeues + 1);
  if (nextAttempt > Math.max(1, input.maxAutoRequeues)) {
    return {
      action: "circuit_open",
      nextAttempt,
      circuitOpen: true,
    };
  }
  return {
    action: "enqueue_recovery",
    nextAttempt,
    circuitOpen: false,
  };
}

function buildFailurePlaybook(errorCode: string | null) {
  const normalized = (errorCode ?? "").trim();
  switch (normalized) {
    case "process_lost":
      return {
        playbookId: "process_lost_recovery",
        recommendedAction: "Collect host diagnostics and resume the interrupted run.",
      };
    case "claude_auth_required":
      return {
        playbookId: "claude_auth_required",
        recommendedAction: "Run Claude login for this agent, then retry the run.",
      };
    case "timeout":
      return {
        playbookId: "run_timeout",
        recommendedAction: "Split scope or raise timeout using project guardrails.",
      };
    case "adapter_failed":
      return {
        playbookId: "adapter_failed_triage",
        recommendedAction: "Inspect stderr/result payload and retry with tighter scope.",
      };
    case "agent_not_found":
      return {
        playbookId: "agent_not_found_reconcile",
        recommendedAction: "Reconcile agent assignment/configuration, then requeue the run.",
      };
    case "safe_mode_external_mutation_blocked":
      return {
        playbookId: "safe_mode_external_mutation_blocked",
        recommendedAction: "Disable safe mode for this run or switch to a read-only adapter flow.",
      };
    case "cancelled":
      return {
        playbookId: "run_cancelled",
        recommendedAction: "No action required unless cancellation was unexpected.",
      };
    default:
      return {
        playbookId: "generic_run_failure",
        recommendedAction: "Inspect run logs and follow the incident checklist.",
      };
  }
}

function mergeFailureRecommendationResult(
  existingResultJson: Record<string, unknown> | null,
  errorCode: string | null,
  extraOps?: Record<string, unknown>,
) {
  const playbook = buildFailurePlaybook(errorCode);
  const resultJson = parseObject(existingResultJson);
  const existingOps = parseObject(resultJson.paperclipOps);
  resultJson.paperclipOps = {
    ...existingOps,
    playbookId: playbook.playbookId,
    recommendedAction: playbook.recommendedAction,
    errorCode,
    recommendedAt: new Date().toISOString(),
    ...(extraOps ?? {}),
  };
  return {
    resultJson,
    playbook,
  };
}

async function safeReadJsonFile(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseObject(parsed);
  } catch {
    return null;
  }
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function heartbeatService(db: Db) {
  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const issuesSvc = issueService(db);

  async function resolveProjectIdFromContext(companyId: string, contextSnapshot: Record<string, unknown>) {
    const contextProjectId = readNonEmptyString(contextSnapshot.projectId);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (issueId) {
      const issueProjectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
      if (issueProjectId) return issueProjectId;
    }
    return contextProjectId;
  }

  async function resolveProjectRunGuardrails(companyId: string, projectId: string | null) {
    if (!projectId) {
      return {
        projectId: null,
        projectName: null,
        maxConcurrentRuns: null,
        timeoutSec: null,
        safeModeDefault: false,
      };
    }

    const project = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!project) {
      return {
        projectId: null,
        projectName: null,
        maxConcurrentRuns: null,
        timeoutSec: null,
        safeModeDefault: false,
      };
    }

    const workspaces = await db
      .select({
        metadata: projectWorkspaces.metadata,
        isPrimary: projectWorkspaces.isPrimary,
        createdAt: projectWorkspaces.createdAt,
      })
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, project.id)))
      .orderBy(sql`${projectWorkspaces.isPrimary} desc`, asc(projectWorkspaces.createdAt));

    let runGuardrails: Record<string, unknown> | null = null;
    for (const workspace of workspaces) {
      const metadata = parseObject(workspace.metadata);
      const parsedGuardrails = parseObject(metadata.runGuardrails);
      if (Object.keys(parsedGuardrails).length > 0) {
        runGuardrails = parsedGuardrails;
        break;
      }
    }

    return {
      projectId: project.id,
      projectName: project.name,
      maxConcurrentRuns: asPositiveInteger(runGuardrails?.maxConcurrentRuns ?? null),
      timeoutSec: asPositiveInteger(runGuardrails?.timeoutSec ?? null),
      safeModeDefault: runGuardrails?.safeModeDefault === true,
    };
  }

  async function countRunningRunsForProject(companyId: string, projectId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "running"),
          sql`(
            coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', '') = ${projectId}
            or exists (
              select 1 from ${issues}
              where ${issues.companyId} = ${heartbeatRuns.companyId}
                and ${issues.id}::text = (${heartbeatRuns.contextSnapshot} ->> 'issueId')
                and ${issues.projectId} = ${projectId}
            )
          )`,
        ),
      );
    return Number(count ?? 0);
  }

  async function issueLooksSensitive(companyId: string, issueId: string | null) {
    if (!issueId) return false;
    const rows = await db
      .select({ name: labels.name })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.issueId, issueId)));
    return rows.some((row) => {
      const lower = row.name.toLowerCase();
      return SENSITIVE_LABEL_TOKENS.some((token) => lower.includes(token));
    });
  }

  function buildBootMarkerPath() {
    const explicit = process.env.PAPERCLIP_BOOT_MARKER_FILE;
    if (explicit && explicit.trim().length > 0) return explicit.trim();
    return path.resolve(process.cwd(), BOOT_MARKER_RELATIVE_PATH);
  }

  async function readCurrentBootEvidence() {
    const bootId = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const uptimeRaw = (await fs.readFile("/proc/uptime", "utf8")).trim();
    const uptimeSec = Number.parseFloat(uptimeRaw.split(" ")[0] ?? "0");
    return {
      bootId,
      uptimeSec: Number.isFinite(uptimeSec) ? uptimeSec : 0,
      checkedAt: new Date().toISOString(),
    };
  }

  async function createOpsIncidentIssue(input: {
    companyId: string;
    title: string;
    description: string;
    priority?: "low" | "medium" | "high" | "critical";
  }) {
    async function resolveLegacyOpsIncidentAssignee(companyId: string) {
      const roster = await db
        .select({
          id: agents.id,
          role: agents.role,
          status: agents.status,
          reportsTo: agents.reportsTo,
          createdAt: agents.createdAt,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .orderBy(asc(agents.createdAt));

      if (roster.length === 0) return null;

      const eligible = roster.filter((agent) => agent.status !== "terminated" && agent.status !== "pending_approval");
      if (eligible.length === 0) return null;

      const roots = eligible.filter((agent) => agent.reportsTo == null);
      const rootPool = roots.length > 0 ? roots : eligible;
      const activeRoots = rootPool.filter((agent) => agent.status !== "paused");
      const basePool = activeRoots.length > 0 ? activeRoots : rootPool;

      const ceo = basePool.find((agent) => agent.role === "ceo");
      return (ceo ?? basePool[0] ?? null)?.id ?? null;
    }

    const recentDuplicate = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.title, input.title),
          sql`${issues.createdAt} >= now() - interval '2 hours'`,
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (recentDuplicate) return recentDuplicate.id;

    const preferredRoles = ["devops", "sre", "platform", "engineer", "founding engineer", "cto"];
    const balancing = await issuesSvc.selectBalancedAssignee({
      companyId: input.companyId,
      priority: input.priority ?? "high",
      targetStatus: "todo",
      preferredRoles,
      excludeRoles: ["ceo"],
    });
    const legacyAssigneeAgentId = await resolveLegacyOpsIncidentAssignee(input.companyId);
    const assigneeAgentId =
      balancing.mode === "auto"
        ? balancing.selectedAgentId ?? legacyAssigneeAgentId
        : legacyAssigneeAgentId;

    try {
      const created = await issuesSvc.create(
        input.companyId,
        {
          title: input.title,
          description: input.description,
          // Prefer assigned todo incidents so ops ownership is explicit.
          status: assigneeAgentId ? "todo" : "backlog",
          priority: input.priority ?? "high",
          assigneeAgentId,
          createdByUserId: "system",
        },
        assigneeAgentId
          ? {
            skipAssignmentTemplateValidation: true,
            skipAssigneeWipCapValidation: true,
            forceAssignment: true,
          }
          : undefined,
      );
      if (balancing.mode !== "disabled" && balancing.topCandidates.length > 0) {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: "system",
          actorId: "heartbeat_ops_incident_balancer",
          action: "issue.auto_assignment_selected",
          entityType: "issue",
          entityId: created.id,
          details: {
            source: "ops_incident",
            mode: balancing.mode,
            selectedAgentId: balancing.selectedAgentId,
            selectedAgentName: balancing.selectedAgentName,
            appliedAssigneeAgentId: assigneeAgentId,
            fallbackAssigneeAgentId: legacyAssigneeAgentId,
            preferredRoles,
            candidatesEvaluated: balancing.candidatesEvaluated,
            topCandidates: balancing.topCandidates,
            excludedCandidates: balancing.excludedCandidates,
          },
        });
      }
      return created.id;
    } catch (err) {
      if (!assigneeAgentId) throw err;
      const duplicateIssueId = (() => {
        if (!err || typeof err !== "object") return null;
        const rec = err as { status?: unknown; details?: unknown };
        if (rec.status !== 409) return null;
        if (!rec.details || typeof rec.details !== "object") return null;
        const issueId = (rec.details as Record<string, unknown>).issueId;
        return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
      })();
      if (duplicateIssueId) return duplicateIssueId;
      logger.warn(
        { err, companyId: input.companyId, title: input.title, assigneeAgentId },
        "failed to create assigned ops incident; retrying unassigned backlog",
      );
      const fallback = await issuesSvc.create(input.companyId, {
        title: input.title,
        description: input.description,
        status: "backlog",
        priority: input.priority ?? "high",
        createdByUserId: "system",
      });
      return fallback.id;
    }
  }

  async function appendFailureRecommendationEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    errorCode: string | null,
    extraPayload?: Record<string, unknown>,
  ) {
    const playbook = buildFailurePlaybook(errorCode);
    await appendRunEvent(run, seq, {
      eventType: "ops.recommendation",
      stream: "system",
      level: "warn",
      message: playbook.recommendedAction,
      payload: {
        playbookId: playbook.playbookId,
        errorCode,
        recommendedAction: playbook.recommendedAction,
        ...(extraPayload ?? {}),
      },
    });
  }

  async function updateRunContextSnapshot(
    runId: string,
    contextSnapshot: Record<string, unknown>,
    opts?: { touchUpdatedAt?: boolean },
  ) {
    const patch = opts?.touchUpdatedAt === false
      ? { contextSnapshot }
      : { contextSnapshot, updatedAt: new Date() };
    await db
      .update(heartbeatRuns)
      .set(patch)
      .where(eq(heartbeatRuns.id, runId));
  }

  function applySafeModeConfiguration(
    adapterType: string,
    baseConfig: Record<string, unknown>,
    safeMode: {
      enabled: boolean;
      reason: string;
      reasons: string[];
      source: string;
      projectId: string | null;
      projectName: string | null;
      issueId: string | null;
    },
  ) {
    if (!safeMode.enabled) return baseConfig;

    const safeModeDirective =
      `Paperclip Safe Mode is active (${safeMode.reason}). ` +
      "Operate in read-only planning mode unless explicitly told otherwise, " +
      "do not deploy, do not mutate external systems, and avoid destructive shell commands.";
    const envPatch: Record<string, string> = {
      PAPERCLIP_SAFE_MODE: "1",
      PAPERCLIP_SAFE_MODE_REASON: safeMode.reason,
      PAPERCLIP_SAFE_MODE_REASONS: safeMode.reasons.join(","),
      PAPERCLIP_SAFE_MODE_SOURCE: safeMode.source,
    };
    if (safeMode.projectId) envPatch.PAPERCLIP_SAFE_MODE_PROJECT_ID = safeMode.projectId;
    if (safeMode.projectName) envPatch.PAPERCLIP_SAFE_MODE_PROJECT_NAME = safeMode.projectName;
    if (safeMode.issueId) envPatch.PAPERCLIP_SAFE_MODE_ISSUE_ID = safeMode.issueId;

    const merged = { ...baseConfig };
    const existingEnv = parseObject(merged.env);
    merged.env = {
      ...existingEnv,
      ...envPatch,
    };

    if (adapterType === "claude_local" || adapterType === "codex_local") {
      const existingPromptTemplate = asString(
        merged.promptTemplate,
        "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
      );
      merged.promptTemplate = `${safeModeDirective}\n\n${existingPromptTemplate}`;
    }

    if (adapterType === "claude_local") {
      merged.dangerouslySkipPermissions = false;
    }
    if (adapterType === "codex_local") {
      merged.dangerouslyBypassApprovalsAndSandbox = false;
      merged.dangerouslyBypassSandbox = false;
    }
    return merged;
  }

  function shouldBlockExternalMutableAdapterInSafeMode(
    adapterType: string,
    config: Record<string, unknown>,
    safeModeEnabled: boolean,
  ) {
    if (!safeModeEnabled) return false;
    const allowMutable = asBoolean(
      config.allowExternalMutableInSafeMode ?? config.allowExternalWritesInSafeMode,
      false,
    );
    if (allowMutable) return false;

    if (adapterType === "http" || adapterType === "openclaw") {
      const method = asString(config.method, "POST").toUpperCase();
      return !SAFE_HTTP_READ_METHODS.has(method);
    }
    return false;
  }

  async function reportHostBootIncident() {
    const markerPath = buildBootMarkerPath();
    const current = await readCurrentBootEvidence();
    const previous = await safeReadJsonFile(markerPath);

    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(
      markerPath,
      JSON.stringify(
        {
          ...current,
          pid: process.pid,
          recordedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    if (!previous) {
      return { incidentCreated: false as const, kind: "first_seen" as const };
    }

    const previousBootId = readNonEmptyString(previous.bootId);
    if (!previousBootId) {
      return { incidentCreated: false as const, kind: "marker_invalid" as const };
    }

    const previousCheckedAt = readNonEmptyString(previous.checkedAt) ?? readNonEmptyString(previous.recordedAt);
    const previousUptimeSec = asPositiveInteger(previous.uptimeSec);
    const isHostReboot = previousBootId !== current.bootId;
    const kind = isHostReboot ? "host_reboot" : "process_restart";

    const affectedCompanies = await db
      .selectDistinct({ companyId: heartbeatRuns.companyId })
      .from(heartbeatRuns)
      .where(
        sql`${heartbeatRuns.createdAt} >= now() - interval '12 hours'`,
      );

    for (const company of affectedCompanies) {
      const title = isHostReboot
        ? "Ops incident: host reboot detected"
        : "Ops incident: server process restart detected";
      const description = [
        "Paperclip detected a runtime restart from boot marker evidence.",
        "",
        `- kind: ${kind}`,
        `- previousBootId: ${previousBootId}`,
        `- currentBootId: ${current.bootId}`,
        `- previousCheckedAt: ${previousCheckedAt ?? "unknown"}`,
        `- currentCheckedAt: ${current.checkedAt}`,
        `- previousUptimeSec: ${previousUptimeSec ?? "unknown"}`,
        `- currentUptimeSec: ${Math.floor(current.uptimeSec)}`,
        "",
        "Follow-up:",
        "1. Confirm if this restart was planned.",
        "2. Inspect recent process_lost heartbeat runs and recover interrupted tasks.",
      ].join("\n");
      await createOpsIncidentIssue({
        companyId: company.companyId,
        title,
        description,
        priority: isHostReboot ? "high" : "medium",
      });
    }

    return {
      incidentCreated: affectedCompanies.length > 0,
      affectedCompanies: affectedCompanies.length,
      kind,
    };
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getCompany(companyId: string) {
    return db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRuntimeState(agentId: string) {
    return db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getTaskSession(
    companyId: string,
    agentId: string,
    adapterType: string,
    taskKey: string,
  ) {
    return db
      .select()
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, companyId),
          eq(agentTaskSessions.agentId, agentId),
          eq(agentTaskSessions.adapterType, adapterType),
          eq(agentTaskSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    if (taskKey) {
      const codec = getAdapterSessionCodec(agent.adapterType);
      const existingTaskSession = await getTaskSession(
        agent.companyId,
        agent.id,
        agent.adapterType,
        taskKey,
      );
      const parsedParams = normalizeSessionParams(
        codec.deserialize(existingTaskSession?.sessionParamsJson ?? null),
      );
      return truncateDisplayId(
        existingTaskSession?.sessionDisplayId ??
          (codec.getDisplayId ? codec.getDisplayId(parsedParams) : null) ??
          readNonEmptyString(parsedParams?.sessionId),
      );
    }

    const runtimeForRun = await getRuntimeState(agent.id);
    return runtimeForRun?.sessionId ?? null;
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ) {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const issueProjectId = issueId
      ? await db
          .select({ projectId: issues.projectId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0]?.projectId ?? null)
      : null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const projectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      for (const workspace of projectWorkspaceRows) {
        const projectCwd = readNonEmptyString(workspace.cwd);
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          continue;
        }
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
          };
        }
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
      };
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    if (sessionCwd) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
    };
  }

  async function upsertTaskSession(input: {
    companyId: string;
    agentId: string;
    adapterType: string;
    taskKey: string;
    sessionParamsJson: Record<string, unknown> | null;
    sessionDisplayId: string | null;
    lastRunId: string | null;
    lastError: string | null;
  }) {
    const existing = await getTaskSession(
      input.companyId,
      input.agentId,
      input.adapterType,
      input.taskKey,
    );
    if (existing) {
      return db
        .update(agentTaskSessions)
        .set({
          sessionParamsJson: input.sessionParamsJson,
          sessionDisplayId: input.sessionDisplayId,
          lastRunId: input.lastRunId,
          lastError: input.lastError,
          updatedAt: new Date(),
        })
        .where(eq(agentTaskSessions.id, existing.id))
        .returning()
        .then((rows) => rows[0] ?? null);
    }

    return db
      .insert(agentTaskSessions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        taskKey: input.taskKey,
        sessionParamsJson: input.sessionParamsJson,
        sessionDisplayId: input.sessionDisplayId,
        lastRunId: input.lastRunId,
        lastError: input.lastError,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearTaskSessions(
    companyId: string,
    agentId: string,
    opts?: { taskKey?: string | null; adapterType?: string | null },
  ) {
    const conditions = [
      eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId),
    ];
    if (opts?.taskKey) {
      conditions.push(eq(agentTaskSessions.taskKey, opts.taskKey));
    }
    if (opts?.adapterType) {
      conditions.push(eq(agentTaskSessions.adapterType, opts.adapterType));
    }

    return db
      .delete(agentTaskSessions)
      .where(and(...conditions))
      .returning()
      .then((rows) => rows.length);
  }

  async function ensureRuntimeState(agent: typeof agents.$inferSelect) {
    const existing = await getRuntimeState(agent.id);
    if (existing) return existing;

    return db
      .insert(agentRuntimeState)
      .values({
        agentId: agent.id,
        companyId: agent.companyId,
        adapterType: agent.adapterType,
        stateJson: {},
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setRunStatus(
    runId: string,
    status: string,
    patch?: Partial<typeof heartbeatRuns.$inferInsert>,
  ) {
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: updated.id,
          agentId: updated.agentId,
          status: updated.status,
          invocationSource: updated.invocationSource,
          triggerDetail: updated.triggerDetail,
          error: updated.error ?? null,
          errorCode: updated.errorCode ?? null,
          startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
          finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
        },
      });
    }

    return updated;
  }

  async function setWakeupStatus(
    wakeupRequestId: string | null | undefined,
    status: string,
    patch?: Partial<typeof agentWakeupRequests.$inferInsert>,
  ) {
    if (!wakeupRequestId) return;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
  }

  async function appendRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    seq: number,
    event: {
      eventType: string;
      stream?: "system" | "stdout" | "stderr";
      level?: "info" | "warn" | "error";
      color?: string;
      message?: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: event.message,
      payload: event.payload,
    });

    publishLiveEvent({
      companyId: run.companyId,
      type: "heartbeat.run.event",
      payload: {
        runId: run.id,
        agentId: run.agentId,
        seq,
        eventType: event.eventType,
        stream: event.stream ?? null,
        level: event.level ?? null,
        color: event.color ?? null,
        message: event.message ?? null,
        payload: event.payload ?? null,
      },
    });
  }

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      skipIfNoAssignments: asBoolean(
        heartbeat.skipIfNoAssignments ?? heartbeat.skipIfNoTasks,
        false,
      ),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      autoRestart: asBoolean(heartbeat.autoRestart, false),
    };
  }

  async function hasOpenAssignments(agent: typeof agents.$inferSelect) {
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          inArray(issues.status, ["todo", "in_progress", "blocked"]),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return Number(count ?? 0);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const claimedAt = new Date();
    const claimed = await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? claimedAt,
        updatedAt: claimedAt,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;

    publishLiveEvent({
      companyId: claimed.companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: claimed.id,
        agentId: claimed.agentId,
        status: claimed.status,
        invocationSource: claimed.invocationSource,
        triggerDetail: claimed.triggerDetail,
        error: claimed.error ?? null,
        errorCode: claimed.errorCode ?? null,
        startedAt: claimed.startedAt ? new Date(claimed.startedAt).toISOString() : null,
        finishedAt: claimed.finishedAt ? new Date(claimed.finishedAt).toISOString() : null,
      },
    });

    await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    return claimed;
  }

  async function finalizeAgentStatus(
    agentId: string,
    outcome: "succeeded" | "failed" | "cancelled" | "timed_out",
  ) {
    const existing = await getAgent(agentId);
    if (!existing) return;

    if (existing.status === "paused" || existing.status === "terminated") {
      return;
    }

    const runningCount = await countRunningRunsForAgent(agentId);
    const nextStatus =
      runningCount > 0
        ? "running"
        : outcome === "succeeded" || outcome === "cancelled"
          ? "idle"
          : "error";

    const updated = await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      publishLiveEvent({
        companyId: updated.companyId,
        type: "agent.status",
        payload: {
          agentId: updated.id,
          status: updated.status,
          lastHeartbeatAt: updated.lastHeartbeatAt
            ? new Date(updated.lastHeartbeatAt).toISOString()
            : null,
          outcome,
        },
      });
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    const staleThresholdMs = opts?.staleThresholdMs ?? 0;
    const now = new Date();

    // Find all runs in "queued" or "running" state
    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));

    const reaped: string[] = [];
    const reapedByCompany = new Map<
      string,
      Array<{ runId: string; agentId: string; status: string; wakeupRequestId: string | null }>
    >();

    for (const run of activeRuns) {
      if (runningProcesses.has(run.id)) continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const failureRecommendation = mergeFailureRecommendationResult(run.resultJson ?? null, "process_lost");
      await setRunStatus(run.id, "failed", {
        error: "Process lost -- server may have restarted",
        errorCode: "process_lost",
        finishedAt: now,
        resultJson: failureRecommendation.resultJson,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: "Process lost -- server may have restarted",
      });
      const updatedRun = await getRun(run.id);
      if (updatedRun) {
        await appendRunEvent(updatedRun, 1, {
          eventType: "ops.recommendation",
          stream: "system",
          level: "warn",
          message: failureRecommendation.playbook.recommendedAction,
          payload: {
            playbookId: failureRecommendation.playbook.playbookId,
            errorCode: "process_lost",
            recommendedAction: failureRecommendation.playbook.recommendedAction,
          },
        });
        await appendRunEvent(updatedRun, 2, {
          eventType: "lifecycle",
          stream: "system",
          level: "error",
          message: "Process lost -- server may have restarted",
        });
        await releaseIssueExecutionAndPromote(updatedRun);
      }
      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
      const bucket = reapedByCompany.get(run.companyId) ?? [];
      bucket.push({
        runId: run.id,
        agentId: run.agentId,
        status: run.status,
        wakeupRequestId: run.wakeupRequestId ?? null,
      });
      reapedByCompany.set(run.companyId, bucket);
    }

    for (const [companyId, companyRuns] of reapedByCompany.entries()) {
      const lines = companyRuns.slice(0, 12).map((entry) =>
        `- runId=${entry.runId} agentId=${entry.agentId} previousStatus=${entry.status} wakeupRequestId=${entry.wakeupRequestId ?? "null"}`,
      );
      const remaining = Math.max(0, companyRuns.length - lines.length);
      if (remaining > 0) {
        lines.push(`- ... ${remaining} more runs omitted`);
      }
      await createOpsIncidentIssue({
        companyId,
        title: "Ops incident: process_lost runs reaped",
        description: [
          `The heartbeat reaper marked ${companyRuns.length} active run(s) as process_lost.`,
          "",
          "Likely causes: server restart, host reboot, or worker crash.",
          "",
          "Affected runs:",
          ...lines,
          "",
          "Recommended follow-up:",
          "1. Validate host/process health and restart reason.",
          "2. Resume or retrigger interrupted work.",
        ].join("\n"),
        priority: "high",
      });
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }
    return { reaped: reaped.length, runIds: reaped };
  }

  async function latestRunEventAt(runId: string) {
    const latest = await db
      .select({ createdAt: heartbeatRunEvents.createdAt })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(desc(heartbeatRunEvents.seq))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return latest?.createdAt ?? null;
  }

  async function countRecentAutoRequeues(input: {
    companyId: string;
    agentId: string;
    recoveryKey: string;
    since: Date;
  }) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.reason, "stuck_run_auto_requeue"),
          gte(agentWakeupRequests.requestedAt, input.since),
          sql`coalesce(${agentWakeupRequests.payload} ->> 'recoveryKey', '') = ${input.recoveryKey}`,
        ),
      );
    return Number(count ?? 0);
  }

  function buildStuckRecoveryComment(input: {
    staleReason: StuckRunEvaluation["reason"];
    staleForMs: number;
    cancelledRunId: string;
    agentId: string;
    requeuedRunId: string | null;
    recoveryAction: StuckRunRecoveryAction["action"];
    maxAutoRequeues: number;
    recoveryWindowMs: number;
  }) {
    const staleMinutes = Math.max(1, Math.round(input.staleForMs / 60_000));
    const reasonLabel =
      input.staleReason === "queued_stale"
        ? "queued run exceeded age threshold"
        : "running run showed no progress signals";
    const lines = [
      "## Recovery Update",
      `Automatic stuck-run recovery triggered (\`${reasonLabel}\`).`,
      "",
      `- Cancelled run: [${input.cancelledRunId}](/agents/${input.agentId}/runs/${input.cancelledRunId})`,
      `- Stale signal age: ${staleMinutes} minute(s)`,
      `- Detection code: \`${input.staleReason}\``,
    ];
    if (input.requeuedRunId) {
      lines.push(
        `- Fresh attempt: [${input.requeuedRunId}](/agents/${input.agentId}/runs/${input.requeuedRunId})`,
      );
    } else if (input.recoveryAction === "circuit_open") {
      lines.push(
        "- Fresh attempt: skipped (circuit breaker open; manual intervention required)",
      );
    } else {
      lines.push("- Fresh attempt: unable to queue automatically");
    }
    lines.push(
      `- Circuit breaker: max ${Math.max(1, input.maxAutoRequeues)} auto-requeue(s) per ${Math.max(1, Math.floor(input.recoveryWindowMs / 60_000))} minute window`,
    );
    return lines.join("\n");
  }

  async function sweepStuckRuns(opts?: {
    queuedThresholdMs?: number;
    runningNoProgressThresholdMs?: number;
    recoveryWindowMs?: number;
    maxAutoRequeues?: number;
    now?: Date;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds = resolveStuckRunSweepThresholds({
      queuedThresholdMs: opts?.queuedThresholdMs,
      runningNoProgressThresholdMs: opts?.runningNoProgressThresholdMs,
    });
    const recoveryWindowMs =
      opts?.recoveryWindowMs != null
        ? Math.max(1_000, Math.floor(opts.recoveryWindowMs))
        : Math.max(
          1_000,
          (asPositiveInteger(process.env.PAPERCLIP_STUCK_RUN_RECOVERY_WINDOW_SEC) ??
            STUCK_RUN_DEFAULT_RECOVERY_WINDOW_MS / 1_000) * 1_000,
        );
    const maxAutoRequeues =
      opts?.maxAutoRequeues != null
        ? Math.max(1, Math.floor(opts.maxAutoRequeues))
        : Math.max(
          1,
          asPositiveInteger(process.env.PAPERCLIP_STUCK_RUN_MAX_AUTO_REQUEUES) ??
            STUCK_RUN_DEFAULT_MAX_AUTO_REQUEUES,
        );

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]))
      .orderBy(asc(heartbeatRuns.createdAt));

    let staleCount = 0;
    let recoveredCount = 0;
    let circuitOpenCount = 0;
    const runIds: string[] = [];

    for (const run of activeRuns) {
      if (run.status === "running" && !runningProcesses.has(run.id)) {
        // Restart/process-loss path is handled by reapOrphanedRuns.
        continue;
      }

      const queuedReferenceAt = latestTimestamp([run.updatedAt, run.createdAt]);
      const eventAt = run.status === "running" ? await latestRunEventAt(run.id) : null;
      const runningReferenceAt = latestTimestamp([eventAt, run.updatedAt, run.startedAt, run.createdAt]);

      const stale = evaluateStuckRun({
        status: run.status,
        now,
        queuedReferenceAt,
        runningReferenceAt,
        thresholds,
      });
      if (!stale) continue;

      staleCount += 1;
      runIds.push(run.id);

      const runContext = parseObject(run.contextSnapshot);
      const issueId = readNonEmptyString(runContext.issueId);
      const taskKey = deriveTaskKey(runContext, null);
      const recoveryKey = issueId ?? taskKey ?? run.id;

      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: STUCK_RUN_SWEEPER_ACTOR_ID,
        agentId: run.agentId,
        runId: run.id,
        action: "heartbeat.stuck_detected",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: {
          status: run.status,
          staleReason: stale.reason,
          staleForMs: stale.staleForMs,
          queuedThresholdMs: thresholds.queuedThresholdMs,
          runningNoProgressThresholdMs: thresholds.runningNoProgressThresholdMs,
          issueId,
          taskKey,
          recoveryKey,
        },
      });

      void (async () => {
        const notif = getNotifications();
        if (!notif) return;
        const agentRow = await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, run.agentId))
          .then((rows) => rows[0] ?? null);
        await notif.notifyStuckRun(run.companyId, {
          runId: run.id,
          agentId: run.agentId,
          agentName: agentRow?.name ?? run.agentId.slice(0, 8),
          staleForMs: stale.staleForMs,
          reason: stale.reason,
          issueId: issueId ?? null,
        });
      })().catch((err) =>
        logger.warn({ err, runId: run.id, agentId: run.agentId }, "Failed to send stuck run notification"),
      );

      const cancelled = await cancelRunByControlPlane(run.id, {
        error: "Cancelled by stuck-run sweeper",
        errorCode: "stuck_run_recovered",
        eventMessage: "run cancelled by stuck-run sweeper",
      });
      if (!cancelled || cancelled.status !== "cancelled") {
        continue;
      }

      const issueSnapshot = issueId
        ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
          .then((rows) => rows[0] ?? null)
        : null;

      const promotedDeferredRunId =
        issueSnapshot?.executionRunId && issueSnapshot.executionRunId !== run.id
          ? issueSnapshot.executionRunId
          : null;
      const recentAutoRequeues = await countRecentAutoRequeues({
        companyId: run.companyId,
        agentId: run.agentId,
        recoveryKey,
        since: new Date(now.getTime() - recoveryWindowMs),
      });

      const recoveryAction = decideStuckRunRecoveryAction({
        recentAutoRequeues,
        maxAutoRequeues,
        hasPromotedDeferredRun: Boolean(promotedDeferredRunId),
      });

      let enqueuedRunId: string | null = null;
      if (recoveryAction.action === "enqueue_recovery") {
        const nextAttempt = recoveryAction.nextAttempt;
        const recoveryContext = {
          ...runContext,
          paperclipRecovery: {
            type: "stuck_run_auto_requeue",
            staleReason: stale.reason,
            staleForMs: stale.staleForMs,
            recoveryKey,
            recoveredFromRunId: run.id,
            attempt: nextAttempt,
            maxAutoRequeues,
            recoveryWindowMs,
            recoveredAt: now.toISOString(),
          },
        };
        const recoveryPayload: Record<string, unknown> = {
          recoveryKey,
          recoveredFromRunId: run.id,
          staleReason: stale.reason,
          staleForMs: stale.staleForMs,
          autoRequeueAttempt: nextAttempt,
        };
        const payloadIssueId = readNonEmptyString(runContext.issueId);
        const payloadTaskId = readNonEmptyString(runContext.taskId);
        const payloadTaskKey = deriveTaskKey(runContext, null);
        if (payloadIssueId) recoveryPayload.issueId = payloadIssueId;
        if (payloadTaskId) recoveryPayload.taskId = payloadTaskId;
        if (payloadTaskKey) recoveryPayload.taskKey = payloadTaskKey;

        const enqueued = await enqueueWakeup(run.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "stuck_run_auto_requeue",
          payload: recoveryPayload,
          requestedByActorType: "system",
          requestedByActorId: STUCK_RUN_SWEEPER_ACTOR_ID,
          contextSnapshot: recoveryContext,
        });
        enqueuedRunId = enqueued?.id ?? null;
      }

      const requeuedRunId = promotedDeferredRunId ?? enqueuedRunId;
      if (requeuedRunId) recoveredCount += 1;
      if (recoveryAction.circuitOpen) circuitOpenCount += 1;

      await logActivity(db, {
        companyId: run.companyId,
        actorType: "system",
        actorId: STUCK_RUN_SWEEPER_ACTOR_ID,
        agentId: run.agentId,
        runId: run.id,
        action: recoveryAction.circuitOpen ? "heartbeat.stuck_recovery_circuit_open" : "heartbeat.stuck_recovered",
        entityType: "heartbeat_run",
        entityId: run.id,
        details: {
          staleReason: stale.reason,
          staleForMs: stale.staleForMs,
          recoveryAction: recoveryAction.action,
          recoveryKey,
          recentAutoRequeues,
          maxAutoRequeues,
          recoveryWindowMs,
          requeuedRunId,
          promotedDeferredRunId,
          issueId,
        },
      });

      if (issueSnapshot) {
        const commentBody = buildStuckRecoveryComment({
          staleReason: stale.reason,
          staleForMs: stale.staleForMs,
          cancelledRunId: run.id,
          agentId: run.agentId,
          requeuedRunId,
          recoveryAction: recoveryAction.action,
          maxAutoRequeues,
          recoveryWindowMs,
        });
        const comment = await issuesSvc.addComment(issueSnapshot.id, commentBody, {});
        await logActivity(db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: STUCK_RUN_SWEEPER_ACTOR_ID,
          agentId: run.agentId,
          runId: run.id,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: issueSnapshot.id,
          details: {
            commentId: comment.id,
            bodySnippet: comment.body.slice(0, 120),
            identifier: issueSnapshot.identifier ?? null,
            issueTitle: issueSnapshot.title,
            recoveryAction: recoveryAction.action,
            requeuedRunId,
          },
        });
      }
    }

    if (staleCount > 0) {
      logger.warn(
        {
          scanned: activeRuns.length,
          stale: staleCount,
          recovered: recoveredCount,
          circuitOpen: circuitOpenCount,
          runIds,
        },
        "stuck run sweeper evaluated stale runs",
      );
    }

    return {
      scanned: activeRuns.length,
      stale: staleCount,
      recovered: recoveredCount,
      circuitOpen: circuitOpenCount,
      runIds,
    };
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
  ) {
    await ensureRuntimeState(agent);
    const usage = result.usage;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const additionalCostCents = Math.max(0, Math.round((result.costUsd ?? 0) * 100));
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;

    await db
      .update(agentRuntimeState)
      .set({
        adapterType: agent.adapterType,
        sessionId: session.legacySessionId,
        lastRunId: run.id,
        lastRunStatus: run.status,
        lastError: result.errorMessage ?? null,
        totalInputTokens: sql`${agentRuntimeState.totalInputTokens} + ${inputTokens}`,
        totalOutputTokens: sql`${agentRuntimeState.totalOutputTokens} + ${outputTokens}`,
        totalCachedInputTokens: sql`${agentRuntimeState.totalCachedInputTokens} + ${cachedInputTokens}`,
        totalCostCents: sql`${agentRuntimeState.totalCostCents} + ${additionalCostCents}`,
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeState.agentId, agent.id));

    if (additionalCostCents > 0 || hasTokenUsage) {
      await db.insert(costEvents).values({
        companyId: agent.companyId,
        agentId: agent.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        inputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }

    if (additionalCostCents > 0) {
      await db
        .update(agents)
        .set({
          spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${additionalCostCents}`,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agent.id));
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const company = await getCompany(agent.companyId);
      if (!company || company.status !== "active") return [];
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(Math.max(availableSlots * 8, 40));
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      const runningByProject = new Map<string, number>();
      for (const queuedRun of queuedRuns) {
        if (claimedRuns.length >= availableSlots) break;

        const context = parseObject(queuedRun.contextSnapshot);
        const contextBefore = JSON.stringify(context);
        const projectId = await resolveProjectIdFromContext(agent.companyId, context);
        const guardrails = await resolveProjectRunGuardrails(agent.companyId, projectId);
        const issueId = readNonEmptyString(context.issueId);
        const sensitiveIssue = await issueLooksSensitive(agent.companyId, issueId);

        const safeModeReasons: string[] = [];
        if (guardrails.safeModeDefault) safeModeReasons.push("project_safe_mode_default");
        if (sensitiveIssue) safeModeReasons.push("sensitive_issue_labels");
        const safeModeEnabled = safeModeReasons.length > 0;
        const safeModeReason = safeModeReasons[0] ?? "none";

        const nextSafeMode = {
          enabled: safeModeEnabled,
          reason: safeModeReason,
          reasons: safeModeReasons,
          source: guardrails.safeModeDefault ? "project_guardrail" : sensitiveIssue ? "issue_labels" : "none",
          projectId: guardrails.projectId,
          projectName: guardrails.projectName,
          issueId,
          safeModeDefault: guardrails.safeModeDefault,
          sensitiveIssue,
        };
        context.paperclipSafeMode = nextSafeMode;

        const existingOps = parseObject(context.paperclipOps);
        const nextOps: Record<string, unknown> = {
          ...existingOps,
          projectGuardrails: {
            projectId: guardrails.projectId,
            projectName: guardrails.projectName,
            maxConcurrentRuns: guardrails.maxConcurrentRuns,
            timeoutSec: guardrails.timeoutSec,
            safeModeDefault: guardrails.safeModeDefault,
          },
        };

        let guardrailBlocked: string | null = null;
        if (guardrails.projectId && guardrails.maxConcurrentRuns != null) {
          let runningForProject = runningByProject.get(guardrails.projectId);
          if (runningForProject == null) {
            runningForProject = await countRunningRunsForProject(agent.companyId, guardrails.projectId);
            runningByProject.set(guardrails.projectId, runningForProject);
          }
          if (runningForProject >= guardrails.maxConcurrentRuns) {
            guardrailBlocked = "project_max_concurrency";
          }
        }

        if (guardrailBlocked) {
          nextOps.guardrailBlocked = guardrailBlocked;
        } else {
          delete nextOps.guardrailBlocked;
        }
        context.paperclipOps = nextOps;

        if (JSON.stringify(context) !== contextBefore) {
          await updateRunContextSnapshot(queuedRun.id, context);
        }

        if (guardrailBlocked) {
          continue;
        }

        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
        if (claimed && guardrails.projectId && guardrails.maxConcurrentRuns != null) {
          runningByProject.set(
            guardrails.projectId,
            (runningByProject.get(guardrails.projectId) ?? 0) + 1,
          );
        }
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        void executeRun(claimedRun.id).catch((err) => {
          logger.error({ err, runId: claimedRun.id }, "queued heartbeat execution failed");
        });
      }
      return claimedRuns;
    });
  }

  async function executeRun(runId: string) {
    let run = await getRun(runId);
    if (!run) return;
    if (run.status !== "queued" && run.status !== "running") return;

    if (run.status === "queued") {
      const claimed = await claimQueuedRun(run);
      if (!claimed) {
        // Another worker has already claimed or finalized this run.
        return;
      }
      run = claimed;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      const failureRecommendation = mergeFailureRecommendationResult(
        run.resultJson ?? null,
        "agent_not_found",
      );
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
        resultJson: failureRecommendation.resultJson,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) {
        await appendFailureRecommendationEvent(failedRun, 1, "agent_not_found");
        await releaseIssueExecutionAndPromote(failedRun);
      }
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKey(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);
    const issueAssigneeConfig = issueId
      ? await db
          .select({
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueAssigneeConfig && issueAssigneeConfig.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueAssigneeConfig.assigneeAdapterOverrides,
          )
        : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const previousSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(taskSession?.sessionParamsJson ?? null),
    );
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null },
    );
    context.paperclipWorkspace = {
      cwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    };
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    if (resolvedWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = resolvedWorkspace.projectId;
    }
    const runProjectId = await resolveProjectIdFromContext(agent.companyId, context);
    const runGuardrails = await resolveProjectRunGuardrails(agent.companyId, runProjectId);
    const sensitiveIssue = await issueLooksSensitive(agent.companyId, issueId);
    const safeModeReasons: string[] = [];
    if (runGuardrails.safeModeDefault) safeModeReasons.push("project_safe_mode_default");
    if (sensitiveIssue) safeModeReasons.push("sensitive_issue_labels");
    const safeModeEnabled = safeModeReasons.length > 0;
    const safeModeReason = safeModeReasons[0] ?? "none";
    context.paperclipSafeMode = {
      enabled: safeModeEnabled,
      reason: safeModeReason,
      reasons: safeModeReasons,
      source: runGuardrails.safeModeDefault ? "project_guardrail" : sensitiveIssue ? "issue_labels" : "none",
      projectId: runGuardrails.projectId,
      projectName: runGuardrails.projectName,
      issueId,
      safeModeDefault: runGuardrails.safeModeDefault,
      sensitiveIssue,
    };
    const existingOps = parseObject(context.paperclipOps);
    const nextOps: Record<string, unknown> = {
      ...existingOps,
      projectGuardrails: {
        projectId: runGuardrails.projectId,
        projectName: runGuardrails.projectName,
        maxConcurrentRuns: runGuardrails.maxConcurrentRuns,
        timeoutSec: runGuardrails.timeoutSec,
        safeModeDefault: runGuardrails.safeModeDefault,
      },
    };
    delete nextOps.guardrailBlocked;
    context.paperclipOps = nextOps;
    const runtimeSessionFallback = taskKey ? null : runtime.sessionId;
    const previousSessionDisplayId = truncateDisplayId(
      taskSession?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(previousSessionParams) : null) ??
        readNonEmptyString(previousSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    const runtimeForAdapter = {
      sessionId: readNonEmptyString(previousSessionParams?.sessionId) ?? runtimeSessionFallback,
      sessionParams: previousSessionParams,
      sessionDisplayId: previousSessionDisplayId,
      taskKey,
    };

    let seq = 1;
    let handle: RunLogHandle | null = null;
    let stdoutExcerpt = "";
    let stderrExcerpt = "";

    try {
      const startedAt = run.startedAt ?? new Date();
      const runningWithSession = await db
        .update(heartbeatRuns)
        .set({
          startedAt,
          sessionIdBefore: runtimeForAdapter.sessionDisplayId ?? runtimeForAdapter.sessionId,
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (runningWithSession) run = runningWithSession;

      const runningAgent = await db
        .update(agents)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (runningAgent) {
        publishLiveEvent({
          companyId: runningAgent.companyId,
          type: "agent.status",
          payload: {
            agentId: runningAgent.id,
            status: runningAgent.status,
            outcome: "running",
          },
        });
      }

      const currentRun = run;
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
      });

      handle = await runLogStore.begin({
        companyId: run.companyId,
        agentId: run.agentId,
        runId,
      });

      await db
        .update(heartbeatRuns)
        .set({
          logStore: handle.store,
          logRef: handle.logRef,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, chunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, chunk);

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk,
            ts: new Date().toISOString(),
          });
        }

        const payloadChunk =
          chunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? chunk.slice(chunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : chunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== chunk.length,
          },
        });
      };

      const config = parseObject(agent.adapterConfig);
      let mergedConfig = issueAssigneeOverrides?.adapterConfig
        ? { ...config, ...issueAssigneeOverrides.adapterConfig }
        : config;
      if (runGuardrails.timeoutSec != null) {
        mergedConfig = {
          ...mergedConfig,
          timeoutSec: runGuardrails.timeoutSec,
        };
      }
      mergedConfig = applySafeModeConfiguration(agent.adapterType, mergedConfig, {
        enabled: safeModeEnabled,
        reason: safeModeReason,
        reasons: safeModeReasons,
        source: runGuardrails.safeModeDefault ? "project_guardrail" : sensitiveIssue ? "issue_labels" : "none",
        projectId: runGuardrails.projectId,
        projectName: runGuardrails.projectName,
        issueId,
      });
      const resolvedConfig = await secretsSvc.resolveAdapterConfigForRuntime(
        agent.companyId,
        mergedConfig,
      );
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

      const adapter = getServerAdapter(agent.adapterType);
      if (shouldBlockExternalMutableAdapterInSafeMode(agent.adapterType, resolvedConfig, safeModeEnabled)) {
        await onLog(
          "stderr",
          "[paperclip] Safe mode blocked mutable external adapter invocation (set allowExternalMutableInSafeMode=true to bypass).\n",
        );
        let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
        if (handle) {
          logSummary = await runLogStore.finalize(handle);
          handle = null;
        }
        const failureCode = "safe_mode_external_mutation_blocked";
        const failureRecommendation = mergeFailureRecommendationResult(
          null,
          failureCode,
          { safeMode: context.paperclipSafeMode },
        );
        const blockedRun = await setRunStatus(run.id, "failed", {
          finishedAt: new Date(),
          error: "Safe mode blocked mutable external adapter invocation",
          errorCode: failureCode,
          resultJson: failureRecommendation.resultJson,
          stdoutExcerpt,
          stderrExcerpt,
          logBytes: logSummary?.bytes,
          logSha256: logSummary?.sha256,
          logCompressed: logSummary?.compressed ?? false,
        });
        await setWakeupStatus(run.wakeupRequestId, "failed", {
          finishedAt: new Date(),
          error: "Safe mode blocked mutable external adapter invocation",
        });
        if (blockedRun) {
          await appendFailureRecommendationEvent(blockedRun, seq++, failureCode, {
            safeMode: context.paperclipSafeMode,
          });
          await appendRunEvent(blockedRun, seq++, {
            eventType: "lifecycle",
            stream: "system",
            level: "error",
            message: "run failed",
            payload: {
              status: "failed",
              errorCode: failureCode,
            },
          });
          await releaseIssueExecutionAndPromote(blockedRun);
          await updateRuntimeState(agent, blockedRun, {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: failureCode,
            errorMessage: "Safe mode blocked mutable external adapter invocation",
          }, {
            legacySessionId: runtimeForAdapter.sessionId,
          });
        }
        await finalizeAgentStatus(agent.id, "failed");
        return;
      }
      const authToken = adapter.supportsLocalAgentJwt
        ? createLocalAgentJwt(agent.id, agent.companyId, agent.adapterType, run.id)
        : null;
      if (adapter.supportsLocalAgentJwt && !authToken) {
        logger.warn(
          {
            companyId: agent.companyId,
            agentId: agent.id,
            runId: run.id,
            adapterType: agent.adapterType,
          },
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent,
        runtime: runtimeForAdapter,
        config: resolvedConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        authToken: authToken ?? undefined,
      });
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });

      let outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
      const latestRun = await getRun(run.id);
      if (latestRun?.status === "cancelled") {
        outcome = "cancelled";
      } else if (adapterResult.timedOut) {
        outcome = "timed_out";
      } else if ((adapterResult.exitCode ?? 0) === 0 && !adapterResult.errorMessage) {
        outcome = "succeeded";
      } else {
        outcome = "failed";
      }

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        logSummary = await runLogStore.finalize(handle);
      }

      const status =
        outcome === "succeeded"
          ? "succeeded"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "timed_out"
              ? "timed_out"
              : "failed";
      const terminalErrorCode =
        outcome === "timed_out"
          ? "timeout"
          : outcome === "cancelled"
            ? "cancelled"
            : outcome === "failed"
              ? (adapterResult.errorCode ?? "adapter_failed")
              : null;
      const terminalErrorMessage =
        outcome === "succeeded"
          ? null
          : adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed");

      const usageJson =
        adapterResult.usage || adapterResult.costUsd != null
          ? ({
              ...(adapterResult.usage ?? {}),
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              ...(adapterResult.billingType ? { billingType: adapterResult.billingType } : {}),
            } as Record<string, unknown>)
          : null;
      const failureRecommendation =
        outcome === "failed" || outcome === "timed_out"
          ? mergeFailureRecommendationResult(
              adapterResult.resultJson ?? null,
              terminalErrorCode,
              { safeMode: context.paperclipSafeMode },
            )
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error: terminalErrorMessage,
        errorCode: terminalErrorCode,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: failureRecommendation?.resultJson ?? adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: terminalErrorMessage,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        if (failureRecommendation) {
          await appendFailureRecommendationEvent(finalizedRun, seq++, terminalErrorCode, {
            safeMode: context.paperclipSafeMode,
          });
        }
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        });
        if (taskKey) {
          if (adapterResult.clearSession || (!nextSessionState.params && !nextSessionState.displayId)) {
            await clearTaskSessions(agent.companyId, agent.id, {
              taskKey,
              adapterType: agent.adapterType,
            });
          } else {
            await upsertTaskSession({
              companyId: agent.companyId,
              agentId: agent.id,
              adapterType: agent.adapterType,
              taskKey,
              sessionParamsJson: nextSessionState.params,
              sessionDisplayId: nextSessionState.displayId,
              lastRunId: finalizedRun.id,
              lastError: outcome === "succeeded" ? null : (adapterResult.errorMessage ?? "run_failed"),
            });
          }
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
      if (outcome !== "cancelled") {
        const policy = parseHeartbeatPolicy(agent);
        if (policy.autoRestart) {
          void enqueueWakeup(agent.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "auto_restart",
          }).catch((e: unknown) => logger.warn({ err: e, agentId: agent.id }, "auto-restart wakeup enqueue failed"));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown adapter failure";
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failureRecommendation = mergeFailureRecommendationResult(
        run.resultJson ?? null,
        "adapter_failed",
        { safeMode: context.paperclipSafeMode },
      );
      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
        resultJson: failureRecommendation.resultJson,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: message,
      });

      if (failedRun) {
        await appendFailureRecommendationEvent(failedRun, seq++, "adapter_failed", {
          safeMode: context.paperclipSafeMode,
        });
        await appendRunEvent(failedRun, seq++, {
          eventType: "error",
          stream: "system",
          level: "error",
          message,
        });
        await releaseIssueExecutionAndPromote(failedRun);

        await updateRuntimeState(agent, failedRun, {
          exitCode: null,
          signal: null,
          timedOut: false,
          errorMessage: message,
        }, {
          legacySessionId: runtimeForAdapter.sessionId,
        });

        if (taskKey && (previousSessionParams || previousSessionDisplayId || taskSession)) {
          await upsertTaskSession({
            companyId: agent.companyId,
            agentId: agent.id,
            adapterType: agent.adapterType,
            taskKey,
            sessionParamsJson: previousSessionParams,
            sessionDisplayId: previousSessionDisplayId,
            lastRunId: failedRun.id,
            lastError: message,
          });
        }
      }

      await finalizeAgentStatus(agent.id, "failed");
      {
        const policy = parseHeartbeatPolicy(agent);
        if (policy.autoRestart) {
          void enqueueWakeup(agent.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "auto_restart",
          }).catch((e: unknown) => logger.warn({ err: e, agentId: agent.id }, "auto-restart wakeup enqueue failed (post-error)"));
        }
      }
    } finally {
      await startNextQueuedRunForAgent(agent.id);
    }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    const promotedRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);

      if (!issue) return;

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(issues.id, issue.id));

      while (true) {
        const deferred = await tx
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, issue.companyId),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            ),
          )
          .orderBy(asc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        if (!deferred) return null;

        const deferredAgent = await tx
          .select()
          .from(agents)
          .where(eq(agents.id, deferred.agentId))
          .then((rows) => rows[0] ?? null);

        if (
          !deferredAgent ||
          deferredAgent.companyId !== issue.companyId ||
          deferredAgent.status === "paused" ||
          deferredAgent.status === "terminated" ||
          deferredAgent.status === "pending_approval"
        ) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "failed",
              finishedAt: new Date(),
              error: "Deferred wake could not be promoted: agent is not invokable",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, deferred.id));
          continue;
        }

        const deferredPayload = parseObject(deferred.payload);
        const deferredContextSeed = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
        const promotedContextSeed: Record<string, unknown> = { ...deferredContextSeed };
        const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
        const promotedSource =
          (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
        const promotedTriggerDetail =
          (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? null;
        const promotedPayload = deferredPayload;
        delete promotedPayload[DEFERRED_WAKE_CONTEXT_KEY];

        const {
          contextSnapshot: promotedContextSnapshot,
          taskKey: promotedTaskKey,
        } = enrichWakeContextSnapshot({
          contextSnapshot: promotedContextSeed,
          reason: promotedReason,
          source: promotedSource,
          triggerDetail: promotedTriggerDetail,
          payload: promotedPayload,
        });

        const sessionBefore = await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
        const now = new Date();
        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: deferredAgent.companyId,
            agentId: deferredAgent.id,
            invocationSource: promotedSource,
            triggerDetail: promotedTriggerDetail,
            status: "queued",
            wakeupRequestId: deferred.id,
            contextSnapshot: promotedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            reason: "issue_execution_promoted",
            runId: newRun.id,
            claimedAt: null,
            finishedAt: null,
            error: null,
            updatedAt: now,
          })
          .where(eq(agentWakeupRequests.id, deferred.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: normalizeAgentNameKey(deferredAgent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(eq(issues.id, issue.id));

        return newRun;
      }
    });

    if (!promotedRun) return;

    publishLiveEvent({
      companyId: promotedRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: promotedRun.id,
        agentId: promotedRun.agentId,
        invocationSource: promotedRun.invocationSource,
        triggerDetail: promotedRun.triggerDetail,
        wakeupRequestId: promotedRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(promotedRun.agentId);
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = { ...(opts.contextSnapshot ?? {}) };
    const reason = opts.reason ?? null;
    const payload = opts.payload ?? null;
    const {
      contextSnapshot: enrichedContextSnapshot,
      issueIdFromPayload,
      taskKey,
      wakeCommentId,
    } = enrichWakeContextSnapshot({
      contextSnapshot,
      reason,
      source,
      triggerDetail,
      payload,
    });
    const issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");

    const company = await getCompany(agent.companyId);
    if (!company) throw notFound("Company not found");

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);
    const writeSkippedRequest = async (reason: string) => {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });
    };
    const writeDeferredCompanyPausedRequest = async () => {
      const deferredPayload: Record<string, unknown> = {
        ...(payload ?? {}),
        [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
      };
      if (reason) {
        deferredPayload[DEFERRED_COMPANY_PAUSED_REASON_KEY] = reason;
      }
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: "company_paused_deferred",
        payload: deferredPayload,
        status: "deferred_company_paused",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      });
    };

    if (company.status === "paused") {
      await writeDeferredCompanyPausedRequest();
      return null;
    }
    if (company.status === "archived") {
      await writeSkippedRequest("company.archived");
      return null;
    }
    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source === "timer" && policy.skipIfNoAssignments) {
      const hasAssignments = await hasOpenAssignments(agent);
      if (!hasAssignments) {
        await writeSkippedRequest("heartbeat.no_assignments");
        return null;
      }
    }
    if (source !== "timer" && !policy.wakeOnDemand && reason !== "auto_restart") {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);
      const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

      const outcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
        );

        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!issue) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_issue_not_found",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return { kind: "skipped" as const };
        }

        let activeExecutionRun = issue.executionRunId
          ? await tx
            .select()
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, issue.executionRunId))
            .then((rows) => rows[0] ?? null)
          : null;

        if (activeExecutionRun && activeExecutionRun.status !== "queued" && activeExecutionRun.status !== "running") {
          activeExecutionRun = null;
        }

        if (!activeExecutionRun && issue.executionRunId) {
          await tx
            .update(issues)
            .set({
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issue.id));
        }

        if (!activeExecutionRun) {
          const legacyRun = await tx
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, issue.companyId),
                inArray(heartbeatRuns.status, ["queued", "running"]),
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(
              sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
              asc(heartbeatRuns.createdAt),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (legacyRun) {
            activeExecutionRun = legacyRun;
            const legacyAgent = await tx
              .select({ name: agents.name })
              .from(agents)
              .where(eq(agents.id, legacyRun.agentId))
              .then((rows) => rows[0] ?? null);
            await tx
              .update(issues)
              .set({
                executionRunId: legacyRun.id,
                executionAgentNameKey: normalizeAgentNameKey(legacyAgent?.name),
                executionLockedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(issues.id, issue.id));
          }
        }

        if (activeExecutionRun) {
          const executionAgent = await tx
            .select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, activeExecutionRun.agentId))
            .then((rows) => rows[0] ?? null);
          const executionAgentNameKey =
            normalizeAgentNameKey(issue.executionAgentNameKey) ??
            normalizeAgentNameKey(executionAgent?.name);
          const isSameExecutionAgent =
            Boolean(executionAgentNameKey) && executionAgentNameKey === agentNameKey;
          const shouldQueueFollowupForCommentWake =
            Boolean(wakeCommentId) &&
            activeExecutionRun.status === "running" &&
            isSameExecutionAgent;

          if (isSameExecutionAgent && !shouldQueueFollowupForCommentWake) {
            const mergedContextSnapshot = mergeCoalescedContextSnapshot(
              activeExecutionRun.contextSnapshot,
              enrichedContextSnapshot,
            );
            const mergedRun = await tx
              .update(heartbeatRuns)
              .set({
                contextSnapshot: mergedContextSnapshot,
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, activeExecutionRun.id))
              .returning()
              .then((rows) => rows[0] ?? activeExecutionRun);

            await tx.insert(agentWakeupRequests).values({
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_execution_same_name",
              payload,
              status: "coalesced",
              coalescedCount: 1,
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              runId: mergedRun.id,
              finishedAt: new Date(),
            });

            return { kind: "coalesced" as const, run: mergedRun };
          }

          const deferredPayload = {
            ...(payload ?? {}),
            issueId,
            [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
          };

          const existingDeferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (existingDeferred) {
            const existingDeferredPayload = parseObject(existingDeferred.payload);
            const existingDeferredContext = parseObject(existingDeferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
            const mergedDeferredContext = mergeCoalescedContextSnapshot(
              existingDeferredContext,
              enrichedContextSnapshot,
            );
            const mergedDeferredPayload = {
              ...existingDeferredPayload,
              ...(payload ?? {}),
              issueId,
              [DEFERRED_WAKE_CONTEXT_KEY]: mergedDeferredContext,
            };

            await tx
              .update(agentWakeupRequests)
              .set({
                payload: mergedDeferredPayload,
                coalescedCount: (existingDeferred.coalescedCount ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(agentWakeupRequests.id, existingDeferred.id));

            return { kind: "deferred" as const };
          }

          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "issue_execution_deferred",
            payload: deferredPayload,
            status: "deferred_issue_execution",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          });

          return { kind: "deferred" as const };
        }

        const wakeupRequest = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason,
            payload,
            status: "queued",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
          })
          .returning()
          .then((rows) => rows[0]);

        const newRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: agent.companyId,
            agentId,
            invocationSource: source,
            triggerDetail,
            status: "queued",
            wakeupRequestId: wakeupRequest.id,
            contextSnapshot: enrichedContextSnapshot,
            sessionIdBefore: sessionBefore,
          })
          .returning()
          .then((rows) => rows[0]);

        await tx
          .update(agentWakeupRequests)
          .set({
            runId: newRun.id,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, wakeupRequest.id));

        await tx
          .update(issues)
          .set({
            executionRunId: newRun.id,
            executionAgentNameKey: agentNameKey,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, issue.id));

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "coalesced") return outcome.run;

      const newRun = outcome.run;
      publishLiveEvent({
        companyId: newRun.companyId,
        type: "heartbeat.run.queued",
        payload: {
          runId: newRun.id,
          agentId: newRun.agentId,
          invocationSource: newRun.invocationSource,
          triggerDetail: newRun.triggerDetail,
          wakeupRequestId: newRun.wakeupRequestId,
        },
      });

      await startNextQueuedRunForAgent(agent.id);
      return newRun;
    }

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])))
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) => candidate.status === "queued" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) => candidate.status === "running" && isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForCommentWake =
      Boolean(wakeCommentId) && Boolean(sameScopeRunningRun) && !sameScopeQueuedRun;

    const coalescedTargetRun =
      sameScopeQueuedRun ??
      (shouldQueueFollowupForCommentWake ? null : sameScopeRunningRun ?? null);

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        contextSnapshot,
      );
      const mergedRun = await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: mergedContextSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, coalescedTargetRun.id))
        .returning()
        .then((rows) => rows[0] ?? coalescedTargetRun);

      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "coalesced",
        coalescedCount: 1,
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        runId: mergedRun.id,
        finishedAt: new Date(),
      });
      return mergedRun;
    }

    const wakeupRequest = await db
      .insert(agentWakeupRequests)
      .values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason,
        payload,
        status: "queued",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      })
      .returning()
      .then((rows) => rows[0]);

    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);

    const newRun = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId,
        invocationSource: source,
        triggerDetail,
        status: "queued",
        wakeupRequestId: wakeupRequest.id,
        contextSnapshot: enrichedContextSnapshot,
        sessionIdBefore: sessionBefore,
      })
      .returning()
      .then((rows) => rows[0]);

    await db
      .update(agentWakeupRequests)
      .set({
        runId: newRun.id,
        updatedAt: new Date(),
      })
      .where(eq(agentWakeupRequests.id, wakeupRequest.id));

    publishLiveEvent({
      companyId: newRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: newRun.id,
        agentId: newRun.agentId,
        invocationSource: newRun.invocationSource,
        triggerDetail: newRun.triggerDetail,
        wakeupRequestId: newRun.wakeupRequestId,
      },
    });

    await startNextQueuedRunForAgent(agent.id);

    return newRun;
  }

  async function replayDeferredCompanyPausedWakeups(companyId: string) {
    const company = await getCompany(companyId);
    if (!company || company.status !== "active") {
      return { processed: 0, queued: 0, completedWithoutRun: 0, failed: 0 };
    }

    const deferredWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "deferred_company_paused"),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt));

    let processed = 0;
    let queued = 0;
    let completedWithoutRun = 0;
    let failed = 0;

    for (const deferred of deferredWakeups) {
      processed += 1;
      const deferredPayload = parseObject(deferred.payload);
      const deferredContext = parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]);
      const replayPayload: Record<string, unknown> = { ...deferredPayload };
      delete replayPayload[DEFERRED_WAKE_CONTEXT_KEY];
      delete replayPayload[DEFERRED_COMPANY_PAUSED_REASON_KEY];
      const replayReason =
        readNonEmptyString(deferredPayload[DEFERRED_COMPANY_PAUSED_REASON_KEY]) ??
        "company_paused_replayed";
      const replaySource =
        (readNonEmptyString(deferred.source) as WakeupOptions["source"]) ?? "automation";
      const replayTriggerDetail =
        (readNonEmptyString(deferred.triggerDetail) as WakeupOptions["triggerDetail"]) ?? undefined;
      const replayRequestedByActorType =
        deferred.requestedByActorType === "user" ||
        deferred.requestedByActorType === "agent" ||
        deferred.requestedByActorType === "system"
          ? deferred.requestedByActorType
          : undefined;

      try {
        const replayRun = await enqueueWakeup(deferred.agentId, {
          source: replaySource,
          triggerDetail: replayTriggerDetail,
          reason: replayReason,
          payload: Object.keys(replayPayload).length > 0 ? replayPayload : null,
          requestedByActorType: replayRequestedByActorType,
          requestedByActorId: deferred.requestedByActorId ?? null,
          contextSnapshot: deferredContext,
        });

        if (replayRun) queued += 1;
        else completedWithoutRun += 1;

        await db
          .update(agentWakeupRequests)
          .set({
            status: "completed",
            reason: "company_paused_replayed",
            runId: replayRun?.id ?? null,
            finishedAt: new Date(),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, deferred.id));
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : "Replay failed";
        await db
          .update(agentWakeupRequests)
          .set({
            status: "failed",
            reason: "company_paused_replay_failed",
            finishedAt: new Date(),
            error: message,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, deferred.id));
      }
    }

    return { processed, queued, completedWithoutRun, failed };
  }

  async function cancelRunByControlPlane(
    runId: string,
    opts?: { error?: string; errorCode?: string; eventMessage?: string },
  ) {
    const run = await getRun(runId);
    if (!run) throw notFound("Heartbeat run not found");
    if (run.status !== "running" && run.status !== "queued") return run;

    const running = runningProcesses.get(run.id);
    if (running) {
      running.child.kill("SIGTERM");
      const graceMs = Math.max(1, running.graceSec) * 1000;
      setTimeout(() => {
        if (!running.child.killed) {
          running.child.kill("SIGKILL");
        }
      }, graceMs);
    }

    const errorMessage = opts?.error ?? "Cancelled by control plane";
    const errorCode = opts?.errorCode ?? "cancelled";
    const eventMessage = opts?.eventMessage ?? "run cancelled";

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: errorMessage,
      errorCode,
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: errorMessage,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: eventMessage,
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveRunsForAgent(agentId: string, reason: string) {
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await setRunStatus(run.id, "cancelled", {
        finishedAt: new Date(),
        error: reason,
        errorCode: "cancelled",
      });

      await setWakeupStatus(run.wakeupRequestId, "cancelled", {
        finishedAt: new Date(),
        error: reason,
      });

      const running = runningProcesses.get(run.id);
      if (running) {
        running.child.kill("SIGTERM");
        runningProcesses.delete(run.id);
      }
      await releaseIssueExecutionAndPromote(run);
    }

    return runs.length;
  }

  return {
    list: (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select()
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (limit) {
        return query.limit(limit);
      }
      return query;
    },

    getRun,

    getRuntimeState: async (agentId: string) => {
      const state = await getRuntimeState(agentId);
      const agent = await getAgent(agentId);
      if (!agent) return null;
      const ensured = state ?? (await ensureRuntimeState(agent));
      const latestTaskSession = await db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id)))
        .orderBy(desc(agentTaskSessions.updatedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return {
        ...ensured,
        sessionDisplayId: latestTaskSession?.sessionDisplayId ?? ensured.sessionId,
        sessionParamsJson: latestTaskSession?.sessionParamsJson ?? null,
      };
    },

    listTaskSessions: async (agentId: string) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");

      return db
        .select()
        .from(agentTaskSessions)
        .where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agentId)))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    listTaskSessionsForCompany: async (companyId: string) => {
      return db
        .select({
          id: agentTaskSessions.id,
          agentId: agentTaskSessions.agentId,
          agentName: agents.name,
          adapterType: agentTaskSessions.adapterType,
          taskKey: agentTaskSessions.taskKey,
          sessionParamsJson: agentTaskSessions.sessionParamsJson,
          sessionDisplayId: agentTaskSessions.sessionDisplayId,
          lastRunId: agentTaskSessions.lastRunId,
          lastError: agentTaskSessions.lastError,
          createdAt: agentTaskSessions.createdAt,
          updatedAt: agentTaskSessions.updatedAt,
        })
        .from(agentTaskSessions)
        .innerJoin(agents, eq(agentTaskSessions.agentId, agents.id))
        .where(eq(agentTaskSessions.companyId, companyId))
        .orderBy(desc(agentTaskSessions.updatedAt), desc(agentTaskSessions.createdAt));
    },

    resetRuntimeSession: async (agentId: string, opts?: { taskKey?: string | null }) => {
      const agent = await getAgent(agentId);
      if (!agent) throw notFound("Agent not found");
      await ensureRuntimeState(agent);
      const taskKey = readNonEmptyString(opts?.taskKey);
      const clearedTaskSessions = await clearTaskSessions(
        agent.companyId,
        agent.id,
        taskKey ? { taskKey, adapterType: agent.adapterType } : undefined,
      );
      const runtimePatch: Partial<typeof agentRuntimeState.$inferInsert> = {
        sessionId: null,
        lastError: null,
        updatedAt: new Date(),
      };
      if (!taskKey) {
        runtimePatch.stateJson = {};
      }

      const updated = await db
        .update(agentRuntimeState)
        .set(runtimePatch)
        .where(eq(agentRuntimeState.agentId, agentId))
        .returning()
        .then((rows) => rows[0] ?? null);

      if (!updated) return null;
      return {
        ...updated,
        sessionDisplayId: null,
        sessionParamsJson: null,
        clearedTaskSessions,
      };
    },

    listEvents: (runId: string, afterSeq = 0, limit = 200) =>
      db
        .select()
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.runId, runId), gt(heartbeatRunEvents.seq, afterSeq)))
        .orderBy(asc(heartbeatRunEvents.seq))
        .limit(Math.max(1, Math.min(limit, 1000))),

    readLog: async (runId: string, opts?: { offset?: number; limitBytes?: number }) => {
      const run = await getRun(runId);
      if (!run) throw notFound("Heartbeat run not found");
      if (!run.logStore || !run.logRef) throw notFound("Run log not found");

      const result = await runLogStore.read(
        {
          store: run.logStore as "local_file",
          logRef: run.logRef,
        },
        opts,
      );

      return {
        runId,
        store: run.logStore,
        logRef: run.logRef,
        ...result,
      };
    },

    invoke: async (
      agentId: string,
      source: "timer" | "assignment" | "on_demand" | "automation" = "on_demand",
      contextSnapshot: Record<string, unknown> = {},
      triggerDetail: "manual" | "ping" | "callback" | "system" = "manual",
      actor?: { actorType?: "user" | "agent" | "system"; actorId?: string | null },
    ) =>
      enqueueWakeup(agentId, {
        source,
        triggerDetail,
        contextSnapshot,
        requestedByActorType: actor?.actorType,
        requestedByActorId: actor?.actorId ?? null,
      }),

    wakeup: enqueueWakeup,

    reapOrphanedRuns,

    sweepStuckRuns,

    reportHostBootIncident,

    tickTimers: async (now = new Date()) => {
      const allAgents = await db
        .select({
          agent: agents,
          companyStatus: companies.status,
        })
        .from(agents)
        .innerJoin(companies, eq(agents.companyId, companies.id));
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const { agent, companyStatus } of allAgents) {
        if (companyStatus !== "active") continue;
        if (agent.status === "paused" || agent.status === "terminated") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        const run = await enqueueWakeup(agent.id, {
          source: "timer",
          triggerDetail: "system",
          reason: "heartbeat_timer",
          requestedByActorType: "system",
          requestedByActorId: "heartbeat_scheduler",
          contextSnapshot: {
            source: "scheduler",
            reason: "interval_elapsed",
            now: now.toISOString(),
          },
        });
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunByControlPlane(runId),

    cancelActiveForAgent: (agentId: string) =>
      cancelActiveRunsForAgent(agentId, "Cancelled due to agent pause"),

    cancelActiveForCompany: async (companyId: string) => {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId));
      let cancelled = 0;
      for (const row of rows) {
        cancelled += await cancelActiveRunsForAgent(row.id, "Cancelled due to company pause");
      }
      return cancelled;
    },

    replayDeferredForCompany: (companyId: string) => replayDeferredCompanyPausedWakeups(companyId),

    getActiveRunForAgent: async (agentId: string) => {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .orderBy(desc(heartbeatRuns.startedAt))
        .limit(1);
      return run ?? null;
    },
  };
}
