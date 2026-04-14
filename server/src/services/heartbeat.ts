import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueLabels,
  labels,
  principalPermissionGrants,
  projects,
  projectWorkspaces,
} from "@ironworksai/db";
import { DEFAULT_OUTPUT_TOKEN_LIMITS, DEFAULT_SKILL_ALLOWLIST, WESTERN_COUNCIL_MODELS } from "@ironworksai/shared";
import type { OutputTokenCategory } from "@ironworksai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber } from "../adapters/utils.js";
import {
  MAX_LIVE_LOG_CHUNK_BYTES,
  HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT,
  HEARTBEAT_MAX_CONCURRENT_RUNS_MAX,
  COMPLETION_MARKERS,
  DEFERRED_WAKE_CONTEXT_KEY,
  DETACHED_PROCESS_ERROR_CODE,
  REPO_ONLY_CWD_SENTINEL,
  MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
  HEARTBEAT_TASK_KEY,
  MAX_TOOL_OUTPUT_CHARS,
  SESSIONED_LOCAL_ADAPTERS,
  startLocksByAgent,
  appendExcerpt,
  readNonEmptyString,
  normalizeMaxConcurrentRuns,
  normalizeLedgerBillingType,
  resolveLedgerBiller,
  normalizeBilledCostCents,
  normalizeUsageTotals,
  readRawUsageTotals,
  deriveNormalizedUsageDelta,
  formatCount,
  formatRuntimeWorkspaceWarningLog,
  parseIssueAssigneeAdapterOverrides,
  deriveTaskKey,
  deriveTaskKeyWithHeartbeatFallback,
  deriveCommentId,
  describeSessionResetReason,
  shouldResetTaskSessionForWake,
  enrichWakeContextSnapshot,
  mergeCoalescedContextSnapshot,
  isSameTaskScope,
  compressToolOutput,
  isTrackedLocalChildProcessAdapter,
  isProcessAlive,
  truncateDisplayId,
  normalizeAgentNameKey,
  normalizeSessionParams,
  resolveNextSessionState,
  buildExplicitResumeSessionOverride,
  classifyContextTier,
  classifyTaskType,
  PROMPT_TEMPLATES,
  type ContextTier,
  type TaskTemplateType,
  type WakeupOptions,
  type UsageTotals,
  type SessionCompactionDecision,
  type ParsedIssueAssigneeAdapterOverrides,
  type ProjectWorkspaceCandidate,
} from "./heartbeat-types.js";
import { costService } from "./costs.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { logActivity } from "./activity-log.js";
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@ironworksai/adapter-utils";
import {
  classifyTaskComplexity,
  selectModelForComplexity,
  shouldEscalateModel,
  logEscalationSignal,
} from "./model-routing.js";
import {
  classifyTaskImportance,
  resolveModelStrategy,
  executeSingle,
  executeCascade,
  executeCouncil,
  ROLE_COUNCIL_DEFAULTS,
  type CouncilConfig,
  type CouncilResult,
} from "./model-council.js";
import {
  injectSessionContext,
  injectChannelMessages as injectChannelMessagesCtx,
  injectChannelPostingInstruction,
  injectConfidenceTagging,
  injectQualityExamples,
  injectOnboardingReplay,
  injectPendingMentions,
  injectPendingDeliberations,
  injectChannelHealth,
  injectCognitiveLoadReport,
  injectContextDriftWarning,
  injectContextUtilizationNote,
  injectTaskTypeClassification,
  injectRecentDocuments,
  injectBatchedTasks,
  injectWebResearch,
  injectDeadlineUrgency,
  injectDependencyContext,
  injectGoalContext,
  injectPlaybookGuidance,
  injectPlatformAwareness,
} from "./heartbeat-context.js";
import {
  updateRuntimeState as updateRuntimeStateModule,
  savePostRunSessionState,
  postSuccessChannelMessages,
  extractAndPostAgentChannelMessages,
  extractAndLogDecisions,
} from "./heartbeat-post-run.js";
import {
  withAgentStartLock,
  getAdapterSessionCodec,
  parseHeartbeatPolicy as parseHeartbeatPolicyModule,
  countRunningRunsForAgent as countRunningRunsForAgentModule,
  checkIterationLimits as checkIterationLimitsModule,
  resolveSessionBeforeForWakeup as resolveSessionBeforeForWakeupModule,
  resolveExplicitResumeSessionOverride as resolveExplicitResumeSessionOverrideModule,
  reapOrphanedRuns as reapOrphanedRunsModule,
  resumeQueuedRuns as resumeQueuedRunsModule,
  tickTimers as tickTimersModule,
  releaseIssueExecutionAndPromote as releaseIssueExecutionAndPromoteModule,
  enqueueWakeup as enqueueWakeupModule,
  getSchedulerSettings,
} from "./heartbeat-scheduling.js";
import {
  cancelRunInternal as cancelRunInternalModule,
  cancelActiveForAgentInternal as cancelActiveForAgentInternalModule,
  cancelBudgetScopeWork as cancelBudgetScopeWorkModule,
} from "./heartbeat-cancellation.js";

const execFile = promisify(execFileCallback);

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName = cleanedPath.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}

const heartbeatRunListColumns = {
  id: heartbeatRuns.id,
  companyId: heartbeatRuns.companyId,
  agentId: heartbeatRuns.agentId,
  invocationSource: heartbeatRuns.invocationSource,
  triggerDetail: heartbeatRuns.triggerDetail,
  status: heartbeatRuns.status,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  error: heartbeatRuns.error,
  wakeupRequestId: heartbeatRuns.wakeupRequestId,
  exitCode: heartbeatRuns.exitCode,
  signal: heartbeatRuns.signal,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  sessionIdBefore: heartbeatRuns.sessionIdBefore,
  sessionIdAfter: heartbeatRuns.sessionIdAfter,
  logStore: heartbeatRuns.logStore,
  logRef: heartbeatRuns.logRef,
  logBytes: heartbeatRuns.logBytes,
  logSha256: heartbeatRuns.logSha256,
  logCompressed: heartbeatRuns.logCompressed,
  stdoutExcerpt: sql<string | null>`NULL`.as("stdoutExcerpt"),
  stderrExcerpt: sql<string | null>`NULL`.as("stderrExcerpt"),
  errorCode: heartbeatRuns.errorCode,
  externalRunId: heartbeatRuns.externalRunId,
  processPid: heartbeatRuns.processPid,
  processStartedAt: heartbeatRuns.processStartedAt,
  retryOfRunId: heartbeatRuns.retryOfRunId,
  processLossRetryCount: heartbeatRuns.processLossRetryCount,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  createdAt: heartbeatRuns.createdAt,
  updatedAt: heartbeatRuns.updatedAt,
} as const;


export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
};

// ProjectWorkspaceCandidate, prioritizeProjectWorkspaceCandidatesForRun, readNonEmptyString,
// normalizeLedgerBillingType, resolveLedgerBiller, normalizeBilledCostCents,
// normalizeUsageTotals, readRawUsageTotals, deriveNormalizedUsageDelta, formatCount,
// buildExplicitResumeSessionOverride are all imported from heartbeat-types.ts

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

async function resolveLedgerScopeForRun(
  db: Db,
  companyId: string,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const context = parseObject(run.contextSnapshot);
  const contextIssueId = readNonEmptyString(context.issueId);
  const contextProjectId = readNonEmptyString(context.projectId);

  if (!contextIssueId) {
    return {
      issueId: null,
      projectId: contextProjectId,
    };
  }

  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, contextIssueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  return {
    issueId: issue?.id ?? null,
    projectId: issue?.projectId ?? contextProjectId,
  };
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(previousSessionParams?.sessionId);
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(previousSessionParams?.workspaceId);
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId) migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl) migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef) migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

// parseIssueAssigneeAdapterOverrides, HEARTBEAT_TASK_KEY, deriveTaskKey,
// deriveTaskKeyWithHeartbeatFallback, shouldResetTaskSessionForWake,
// formatRuntimeWorkspaceWarningLog, describeSessionResetReason, deriveCommentId,
// enrichWakeContextSnapshot, mergeCoalescedContextSnapshot, isSameTaskScope,
// compressToolOutput, isTrackedLocalChildProcessAdapter, isProcessAlive,
// truncateDisplayId, normalizeAgentNameKey, normalizeSessionParams,
// resolveNextSessionState are all imported from heartbeat-types.ts

// Re-export the functions that are part of the public API of this module
export {
  compressToolOutput,
  deriveTaskKeyWithHeartbeatFallback,
  shouldResetTaskSessionForWake,
  formatRuntimeWorkspaceWarningLog,
  buildExplicitResumeSessionOverride,
} from "./heartbeat-types.js";

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}


/**
 * Classify the output token category for a heartbeat run based on context.
 * Returns the appropriate max_tokens limit from DEFAULT_OUTPUT_TOKEN_LIMITS.
 */
function classifyOutputTokenCategory(
  context: Record<string, unknown>,
  source: string | null,
): OutputTokenCategory {
  const issueId = readNonEmptyString(context.issueId);
  const commentId = readNonEmptyString(context.wakeCommentId) ?? readNonEmptyString(context.commentId);
  const wakeReason = readNonEmptyString(context.wakeReason);

  // Routine heartbeat with no new work - keep it brief
  if (source === "timer" && !issueId && !commentId) {
    return "heartbeat_status";
  }

  // Responding to a comment - moderate output
  if (commentId || wakeReason === "issue_comment_mentioned") {
    return "simple_response";
  }

  // Working on an issue (code generation / analysis)
  if (issueId) {
    return "code_generation";
  }

  // Default for other wake types (on_demand, assignment, automation)
  return "code_generation";
}

/**
 * Resolve the max_tokens value for an agent run.
 * Checks agent runtimeConfig for an explicit override, then falls back to
 * the category-based default from DEFAULT_OUTPUT_TOKEN_LIMITS.
 */
function resolveMaxOutputTokens(
  config: Record<string, unknown>,
  context: Record<string, unknown>,
  source: string | null,
): number {
  // Budget throttle: if 80% of daily gate was hit, the cap was stored in context
  const throttledCap = typeof context.ironworksBudgetThrottledTokenCap === "number" && context.ironworksBudgetThrottledTokenCap > 0
    ? context.ironworksBudgetThrottledTokenCap
    : null;
  if (throttledCap) return throttledCap;

  // Allow per-agent override via adapterConfig.maxOutputTokens
  const explicit = typeof config.maxOutputTokens === "number" && config.maxOutputTokens > 0
    ? config.maxOutputTokens
    : null;
  if (explicit) return explicit;

  const category = classifyOutputTokenCategory(context, source);
  return DEFAULT_OUTPUT_TOKEN_LIMITS[category];
}

export function heartbeatService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  const runLogStore = getRunLogStore();
  const secretsSvc = secretService(db);
  const companySkills = companySkillService(db);
  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const activeRunExecutions = new Set<string>();
  const budgetHooks = {
    cancelWorkForScope: cancelBudgetScopeWork,
  };
  const budgets = budgetService(db, budgetHooks);

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
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

  async function getLatestRunForSession(
    agentId: string,
    sessionId: string,
    opts?: { excludeRunId?: string | null },
  ) {
    const conditions = [
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.sessionIdAfter, sessionId),
    ];
    if (opts?.excludeRunId) {
      conditions.push(sql`${heartbeatRuns.id} <> ${opts.excludeRunId}`);
    }
    return db
      .select()
      .from(heartbeatRuns)
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function getOldestRunForSession(agentId: string, sessionId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function resolveNormalizedUsageForSession(input: {
    agentId: string;
    runId: string;
    sessionId: string | null;
    rawUsage: UsageTotals | null;
  }) {
    const { agentId, runId, sessionId, rawUsage } = input;
    if (!sessionId || !rawUsage) {
      return {
        normalizedUsage: rawUsage,
        previousRawUsage: null as UsageTotals | null,
        derivedFromSessionTotals: false,
      };
    }

    const previousRun = await getLatestRunForSession(agentId, sessionId, { excludeRunId: runId });
    const previousRawUsage = readRawUsageTotals(previousRun?.usageJson);
    return {
      normalizedUsage: deriveNormalizedUsageDelta(rawUsage, previousRawUsage),
      previousRawUsage,
      derivedFromSessionTotals: previousRawUsage !== null,
    };
  }

  async function evaluateSessionCompaction(input: {
    agent: typeof agents.$inferSelect;
    sessionId: string | null;
    issueId: string | null;
  }): Promise<SessionCompactionDecision> {
    const { agent, sessionId, issueId } = input;
    if (!sessionId) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const policy = parseSessionCompactionPolicy(agent);
    if (!policy.enabled || !hasSessionCompactionThresholds(policy)) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const fetchLimit = Math.max(policy.maxSessionRuns > 0 ? policy.maxSessionRuns + 1 : 0, 4);
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
        resultJson: heartbeatRuns.resultJson,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.sessionIdAfter, sessionId)))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(fetchLimit);

    if (runs.length === 0) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: null,
      };
    }

    const latestRun = runs[0] ?? null;
    const oldestRun =
      policy.maxSessionAgeHours > 0
        ? await getOldestRunForSession(agent.id, sessionId)
        : runs[runs.length - 1] ?? latestRun;
    const latestRawUsage = readRawUsageTotals(latestRun?.usageJson);
    const sessionAgeHours =
      latestRun && oldestRun
        ? Math.max(
            0,
            (new Date(latestRun.createdAt).getTime() - new Date(oldestRun.createdAt).getTime()) / (1000 * 60 * 60),
          )
        : 0;

    let reason: string | null = null;
    if (policy.maxSessionRuns > 0 && runs.length > policy.maxSessionRuns) {
      reason = `session exceeded ${policy.maxSessionRuns} runs`;
    } else if (
      policy.maxRawInputTokens > 0 &&
      latestRawUsage &&
      latestRawUsage.inputTokens >= policy.maxRawInputTokens
    ) {
      reason =
        `session raw input reached ${formatCount(latestRawUsage.inputTokens)} tokens ` +
        `(threshold ${formatCount(policy.maxRawInputTokens)})`;
    } else if (policy.maxSessionAgeHours > 0 && sessionAgeHours >= policy.maxSessionAgeHours) {
      reason = `session age reached ${Math.floor(sessionAgeHours)} hours`;
    }

    if (!reason || !latestRun) {
      return {
        rotate: false,
        reason: null,
        handoffMarkdown: null,
        previousRunId: latestRun?.id ?? null,
      };
    }

    const latestSummary = summarizeHeartbeatRunResultJson(latestRun.resultJson);
    const latestTextSummary =
      readNonEmptyString(latestSummary?.summary) ??
      readNonEmptyString(latestSummary?.result) ??
      readNonEmptyString(latestSummary?.message) ??
      readNonEmptyString(latestRun.error);

    const handoffMarkdown = [
      "Ironworks session handoff:",
      `- Previous session: ${sessionId}`,
      issueId ? `- Issue: ${issueId}` : "",
      `- Rotation reason: ${reason}`,
      latestTextSummary ? `- Last run summary: ${latestTextSummary}` : "",
      "Continue from the current task state. Rebuild only the minimum context you need.",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      rotate: true,
      reason,
      handoffMarkdown,
      previousRunId: latestRun.id,
    };
  }

  async function resolveSessionBeforeForWakeup(
    agent: typeof agents.$inferSelect,
    taskKey: string | null,
  ) {
    return resolveSessionBeforeForWakeupModule(db, agent, taskKey);
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    return resolveExplicitResumeSessionOverrideModule(db, agent, payload, taskKey);
  }

  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null },
  ): Promise<ResolvedWorkspaceForRun> {
    const issueId = readNonEmptyString(context.issueId);
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(context.projectWorkspaceId);
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const preferredProjectWorkspaceId =
      issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const resolvedProjectId = issueProjectId ?? contextProjectId;
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
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
    const projectWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? projectWorkspaceRows.find((workspace) => workspace.id === preferredProjectWorkspaceId) ?? null
        : null;
      const missingProjectCwds: string[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning =
          `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd = readNonEmptyString(workspace.cwd);
        let managedWorkspaceWarning: string | null = null;
        if (!projectCwd || projectCwd === REPO_ONLY_CWD_SENTINEL) {
          try {
            const managedWorkspace = await ensureManagedProjectWorkspace({
              companyId: agent.companyId,
              projectId: workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
              repoUrl: readNonEmptyString(workspace.repoUrl),
            });
            projectCwd = managedWorkspace.cwd;
            managedWorkspaceWarning = managedWorkspace.warning;
          } catch (error) {
            if (preferredWorkspace?.id === workspace.id) {
              preferredWorkspaceWarning = error instanceof Error ? error.message : String(error);
            }
            continue;
          }
        }
        hasConfiguredProjectCwd = true;
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
            warnings: [preferredWorkspaceWarning, managedWorkspaceWarning].filter(
              (value): value is string => Boolean(value),
            ),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning =
            `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const fallbackCwd = resolveDefaultAgentWorkspaceDir(agent.id);
      await fs.mkdir(fallbackCwd, { recursive: true });
      const warnings: string[] = [];
      if (preferredWorkspaceWarning) {
        warnings.push(preferredWorkspaceWarning);
      }
      if (missingProjectCwds.length > 0) {
        const firstMissing = missingProjectCwds[0];
        const extraMissingCount = Math.max(0, missingProjectCwds.length - 1);
        warnings.push(
          extraMissingCount > 0
            ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${fallbackCwd}" for this run.`
            : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      } else if (!hasConfiguredProjectCwd) {
        warnings.push(
          `Project workspace has no local cwd configured. Using fallback workspace "${fallbackCwd}" for this run.`,
        );
      }
      return {
        cwd: fallbackCwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: projectWorkspaceRows[0]?.id ?? null,
        repoUrl: projectWorkspaceRows[0]?.repoUrl ?? null,
        repoRef: projectWorkspaceRows[0]?.repoRef ?? null,
        workspaceHints,
        warnings,
      };
    }

    if (workspaceProjectId) {
      const managedWorkspace = await ensureManagedProjectWorkspace({
        companyId: agent.companyId,
        projectId: workspaceProjectId,
        repoUrl: null,
      });
      return {
        cwd: managedWorkspace.cwd,
        source: "project_primary" as const,
        projectId: resolvedProjectId,
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        workspaceHints,
        warnings: managedWorkspace.warning ? [managedWorkspace.warning] : [],
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
          warnings: [],
        };
      }
    }

    const cwd = resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: "agent_home" as const,
      projectId: resolvedProjectId,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
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
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const sanitizedMessage = event.message
      ? redactCurrentUserText(event.message, currentUserRedactionOptions)
      : event.message;
    const sanitizedPayload = event.payload
      ? redactCurrentUserValue(event.payload, currentUserRedactionOptions)
      : event.payload;

    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq,
      eventType: event.eventType,
      stream: event.stream,
      level: event.level,
      color: event.color,
      message: sanitizedMessage,
      payload: sanitizedPayload,
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
        message: sanitizedMessage ?? null,
        payload: sanitizedPayload ?? null,
      },
    });
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function persistRunProcessMetadata(
    runId: string,
    meta: { pid: number; startedAt: string },
  ) {
    const startedAt = new Date(meta.startedAt);
    return db
      .update(heartbeatRuns)
      .set({
        processPid: meta.pid,
        processStartedAt: Number.isNaN(startedAt.getTime()) ? new Date() : startedAt,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function clearDetachedRunWarning(runId: string) {
    const updated = await db
      .update(heartbeatRuns)
      .set({
        error: null,
        errorCode: null,
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running"), eq(heartbeatRuns.errorCode, DETACHED_PROCESS_ERROR_CODE)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) return null;

    await appendRunEvent(updated, await nextRunEventSeq(updated.id), {
      eventType: "lifecycle",
      stream: "system",
      level: "info",
      message: "Detached child process reported activity; cleared detached warning",
    });
    return updated;
  }

  async function enqueueProcessLossRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    now: Date,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "process_lost_retry",
      retryReason: "process_lost",
    };

    const queued = await db.transaction(async (tx) => {
      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "process_lost_retry",
          payload: {
            ...(issueId ? { issueId } : {}),
            retryOfRunId: run.id,
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const retryRun = await tx
        .insert(heartbeatRuns)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: retryContextSnapshot,
          sessionIdBefore: sessionBefore,
          retryOfRunId: run.id,
          processLossRetryCount: (run.processLossRetryCount ?? 0) + 1,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: retryRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: retryRun.id,
            executionAgentNameKey: normalizeAgentNameKey(agent.name),
            executionLockedAt: now,
            updatedAt: now,
          })
          .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)));
      }

      return retryRun;
    });

    publishLiveEvent({
      companyId: queued.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: queued.id,
        agentId: queued.agentId,
        invocationSource: queued.invocationSource,
        triggerDetail: queued.triggerDetail,
        wakeupRequestId: queued.wakeupRequestId,
      },
    });

    await appendRunEvent(queued, 1, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "Queued automatic retry after orphaned child process was confirmed dead",
      payload: {
        retryOfRunId: run.id,
      },
    });

    return queued;
  }

  const parseHeartbeatPolicy = parseHeartbeatPolicyModule;

  async function countRunningRunsForAgent(agentId: string) {
    return countRunningRunsForAgentModule(db, agentId);
  }

  async function checkIterationLimits(
    agentId: string,
    companyId: string,
    issueId: string | null,
  ): Promise<string | null> {
    return checkIterationLimitsModule(db, agentId, companyId, issueId);
  }

  async function claimQueuedRun(run: typeof heartbeatRuns.$inferSelect) {
    if (run.status !== "queued") return run;
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(run.companyId, run.agentId, {
      issueId: readNonEmptyString(context.issueId),
      projectId: readNonEmptyString(context.projectId),
    });
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    // Iteration / loop cap check
    const iterationBlock = await checkIterationLimits(
      run.agentId,
      run.companyId,
      readNonEmptyString(context.issueId),
    );
    if (iterationBlock) {
      await cancelRunInternal(run.id, iterationBlock);
      return null;
    }

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

    // ── Item 7: Auto-recovery — pause after N consecutive failures ──────────
    // Check before writing status so we can override nextStatus to "paused".
    const schedulerSettings = await getSchedulerSettings(db).catch(() => null);
    const consecutiveFailureLimit = schedulerSettings?.consecutiveFailureLimit ?? 5;
    const costAnomalyMultiplier = schedulerSettings?.costAnomalyMultiplier ?? 5;

    let shouldAutoPause = false;
    if (outcome === "failed" && nextStatus === "error") {
      // Query the N most recent terminal runs for this agent (excluding currently
      // running/queued). "Process lost" errors from deploys are not real failures.
      const TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"];
      const recentRuns = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            inArray(heartbeatRuns.status, TERMINAL_STATUSES),
          ),
        )
        .orderBy(desc(heartbeatRuns.finishedAt))
        .limit(consecutiveFailureLimit);

      if (recentRuns.length === consecutiveFailureLimit) {
        const allFailed = recentRuns.every((r) => {
          // Skip process_lost errors (server restart / deploy bounce)
          if (r.errorCode === "process_lost") return false;
          return r.status === "failed" || r.status === "timed_out";
        });
        if (allFailed) {
          shouldAutoPause = true;
        }
      }
    }

    // Subscription-aware rate limiter: prevents runaway loops without
    // penalizing normal work. Designed for Ollama Cloud (session-based billing).
    // Replaces the old token-based cost anomaly breaker (PR #57).
    // Checks: per-agent runs/hour, total cluster runs/hour, and same-task stalls.
    let shouldRatePause = false;
    let ratePauseReason = "";
    if (!shouldAutoPause && runningCount === 0) {
      try {
        const { SUBSCRIPTION_RATE_LIMITS } = await import("@ironworksai/shared");
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

        // Check 1: Per-agent runs in the last hour
        const agentHourlyRuns = await db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, agentId),
              gt(heartbeatRuns.createdAt, oneHourAgo),
            ),
          )
          .then((rows) => rows[0]?.count ?? 0);

        if (agentHourlyRuns >= SUBSCRIPTION_RATE_LIMITS.perAgentPerHour) {
          shouldRatePause = true;
          ratePauseReason = `rate_limit: ${agentHourlyRuns} runs/hour (limit: ${SUBSCRIPTION_RATE_LIMITS.perAgentPerHour})`;
        }

        // Check 2: All agents combined runs in the last hour
        if (!shouldRatePause) {
          const clusterHourlyRuns = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, existing.companyId),
                gt(heartbeatRuns.createdAt, oneHourAgo),
              ),
            )
            .then((rows) => rows[0]?.count ?? 0);

          if (clusterHourlyRuns >= SUBSCRIPTION_RATE_LIMITS.allAgentsPerHour) {
            shouldRatePause = true;
            ratePauseReason = `cluster_rate_limit: ${clusterHourlyRuns} total runs/hour (limit: ${SUBSCRIPTION_RATE_LIMITS.allAgentsPerHour})`;
          }
        }

        if (shouldRatePause) {
          logger.warn(
            { agentId, companyId: existing.companyId, ratePauseReason },
            "Subscription rate limit triggered: agent paused",
          );
        }
      } catch (err) {
        logger.warn({ err, agentId }, "Rate limit check failed (non-fatal)");
      }
    }

    const effectiveStatus = shouldAutoPause || shouldRatePause ? "paused" : nextStatus;

    const updated = await db
      .update(agents)
      .set({
        status: effectiveStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
        ...(shouldAutoPause
          ? {
              pauseReason: `auto_paused: ${consecutiveFailureLimit} consecutive failures`,
              pausedAt: new Date(),
            }
          : shouldRatePause
            ? {
                pauseReason: `rate_limited: ${ratePauseReason}`,
                pausedAt: new Date(),
              }
            : {}),
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

      // If auto-paused, create a system issue and log activity (non-fatal)
      if (shouldAutoPause) {
        logger.warn({ agentId, companyId: updated.companyId, consecutiveFailureLimit }, "Agent auto-paused after consecutive failures");

        issuesSvc
          .create(updated.companyId, {
            title: `[System] Agent ${updated.name} paused after ${consecutiveFailureLimit} consecutive failures`,
            description: `The agent **${updated.name}** (${updated.role}) has been automatically paused after failing ${consecutiveFailureLimit} consecutive runs.\n\nPlease review the agent's configuration, adapter settings, and recent run logs, then resume the agent once the issue is resolved.`,
            priority: "high",
            status: "todo",
            createdByUserId: null,
            createdByAgentId: null,
          })
          .catch((err) => {
            logger.warn({ err, agentId }, "Failed to create auto-pause system issue");
          });

        logActivity(db, {
          companyId: updated.companyId,
          actorType: "system",
          actorId: agentId,
          action: "agent.auto_paused",
          entityType: "agent",
          entityId: agentId,
          agentId,
          details: { reason: `${consecutiveFailureLimit} consecutive failures`, name: updated.name },
        }).catch((err) => {
          logger.warn({ err, agentId }, "Failed to log agent.auto_paused activity");
        });
      }

      // Rate limit pause: create issue and log activity
      if (shouldRatePause) {
        issuesSvc
          .create(updated.companyId, {
            title: `[System] Agent ${updated.name} rate-limited`,
            description: `The agent **${updated.name}** (${updated.role}) has been automatically paused to protect subscription quotas.\n\nReason: ${ratePauseReason}\n\nThis prevents runaway loops from burning through provider session limits. The agent can be safely resumed once the rate window resets (hourly).`,
            priority: "high",
            status: "todo",
            createdByUserId: null,
            createdByAgentId: null,
          })
          .catch((err) => {
            logger.warn({ err, agentId }, "Failed to create rate-limit system issue");
          });

        logActivity(db, {
          companyId: updated.companyId,
          actorType: "system",
          actorId: agentId,
          action: "agent.rate_limited",
          entityType: "agent",
          entityId: agentId,
          agentId,
          details: { reason: ratePauseReason, name: updated.name },
        }).catch((err) => {
          logger.warn({ err, agentId }, "Failed to log agent.rate_limited activity");
        });
      }
    }
  }

  async function reapOrphanedRuns(opts?: { staleThresholdMs?: number }) {
    return reapOrphanedRunsModule(db, activeRunExecutions, {
      appendRunEvent,
      nextRunEventSeq,
      enqueueProcessLossRetry,
      releaseIssueExecutionAndPromote,
      finalizeAgentStatus,
      startNextQueuedRunForAgent,
      setRunStatus,
      setWakeupStatus,
      getRun,
    }, opts);
  }

  async function resumeQueuedRuns() {
    return resumeQueuedRunsModule(db, startNextQueuedRunForAgent);
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    await updateRuntimeStateModule(db, agent, run, {
      result,
      session,
      normalizedUsage,
      budgetHooks,
    });
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(0, policy.maxConcurrentRuns - runningCount);
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(availableSlots);
      if (queuedRuns.length === 0) return [];

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of queuedRuns) {
        const claimed = await claimQueuedRun(queuedRun);
        if (claimed) claimedRuns.push(claimed);
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

    activeRunExecutions.add(run.id);

    try {
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await setRunStatus(runId, "failed", {
        error: "Agent not found",
        errorCode: "agent_not_found",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: "Agent not found",
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const runtime = await ensureRuntimeState(agent);
    const context = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueId = readNonEmptyString(context.issueId);

    // ── Task 1: Least-Privilege Pre-Execution Warning ────────────────────────
    // Before execution, warn if a non-CEO agent has zero permission grants.
    // We allow execution to proceed (agents still need to work on their issues),
    // but log the warning so the board can grant appropriate permissions.
    try {
      const agentRoleLower = (agent.role ?? "").toLowerCase();
      const isCeoRole = /\b(ceo|chief executive)\b/.test(agentRoleLower);
      if (!isCeoRole) {
        const [grantCountRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(principalPermissionGrants)
          .where(
            and(
              eq(principalPermissionGrants.companyId, agent.companyId),
              eq(principalPermissionGrants.principalType, "agent"),
              eq(principalPermissionGrants.principalId, agent.id),
            ),
          );
        const grantCount = Number(grantCountRow?.count ?? 0);
        if (grantCount === 0) {
          logger.warn(
            { agentId: agent.id, companyId: agent.companyId, role: agent.role },
            "[least-privilege] Agent has zero permission grants - board should explicitly grant permissions",
          );
        }
      }
    } catch (err) {
      logger.debug({ err, agentId: agent.id }, "least-privilege check failed, skipping");
    }
    // ── End Least-Privilege Warning ──────────────────────────────────────────

    // ── Autonomy Enforcement ────────────────────────────────────────────────
    // h3 (Pre-Approval): create an approval request instead of executing when
    //   the task involves creating or modifying issues.
    // h4/h5 (Supervised/Human Only): skip execution entirely.
    const autonomyRuntimeConfig = parseObject(agent.runtimeConfig);
    const autonomyLevel = readNonEmptyString(autonomyRuntimeConfig.autonomyLevel);
    if (autonomyLevel === "h4" || autonomyLevel === "h5") {
      await setRunStatus(run.id, "cancelled", {
        error: `Execution skipped: autonomy level ${autonomyLevel} requires human to perform this work`,
        errorCode: "autonomy_blocked",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: new Date() });
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        action: "agent.run_skipped",
        entityType: "agent",
        entityId: agent.id,
        details: {
          reason: "autonomy_blocked",
          autonomyLevel,
          issueId: issueId ?? null,
          phase: "plan",
        },
      });
      await finalizeAgentStatus(agent.id, "cancelled");
      return;
    }

    if (autonomyLevel === "h3" && issueId) {
      // h3 Pre-Approval: create an approval request before acting on issue work
      const { approvals: approvalsTable } = await import("@ironworksai/db");
      const existingApproval = await db
        .select({ id: approvalsTable.id, status: approvalsTable.status })
        .from(approvalsTable)
        .where(
          and(
            eq(approvalsTable.companyId, agent.companyId),
            eq(approvalsTable.type, "approve_ceo_strategy"),
            sql`${approvalsTable.payload} ->> 'issueId' = ${issueId}`,
            sql`${approvalsTable.status} in ('pending', 'revision_requested')`,
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!existingApproval) {
        const issueLabel = issueId.slice(0, 8);
        await db.insert(approvalsTable).values({
          companyId: agent.companyId,
          type: "approve_ceo_strategy",
          status: "pending",
          requestedByAgentId: agent.id,
          requestedByUserId: null,
          payload: {
            runId: run.id,
            issueId,
            agentId: agent.id,
            autonomyLevel: "h3",
            note: `Pre-approval required before agent acts on issue ${issueLabel}`,
          },
        });
      }

      await setRunStatus(run.id, "cancelled", {
        error: `Pre-approval required (h3): pending board approval before acting on issue ${issueId.slice(0, 8)}`,
        errorCode: "approval_required",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: new Date() });
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "system",
        actorId: agent.id,
        agentId: agent.id,
        runId: run.id,
        action: "agent.approval_requested",
        entityType: "issue",
        entityId: issueId,
        details: {
          reason: "autonomy_h3_pre_approval",
          autonomyLevel: "h3",
          issueId,
          phase: "plan",
        },
      });
      await finalizeAgentStatus(agent.id, "cancelled");
      return;
    }
    // ── Progressive Budget Gates ─────────────────────────────────────────────
    // Check if the agent's daily spend exceeds the gate for its lifecycle stage.
    // If >100% of gate: cancel run and pause agent.
    // If >80% of gate: reduce maxOutputTokens by 50% (throttle).
    {
      const { BUDGET_GATES } = await import("@ironworksai/shared");
      const agentMeta = (agent.metadata as Record<string, unknown> | null) ?? {};
      const lifecycleStage = typeof agentMeta.lifecycleStage === "string"
        ? agentMeta.lifecycleStage as keyof typeof BUDGET_GATES
        : "pilot";
      const dailyGateCents = BUDGET_GATES[lifecycleStage] ?? BUDGET_GATES.pilot;

      if (dailyGateCents > 0) {
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const [spendRow] = await db
          .select({ totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.agentId, agent.id),
              eq(costEvents.companyId, agent.companyId),
              gte(costEvents.occurredAt, todayStart),
            ),
          );
        const dailySpendCents = Number(spendRow?.totalCents ?? 0);

        if (dailySpendCents >= dailyGateCents) {
          // Hard stop: pause agent and cancel run
          await db
            .update(agents)
            .set({ status: "paused", pauseReason: "budget", pausedAt: new Date(), updatedAt: new Date() })
            .where(eq(agents.id, agent.id));

          await setRunStatus(run.id, "cancelled", {
            error: `Daily budget gate exceeded: $${(dailySpendCents / 100).toFixed(2)} of $${(dailyGateCents / 100).toFixed(2)} limit for ${lifecycleStage} stage`,
            errorCode: "budget_gate_exceeded",
            finishedAt: new Date(),
          });
          await logActivity(db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: agent.id,
            agentId: agent.id,
            runId: run.id,
            action: "agent.paused",
            entityType: "agent",
            entityId: agent.id,
            details: {
              reason: "budget_gate_exceeded",
              lifecycleStage,
              dailySpendCents,
              dailyGateCents,
            },
          });
          return;
        }

        if (dailySpendCents >= dailyGateCents * 0.8) {
          // Throttle: halve the output token cap and log
          const originalCap = resolveMaxOutputTokens(parseObject(agent.adapterConfig), context, run.invocationSource ?? null);
          const throttledCap = Math.max(256, Math.floor(originalCap * 0.5));
          // Store throttle cap in context for resolveMaxOutputTokens to pick up
          (context as Record<string, unknown>).ironworksBudgetThrottledTokenCap = throttledCap;

          await logActivity(db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: agent.id,
            agentId: agent.id,
            runId: run.id,
            action: "agent.throttled",
            entityType: "agent",
            entityId: agent.id,
            details: {
              reason: "budget_gate_80pct",
              lifecycleStage,
              dailySpendCents,
              dailyGateCents,
              originalTokenCap: originalCap,
              throttledTokenCap: throttledCap,
            },
          });
        }
      }
    }
    // ── End Progressive Budget Gates ──────────────────────────────────────────

    // ── Idle Fast-Path: skip LLM if timer-driven and no assigned work ────────
    if (
      (run.invocationSource === "timer" || readNonEmptyString(context.reason) === "heartbeat_timer") &&
      !issueId
    ) {
      const { hasAssignedWork } = await import("./heartbeat-scheduling.js");
      const hasWork = await hasAssignedWork(db, agent.id, agent.companyId);
      if (!hasWork) {
        await setRunStatus(run.id, "cancelled", {
          error: "Idle skip - no assigned work",
          errorCode: "idle_skip",
          finishedAt: new Date(),
        });
        await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: new Date() });
        logger.debug({ agentId: agent.id, runId: run.id }, "Idle skip - no assigned work");
        await finalizeAgentStatus(agent.id, "cancelled");
        return;
      }
    }
    // ── End Idle Fast-Path ──────────────────────────────────────────────────

    // ── End Autonomy Enforcement ─────────────────────────────────────────────
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
            goalId: issues.goalId,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const issueAssigneeOverrides =
      issueContext && issueContext.assigneeAgentId === agent.id
        ? parseIssueAssigneeAdapterOverrides(
            issueContext.assigneeAdapterOverrides,
          )
        : null;
    const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
    const issueExecutionWorkspaceSettings = isolatedWorkspacesEnabled
      ? parseIssueExecutionWorkspaceSettings(issueContext?.executionWorkspaceSettings)
      : null;
    const contextProjectId = readNonEmptyString(context.projectId);
    const executionProjectId = issueContext?.projectId ?? contextProjectId;
    const projectExecutionWorkspacePolicy = executionProjectId
      ? await db
          .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) =>
            gateProjectExecutionWorkspacePolicy(
              parseProjectExecutionWorkspacePolicy(rows[0]?.executionWorkspacePolicy),
              isolatedWorkspacesEnabled,
            ))
      : null;
    const taskSession = taskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, taskKey)
      : null;
    const resetTaskSession = shouldResetTaskSessionForWake(context);
    const sessionResetReason = describeSessionResetReason(context);
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const explicitResumeSessionParams = normalizeSessionParams(
      sessionCodec.deserialize(parseObject(context.resumeSessionParams)),
    );
    const explicitResumeSessionDisplayId = truncateDisplayId(
      readNonEmptyString(context.resumeSessionDisplayId) ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(explicitResumeSessionParams) : null) ??
        readNonEmptyString(explicitResumeSessionParams?.sessionId),
    );
    const previousSessionParams =
      explicitResumeSessionParams ??
      (explicitResumeSessionDisplayId ? { sessionId: explicitResumeSessionDisplayId } : null) ??
      normalizeSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null));
    const config = parseObject(agent.adapterConfig);
    const executionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: executionWorkspaceMode !== "agent_default" },
    );
    const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig({
      agentConfig: config,
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      mode: executionWorkspaceMode,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...workspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : workspaceManagedConfig;
    const { config: resolvedConfig, secretKeys } = await secretsSvc.resolveAdapterConfigForRuntime(
      agent.companyId,
      mergedConfig,
    );
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);

    // Task 1: Output Token Budget Caps - inject max_tokens based on task type
    const maxOutputTokens = resolveMaxOutputTokens(resolvedConfig, context, run.invocationSource);

    // Task 2: Skill Allowlists - filter skills if agent has a skillAllowlist
    const skillAllowlist = Array.isArray(resolvedConfig.skillAllowlist)
      ? resolvedConfig.skillAllowlist.filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
      : null;
    const filteredSkillEntries = skillAllowlist
      ? runtimeSkillEntries.filter((entry: { key: string; required?: boolean }) =>
          entry.required || skillAllowlist.some((allowed: string) => entry.key === allowed || entry.key.includes(allowed)))
      : runtimeSkillEntries;

    const runtimeConfig = {
      ...resolvedConfig,
      ironworksRuntimeSkills: filteredSkillEntries,
      maxOutputTokens,
    };
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspace = await realizeExecutionWorkspace({
      base: {
        baseCwd: resolvedWorkspace.cwd,
        source: resolvedWorkspace.source,
        projectId: resolvedWorkspace.projectId,
        workspaceId: resolvedWorkspace.workspaceId,
        repoUrl: resolvedWorkspace.repoUrl,
        repoRef: resolvedWorkspace.repoRef,
      },
      config: runtimeConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      recorder: workspaceOperationRecorder,
    });
    const resolvedProjectId = executionWorkspace.projectId ?? issueRef?.projectId ?? executionProjectId ?? null;
    const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    let persistedExecutionWorkspace = null;
    try {
      persistedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
        ? await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: executionWorkspace.branchName,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: {
              ...(existingExecutionWorkspace.metadata ?? {}),
              source: executionWorkspace.source,
              createdByRuntime: executionWorkspace.created,
            },
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                executionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : executionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : executionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: executionWorkspace.branchName ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: executionWorkspace.branchName,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: {
                source: executionWorkspace.source,
                createdByRuntime: executionWorkspace.created,
              },
            })
          : null;
    } catch (error) {
      if (executionWorkspace.created) {
        try {
          await cleanupExecutionWorkspaceArtifacts({
            workspace: {
              id: existingExecutionWorkspace?.id ?? `transient-${run.id}`,
              cwd: executionWorkspace.cwd,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              branchName: executionWorkspace.branchName,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              metadata: {
                createdByRuntime: true,
                source: executionWorkspace.source,
              },
            },
            projectWorkspace: {
              cwd: resolvedWorkspace.cwd,
              cleanupCommand: null,
            },
            teardownCommand: projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
            recorder: workspaceOperationRecorder,
          });
        } catch (cleanupError) {
          logger.warn(
            {
              runId: run.id,
              issueId,
              executionWorkspaceCwd: executionWorkspace.cwd,
              cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            },
            "Failed to cleanup realized execution workspace after persistence failure",
          );
        }
      }
      throw error;
    }
    await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
    if (
      existingExecutionWorkspace &&
      persistedExecutionWorkspace &&
      existingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
      existingExecutionWorkspace.status === "active"
    ) {
      await executionWorkspacesSvc.update(existingExecutionWorkspace.id, {
        status: "idle",
        cleanupReason: null,
      });
    }
    if (issueId && persistedExecutionWorkspace) {
      const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
      const shouldSwitchIssueToExistingWorkspace =
        issueRef?.executionWorkspacePreference === "reuse_existing" ||
        executionWorkspaceMode === "isolated_workspace" ||
        executionWorkspaceMode === "operator_branch";
      const nextIssuePatch: Record<string, unknown> = {};
      if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
        nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
      }
      if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
        nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
      }
      if (shouldSwitchIssueToExistingWorkspace) {
        nextIssuePatch.executionWorkspacePreference = "reuse_existing";
        nextIssuePatch.executionWorkspaceSettings = {
          ...(issueExecutionWorkspaceSettings ?? {}),
          mode: nextIssueWorkspaceMode,
        };
      }
      if (Object.keys(nextIssuePatch).length > 0) {
        await issuesSvc.update(issueId, nextIssuePatch);
      }
    }
    if (persistedExecutionWorkspace) {
      context.executionWorkspaceId = persistedExecutionWorkspace.id;
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: context,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, run.id));
    }
    const runtimeSessionResolution = resolveRuntimeSessionParamsForWorkspace({
      agentId: agent.id,
      previousSessionParams,
      resolvedWorkspace: {
        ...resolvedWorkspace,
        cwd: executionWorkspace.cwd,
      },
    });
    const runtimeSessionParams = runtimeSessionResolution.sessionParams;
    const runtimeWorkspaceWarnings = [
      ...resolvedWorkspace.warnings,
      ...executionWorkspace.warnings,
      ...(runtimeSessionResolution.warning ? [runtimeSessionResolution.warning] : []),
      ...(resetTaskSession && sessionResetReason
        ? [
            taskKey
              ? `Skipping saved session resume for task "${taskKey}" because ${sessionResetReason}.`
              : `Skipping saved session resume because ${sessionResetReason}.`,
          ]
        : []),
    ];
    // Inject contractor onboarding packet into context if present
    const agentRuntimeConfig = parseObject(agent.runtimeConfig);
    const onboardingPacket = agentRuntimeConfig.onboardingPacket as {
      companyBrief?: string;
      projectScope?: string | null;
      kbPageSummaries?: Array<{ slug: string; title: string; excerpt: string }>;
      teamContacts?: Array<{ name: string; role: string; agentId: string }>;
    } | null;
    if (onboardingPacket && typeof onboardingPacket === "object") {
      const sections: string[] = [];
      if (onboardingPacket.companyBrief) {
        sections.push(`## Company Context (Contractor Onboarding)\n${onboardingPacket.companyBrief}`);
      }
      if (onboardingPacket.projectScope) {
        sections.push(`## Project Scope\n${onboardingPacket.projectScope}`);
      }
      if (onboardingPacket.kbPageSummaries && onboardingPacket.kbPageSummaries.length > 0) {
        const kbLines = onboardingPacket.kbPageSummaries.map(
          (p) => `- **${p.title}** (${p.slug}): ${p.excerpt}`,
        );
        sections.push(`## Key Knowledge\n${kbLines.join("\n")}`);
      }
      if (onboardingPacket.teamContacts && onboardingPacket.teamContacts.length > 0) {
        const contactLines = onboardingPacket.teamContacts.map(
          (c) => `- ${c.name} (${c.role})`,
        );
        sections.push(`## Team Contacts\n${contactLines.join("\n")}`);
      }
      if (sections.length > 0) {
        context.ironworksOnboardingContext = sections.join("\n\n");
      }
    }

    // Inject provider-agnostic agent instructions from DB columns into context
    // so ALL adapter types (ollama_cloud, process, http, etc.) receive them.
    if (typeof agent.systemPrompt === "string" && agent.systemPrompt) {
      context.systemPrompt = agent.systemPrompt;
    }
    if (typeof agent.agentInstructions === "string" && agent.agentInstructions) {
      context.agentInstructions = agent.agentInstructions;
    }

    // Inject platform awareness — runs every heartbeat, gives agents a full
    // mental model of their capabilities whether or not they have an issue.
    injectPlatformAwareness(context, agent);

    // Inject session state and morning briefing based on context tier
    await injectSessionContext(db, context, agent.id);

    // ── Context assembly: delegate to heartbeat-context.ts inject functions ──
    await injectChannelMessagesCtx(db, context, agent);
    injectChannelPostingInstruction(context);
    injectConfidenceTagging(context);
    await injectQualityExamples(db, context, agent.id);
    // Lazy context: when IRONWORKS_LAZY_CONTEXT=true, skip always-on injection
    // of onboarding replay and recent documents. Agents fetch these on demand
    // via the lookup endpoints (or via tools once tool routing is wired up).
    // This cuts ~5-15k tokens off every heartbeat for established agents.
    const lazyContext = process.env.IRONWORKS_LAZY_CONTEXT === "true";
    if (!lazyContext) {
      await injectOnboardingReplay(db, context, agent);
    }
    await injectPendingMentions(db, context, agent);
    await injectPendingDeliberations(db, context, agent);
    await injectChannelHealth(db, context, agent);
    await injectCognitiveLoadReport(db, context, agent);
    await injectContextDriftWarning(db, context, agent.id, agent.companyId);
    const agentRuntimeSnapshotForCtx = await getRuntimeState(agent.id);
    await injectContextUtilizationNote(
      db,
      context,
      agent.id,
      agent.companyId,
      Number(agentRuntimeSnapshotForCtx?.totalInputTokens ?? 0),
    );
    await injectTaskTypeClassification(db, context, issueId, issueContext ? { title: issueContext.title ?? "" } : null);
    // Lazy context flag also gates recent documents (always-on injection
    // ~1-3k tokens per heartbeat). Agents fetch via knowledge endpoints.
    if (!lazyContext) {
      await injectRecentDocuments(db, context, agent.id, agent.companyId);
    }
    await injectBatchedTasks(db, context, agent.id, agent.companyId, issueId);
    // issueContext does not include description column - web research uses context.issueTitle from context
    await injectWebResearch(db, context, agent.id, null);
    await injectDeadlineUrgency(db, context, agent.id, agent.companyId);
    await injectDependencyContext(db, context);
    await injectGoalContext(db, context, issueContext?.goalId ?? null);

    // Playbook RAG: retrieve top-3 relevant playbook chunks for this task.
    // Gated on IRONWORKS_PLAYBOOK_RAG (default on). Per-agent 1hr cache.
    await injectPlaybookGuidance(
      db,
      context,
      {
        id: agent.id,
        companyId: agent.companyId,
        role: agent.role,
        department: agent.department,
      },
      issueContext?.title ?? null,
      typeof context.issueContext === "string" ? context.issueContext : null,
    );

    context.ironworksWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: executionWorkspaceMode,
      strategy: executionWorkspace.strategy,
      projectId: executionWorkspace.projectId,
      workspaceId: executionWorkspace.workspaceId,
      repoUrl: executionWorkspace.repoUrl,
      repoRef: executionWorkspace.repoRef,
      branchName: executionWorkspace.branchName,
      worktreePath: executionWorkspace.worktreePath,
      agentHome: await (async () => {
        const home = resolveDefaultAgentWorkspaceDir(agent.id);
        await fs.mkdir(home, { recursive: true });
        return home;
      })(),
    };
    context.ironworksWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.ironworksRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.ironworksRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = taskKey || resetTaskSession ? null : runtime.sessionId;
    let previousSessionDisplayId = truncateDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.ironworksSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.ironworksSessionRotationReason = sessionCompaction.reason;
      context.ironworksPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.ironworksSessionHandoffMarkdown;
      delete context.ironworksSessionRotationReason;
      delete context.ironworksPreviousSessionId;
    }

    const runtimeForAdapter = {
      sessionId: runtimeSessionIdForAdapter,
      sessionParams: runtimeSessionParamsForAdapter,
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
      // PDCA: Plan phase - analyzing task before execution
      await appendRunEvent(currentRun, seq++, {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message: "run started",
        payload: {
          phase: "plan",
          details: issueId ? `Analyzing issue ${issueId}` : "Analyzing task",
        },
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

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = redactCurrentUserText(chunk, currentUserRedactionOptions);
        if (stream === "stdout") stdoutExcerpt = appendExcerpt(stdoutExcerpt, sanitizedChunk);
        if (stream === "stderr") stderrExcerpt = appendExcerpt(stderrExcerpt, sanitizedChunk);
        const ts = new Date().toISOString();

        if (handle) {
          await runLogStore.append(handle, {
            stream,
            chunk: sanitizedChunk,
            ts,
          });
        }

        const payloadChunk =
          sanitizedChunk.length > MAX_LIVE_LOG_CHUNK_BYTES
            ? sanitizedChunk.slice(sanitizedChunk.length - MAX_LIVE_LOG_CHUNK_BYTES)
            : sanitizedChunk;

        publishLiveEvent({
          companyId: run.companyId,
          type: "heartbeat.run.log",
          payload: {
            runId: run.id,
            agentId: run.agentId,
            ts,
            stream,
            chunk: payloadChunk,
            truncated: payloadChunk.length !== sanitizedChunk.length,
          },
        });
      };
      for (const warning of runtimeWorkspaceWarnings) {
        const logEntry = formatRuntimeWorkspaceWarningLog(warning);
        await onLog(logEntry.stream, logEntry.chunk);
      }
      const adapterEnv = Object.fromEntries(
        Object.entries(parseObject(resolvedConfig.env)).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      );
      const runtimeServices = await ensureRuntimeServicesForRun({
        db,
        runId: run.id,
        agent: {
          id: agent.id,
          name: agent.name,
          companyId: agent.companyId,
        },
        issue: issueRef,
        workspace: executionWorkspace,
        executionWorkspaceId: persistedExecutionWorkspace?.id ?? issueRef?.executionWorkspaceId ?? null,
        config: resolvedConfig,
        adapterEnv,
        onLog,
      });
      if (runtimeServices.length > 0) {
        context.ironworksRuntimeServices = runtimeServices;
        context.ironworksRuntimePrimaryUrl =
          runtimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
      }
      if (issueId && (executionWorkspace.created || runtimeServices.some((service) => !service.reused))) {
        try {
          await issuesSvc.addComment(
            issueId,
            buildWorkspaceReadyComment({
              workspace: executionWorkspace,
              runtimeServices,
            }),
            { agentId: agent.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[ironworks] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        // PDCA: Do phase - executing task
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: {
            ...(meta as unknown as Record<string, unknown>),
            phase: "do",
            details: "Executing task",
          },
        });
      };

      // ── Model Routing Cascade ────────────────────────────────────────────
      const runtimeConfigAny = runtimeConfig as Record<string, unknown>;
      const routingEnabled = typeof runtimeConfigAny.modelRoutingEnabled === "boolean"
        ? runtimeConfigAny.modelRoutingEnabled
        : true;
      const configuredModel = typeof runtimeConfigAny.model === "string" ? runtimeConfigAny.model : "";
      const taskComplexity = classifyTaskComplexity({
        wakeReason: typeof context.wakeReason === "string" ? context.wakeReason : "",
        hasNewComments: typeof context.wakeCommentId === "string" && context.wakeCommentId.length > 0,
        issueCount: Array.isArray(context.issueIds) ? context.issueIds.length : (typeof context.issueId === "string" && context.issueId.length > 0 ? 1 : 0),
        isApprovalNeeded: typeof context.approvalId === "string" && context.approvalId.length > 0,
      });
      let routedModel = selectModelForComplexity(taskComplexity, configuredModel, routingEnabled);

      // Fix 4: Check for escalation flag persisted from previous run.
      // If set, override to complex model tier and clear the flag.
      try {
        const escalationState = await getRuntimeState(agent.id);
        const stateJson = escalationState?.stateJson as Record<string, unknown> | undefined;
        if (stateJson?.escalateNextRun === true || stateJson?.escalateNextRun === "true") {
          await db.update(agentRuntimeState)
            .set({ stateJson: sql`jsonb_set(coalesce(state_json, '{}'), '{escalateNextRun}', 'false')` })
            .where(eq(agentRuntimeState.agentId, agent.id));
          routedModel = selectModelForComplexity("complex", configuredModel, true);
          logger.info(
            { agentId: agent.id, runId: run.id, routedModel },
            "[model-routing] Escalation flag triggered complex model override",
          );
        }
      } catch { /* non-fatal: escalation flag check must not block the run */ }

      const routingApplied = routedModel && routedModel !== configuredModel;
      if (routingApplied) {
        logger.info(
          { agentId: agent.id, runId: run.id, complexity: taskComplexity, from: configuredModel, to: routedModel },
          "[model-routing] Model overridden by complexity routing",
        );
      }
      const routedRuntimeConfig = routingApplied
        ? { ...runtimeConfig, model: routedModel }
        : runtimeConfig;
      // ─────────────────────────────────────────────────────────────────────

      const adapter = getServerAdapter(agent.adapterType);
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
          "local agent jwt secret missing or invalid; running without injected IRONWORKS_API_KEY",
        );
      }

      // ── Multi-Model Council Execution ──────────────────────────────────
      // Classify task importance and resolve the execution strategy.
      // Critical tasks auto-upgrade to council; important tasks to cascade.
      const councilLabels: string[] = [];
      try {
        if (typeof context.issueId === "string" && context.issueId.length > 0) {
          const councilLabelRows = await db
            .select({ name: labels.name })
            .from(issueLabels)
            .innerJoin(labels, eq(issueLabels.labelId, labels.id))
            .where(eq(issueLabels.issueId, context.issueId as string));
          for (const r of councilLabelRows) councilLabels.push(r.name);
        }
      } catch (_labelErr) {
        // Best-effort label fetch for council classification
      }

      const normalizedAgentRole = (typeof agent.role === "string" ? agent.role : "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
      // Determine delegation context for importance classification
      const issueCreatorRole = typeof context.issueCreatorRole === "string" ? context.issueCreatorRole : "";
      const isHumanAssigned = context.invocationSource === "board" || context.invocationSource === "user";
      const isRetry = typeof context.retryCount === "number" && context.retryCount > 0;
      const originKind = typeof context.originKind === "string" ? context.originKind : "";

      const taskImportance = classifyTaskImportance({
        labels: councilLabels,
        issueTitle: typeof context.issueTitle === "string" ? context.issueTitle : "",
        agentRole: normalizedAgentRole,
        isApprovalRelated: typeof context.approvalId === "string" && context.approvalId.length > 0,
        assignedByRole: issueCreatorRole,
        assignedByHuman: isHumanAssigned,
        isRetry,
        originKind,
      });

      const roleDefaults = ROLE_COUNCIL_DEFAULTS[normalizedAgentRole];
      const councilConfig: CouncilConfig = {
        strategy: (runtimeConfigAny.modelStrategy as string as "single" | "cascade" | "council") ?? roleDefaults?.strategy ?? "single",
        primaryModel: routedModel || configuredModel || "kimi-k2.5",
        cascadeFallback: WESTERN_COUNCIL_MODELS.heavy,
        councilModels: roleDefaults?.councilModels ?? [WESTERN_COUNCIL_MODELS.heavy, WESTERN_COUNCIL_MODELS.light],
        qualityThreshold: 60,
      };

      const resolvedStrategy = resolveModelStrategy(taskImportance, councilConfig);

      // Create adapter executor that runs a given model through the same adapter
      const executeWithModel = async (modelOverride: string) => {
        const modelConfig = { ...routedRuntimeConfig, model: modelOverride };
        return adapter.execute({
          runId: run.id,
          agent,
          runtime: runtimeForAdapter,
          config: modelConfig,
          context,
          onLog,
          onMeta: onAdapterMeta,
          onSpawn: async (meta) => {
            await persistRunProcessMetadata(run.id, meta);
          },
          authToken: authToken ?? undefined,
        });
      };

      let councilResult: CouncilResult;
      let adapterResult: AdapterExecutionResult;

      if (resolvedStrategy.strategy === "council" && resolvedStrategy.models.length >= 2) {
        logger.info(
          { agentId: agent.id, runId: run.id, importance: taskImportance, strategy: "council", models: resolvedStrategy.models },
          "[model-council] Running council deliberation",
        );
        councilResult = await executeCouncil(executeWithModel, resolvedStrategy.models);
        // Build a synthetic adapterResult from the winning council response
        // to avoid re-executing the model unnecessarily.
        adapterResult = {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: councilResult.winningResponse,
          model: councilResult.winningModel,
        };
      } else if (resolvedStrategy.strategy === "cascade" && resolvedStrategy.models.length >= 2) {
        logger.info(
          { agentId: agent.id, runId: run.id, importance: taskImportance, strategy: "cascade", models: resolvedStrategy.models },
          "[model-council] Running cascade execution",
        );
        councilResult = await executeCascade(
          executeWithModel,
          resolvedStrategy.models[0],
          resolvedStrategy.models[1],
          councilConfig.qualityThreshold,
        );
        // Build a synthetic adapterResult from the winning cascade response
        adapterResult = {
          exitCode: 0,
          signal: null,
          timedOut: false,
          summary: councilResult.winningResponse,
          model: councilResult.winningModel,
        };
      } else {
        // Single model execution (existing behavior)
        adapterResult = await adapter.execute({
          runId: run.id,
          agent,
          runtime: runtimeForAdapter,
          config: routedRuntimeConfig,
          context,
          onLog,
          onMeta: onAdapterMeta,
          onSpawn: async (meta) => {
            await persistRunProcessMetadata(run.id, meta);
          },
          authToken: authToken ?? undefined,
        });
        councilResult = {
          strategy: "single",
          winningModel: routedModel || configuredModel || "",
          winningResponse: adapterResult.summary ?? "",
          responses: [{
            model: routedModel || configuredModel || "",
            response: adapterResult.summary ?? "",
            qualityScore: 0,
            latencyMs: 0,
          }],
          retryCount: 0,
          totalTokensUsed: 0,
        };
      }

      // Log council result for non-single strategies
      if (resolvedStrategy.strategy !== "single") {
        logActivity(db, {
          companyId: agent.companyId,
          actorType: "system",
          actorId: agent.id,
          agentId: agent.id,
          runId: run.id,
          action: "model_council.completed",
          entityType: "heartbeat_run",
          entityId: run.id,
          details: {
            strategy: resolvedStrategy.strategy,
            importance: taskImportance,
            winningModel: councilResult.winningModel,
            models: councilResult.responses.map((r) => ({ model: r.model, score: r.qualityScore })),
            retryCount: councilResult.retryCount,
            totalTokensUsed: councilResult.totalTokensUsed,
          },
        }).catch(() => {});
      }
      // ── End Multi-Model Council Execution ──────────────────────────────

      // ── Confidence-Based Escalation Check ────────────────────────────────
      // Only check when a cheap model was used (routing changed the model).
      if (routingApplied && taskComplexity === "routine") {
        const responseSummary = adapterResult.summary ?? "";
        if (shouldEscalateModel(responseSummary)) {
          logEscalationSignal(agent.id, run.id, "cheap-model uncertainty detected in summary");
          // Fix 4: Persist escalation flag so the next run uses the complex model tier.
          try {
            await db.update(agentRuntimeState)
              .set({ stateJson: sql`jsonb_set(coalesce(state_json, '{}'), '{escalateNextRun}', 'true')` })
              .where(eq(agentRuntimeState.agentId, agent.id));
          } catch { /* non-fatal */ }
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // ── Task 8: Streaming Response Cutoff ────────────────────────────────
      // If the output contains a clear completion marker followed by >500 chars
      // of padding content, truncate at the marker to save tokens on future runs.
      {
        const output = adapterResult.summary ?? "";
        if (output.length > 0) {
          for (const marker of COMPLETION_MARKERS) {
            const markerIdx = output.indexOf(marker);
            if (markerIdx !== -1) {
              const afterMarker = output.slice(markerIdx + marker.length);
              if (afterMarker.length > 500) {
                // Truncate at the marker and log the token-saving event
                (adapterResult as unknown as Record<string, unknown>).summary = output.slice(0, markerIdx + marker.length);
                logger.info(
                  {
                    agentId: agent.id,
                    runId: run.id,
                    marker,
                    truncatedChars: afterMarker.length,
                  },
                  "[output-cutoff] Truncated output at completion marker to save tokens",
                );
                await logActivity(db, {
                  companyId: agent.companyId,
                  actorType: "system",
                  actorId: agent.id,
                  agentId: agent.id,
                  runId: run.id,
                  action: "agent.output_truncated",
                  entityType: "heartbeat_run",
                  entityId: run.id,
                  details: { marker, truncatedChars: afterMarker.length, reason: "completion_marker_cutoff" },
                }).catch(() => {});
                break;
              }
            }
          }
        }
      }
      // ── End Streaming Response Cutoff ─────────────────────────────────────

      const adapterManagedRuntimeServices = adapterResult.runtimeServices
        ? await persistAdapterManagedRuntimeServices({
            db,
            adapterType: agent.adapterType,
            runId: run.id,
            agent: {
              id: agent.id,
              name: agent.name,
              companyId: agent.companyId,
            },
            issue: issueRef,
            workspace: executionWorkspace,
            reports: adapterResult.runtimeServices,
          })
        : [];
      if (adapterManagedRuntimeServices.length > 0) {
        const combinedRuntimeServices = [
          ...runtimeServices,
          ...adapterManagedRuntimeServices,
        ];
        context.ironworksRuntimeServices = combinedRuntimeServices;
        context.ironworksRuntimePrimaryUrl =
          combinedRuntimeServices.find((service) => readNonEmptyString(service.url))?.url ?? null;
        await db
          .update(heartbeatRuns)
          .set({
            contextSnapshot: context,
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));
        if (issueId) {
          try {
            await issuesSvc.addComment(
              issueId,
              buildWorkspaceReadyComment({
                workspace: executionWorkspace,
                runtimeServices: adapterManagedRuntimeServices,
              }),
              { agentId: agent.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[ironworks] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
      }
      const nextSessionState = resolveNextSessionState({
        codec: sessionCodec,
        adapterResult,
        previousParams: previousSessionParams,
        previousDisplayId: runtimeForAdapter.sessionDisplayId,
        previousLegacySessionId: runtimeForAdapter.sessionId,
      });
      const rawUsage = normalizeUsageTotals(adapterResult.usage);
      const sessionUsageResolution = await resolveNormalizedUsageForSession({
        agentId: agent.id,
        runId: run.id,
        sessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        rawUsage,
      });
      const normalizedUsage = sessionUsageResolution.normalizedUsage;

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

      const usageJson =
        normalizedUsage || adapterResult.costUsd != null
          ? ({
              ...(normalizedUsage ?? {}),
              ...(rawUsage ? {
                rawInputTokens: rawUsage.inputTokens,
                rawCachedInputTokens: rawUsage.cachedInputTokens,
                rawOutputTokens: rawUsage.outputTokens,
              } : {}),
              ...(sessionUsageResolution.derivedFromSessionTotals ? { usageSource: "session_delta" } : {}),
              ...((nextSessionState.displayId ?? nextSessionState.legacySessionId)
                ? { persistedSessionId: nextSessionState.displayId ?? nextSessionState.legacySessionId }
                : {}),
              sessionReused: runtimeForAdapter.sessionId != null || runtimeForAdapter.sessionDisplayId != null,
              taskSessionReused: taskSessionForRun != null,
              freshSession: runtimeForAdapter.sessionId == null && runtimeForAdapter.sessionDisplayId == null,
              sessionRotated: sessionCompaction.rotate,
              sessionRotationReason: sessionCompaction.reason,
              provider: readNonEmptyString(adapterResult.provider) ?? "unknown",
              biller: resolveLedgerBiller(adapterResult),
              model: readNonEmptyString(adapterResult.model) ?? "unknown",
              ...(adapterResult.costUsd != null ? { costUsd: adapterResult.costUsd } : {}),
              billingType: normalizeLedgerBillingType(adapterResult.billingType),
            } as Record<string, unknown>)
          : null;

      await setRunStatus(run.id, status, {
        finishedAt: new Date(),
        error:
          outcome === "succeeded"
            ? null
            : redactCurrentUserText(
                adapterResult.errorMessage ?? (outcome === "timed_out" ? "Timed out" : "Adapter failed"),
                currentUserRedactionOptions,
              ),
        errorCode:
          outcome === "timed_out"
            ? "timeout"
            : outcome === "cancelled"
              ? "cancelled"
              : outcome === "failed"
                ? (adapterResult.errorCode ?? "adapter_failed")
                : null,
        exitCode: adapterResult.exitCode,
        signal: adapterResult.signal,
        usageJson,
        resultJson: adapterResult.resultJson ?? null,
        sessionIdAfter: nextSessionState.displayId ?? nextSessionState.legacySessionId,
        stdoutExcerpt,
        stderrExcerpt,
        logBytes: logSummary?.bytes,
        logSha256: logSummary?.sha256,
        logCompressed: logSummary?.compressed ?? false,
      });

      await setWakeupStatus(run.wakeupRequestId, outcome === "succeeded" ? "completed" : status, {
        finishedAt: new Date(),
        error: adapterResult.errorMessage ?? null,
      });

      const finalizedRun = await getRun(run.id);
      if (finalizedRun) {
        // PDCA: Check phase - reviewing run outcome
        await appendRunEvent(finalizedRun, seq++, {
          eventType: "lifecycle",
          stream: "system",
          level: outcome === "succeeded" ? "info" : "error",
          message: `run ${outcome}`,
          payload: {
            status,
            exitCode: adapterResult.exitCode,
            phase: "check",
            details: `Run ${outcome}`,
          },
        });
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      // Extract and log agent decisions from the run result
      if (finalizedRun && outcome === "succeeded" && adapterResult.resultJson) {
        await extractAndLogDecisions(db, agent, finalizedRun, adapterResult.resultJson);
      }

      if (finalizedRun) {
        await updateRuntimeState(agent, finalizedRun, adapterResult, {
          legacySessionId: nextSessionState.legacySessionId,
        }, normalizedUsage);
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
      // Save session state, post channel messages, extract agent-authored messages (best-effort)
      if (finalizedRun) {
        await savePostRunSessionState(db, {
          agentId: agent.id,
          companyId: agent.companyId,
          issueId: issueId ?? null,
          runId: run.id,
          outcome,
          adapterResultJson: adapterResult.resultJson ?? null,
        });

        if (outcome === "succeeded") {
          await postSuccessChannelMessages(db, agent, issueId ?? null, issueContext);
        }

        await extractAndPostAgentChannelMessages(db, agent, adapterResult.summary ?? "");

        // PDCA: Act phase - log any adjustments made post-run
        if (outcome !== "succeeded") {
          await appendRunEvent(finalizedRun, seq++, {
            eventType: "lifecycle",
            stream: "system",
            level: "warn",
            message: `adjustments logged after ${outcome} run`,
            payload: {
              phase: "act",
              details: `Run ${outcome} - session state updated for next iteration`,
            },
          });
        }
      }
      await finalizeAgentStatus(agent.id, outcome);
    } catch (err) {
      const message = redactCurrentUserText(
        err instanceof Error ? err.message : "Unknown adapter failure",
        await getCurrentUserRedactionOptions(),
      );
      logger.error({ err, runId }, "heartbeat execution failed");

      let logSummary: { bytes: number; sha256?: string; compressed: boolean } | null = null;
      if (handle) {
        try {
          logSummary = await runLogStore.finalize(handle);
        } catch (finalizeErr) {
          logger.warn({ err: finalizeErr, runId }, "failed to finalize run log after error");
        }
      }

      const failedRun = await setRunStatus(run.id, "failed", {
        error: message,
        errorCode: "adapter_failed",
        finishedAt: new Date(),
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
    }
    } catch (outerErr) {
          // Setup code before adapter.execute threw (e.g. ensureRuntimeState, resolveWorkspaceForRun).
          // The inner catch did not fire, so we must record the failure here.
          const message = outerErr instanceof Error ? outerErr.message : "Unknown setup failure";
          logger.error({ err: outerErr, runId }, "heartbeat execution setup failed");
          await setRunStatus(runId, "failed", {
            error: message,
            errorCode: "adapter_failed",
            finishedAt: new Date(),
          }).catch(() => undefined);
          await setWakeupStatus(run.wakeupRequestId, "failed", {
            finishedAt: new Date(),
            error: message,
          }).catch(() => undefined);
          const failedRun = await getRun(runId).catch(() => null);
          if (failedRun) {
            // Emit a run-log event so the failure is visible in the run timeline,
            // consistent with what the inner catch block does for adapter failures.
            await appendRunEvent(failedRun, 1, {
              eventType: "error",
              stream: "system",
              level: "error",
              message,
            }).catch(() => undefined);
            await releaseIssueExecutionAndPromote(failedRun).catch(() => undefined);
          }
          // Ensure the agent is not left stuck in "running" if the inner catch handler's
          // DB calls threw (e.g. a transient DB error in finalizeAgentStatus).
          await finalizeAgentStatus(run.agentId, "failed").catch(() => undefined);
        } finally {
          await releaseRuntimeServicesForRun(run.id).catch(() => undefined);
          activeRunExecutions.delete(run.id);
          await startNextQueuedRunForAgent(run.agentId);
        }
  }

  async function releaseIssueExecutionAndPromote(run: typeof heartbeatRuns.$inferSelect) {
    return releaseIssueExecutionAndPromoteModule(db, run, {
      resolveSessionBeforeForWakeup,
      startNextQueuedRunForAgent,
    });
  }


  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}) {
    return enqueueWakeupModule(db, agentId, opts, {
      budgetHooks,
      resolveExplicitResumeSessionOverride,
      resolveSessionBeforeForWakeup,
      startNextQueuedRunForAgent,
      checkIterationLimits,
    });
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
    return cancelRunInternalModule(db, runId, reason, {
      appendRunEvent,
      nextRunEventSeq,
      releaseIssueExecutionAndPromote,
      finalizeAgentStatus,
      startNextQueuedRunForAgent,
    });
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
    return cancelActiveForAgentInternalModule(db, agentId, reason, {
      releaseIssueExecutionAndPromote,
    });
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    return cancelBudgetScopeWorkModule(db, scope, {
      cancelRunInternal,
      cancelActiveForAgentInternal,
    });
  }

  return {
    list: async (companyId: string, agentId?: string, limit?: number) => {
      const query = db
        .select(heartbeatRunListColumns)
        .from(heartbeatRuns)
        .where(
          agentId
            ? and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))
            : eq(heartbeatRuns.companyId, companyId),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      const rows = limit ? await query.limit(limit) : await query;
      return rows.map((row) => ({
        ...row,
        resultJson: summarizeHeartbeatRunResultJson(row.resultJson),
      }));
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
        content: redactCurrentUserText(result.content, await getCurrentUserRedactionOptions()),
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

    reportRunActivity: clearDetachedRunWarning,

    reapOrphanedRuns,

    resumeQueuedRuns,

    tickTimers: (now = new Date()) => tickTimersModule(db, enqueueWakeup, now),

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelBudgetScopeWork,

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
