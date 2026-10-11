import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";
import { normalizeAgentNameKey } from "./retries.js";
import { publishActiveDotComment } from "../dot-assignment-follow-up.js";
import {
  type WakeupOptions,
  mergeCoalescedContextSnapshot,
  enrichWakeContextSnapshot,
  hasInteractionContinuationWakeContext,
  isInteractionResolutionWakePayload,
} from "./run-preparation.js";
import { resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import {
  CHAT_COMPLETION_WAKE_REASON,
  isCompletedOnboardingHandoffWake,
} from "../chat-completion-delivery.js";
import {
  compareCents,
  hasWorkspaceRestoreFailure,
} from "@paperclipai/shared";
import { nonIdleSlackIssueCondition } from "../slack-conversation-state.js";
import { readQueuedInteractionResponse } from "../queued-interaction-response.js";
import {
  isConversation,
  isConversationExecutionWake,
  isWaitingConversation,
} from "../agent-conversations.js";
import { legacyControllerClaim } from "../legacy-controller-lease.js";
import {
  admitExplicitNativeContinuation,
  undeliveredLegacyUserCommentIds,
} from "../explicit-native-continuation.js";
import { canRetryStoppedRun } from "../cancelled-native-startup.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { isConversationAdapter } from "../conversation-continuation.js";
import { recordExecutionWait } from "../execution-wait.js";
import {
  getNativeReviewAssignment,
  readNativeReviewAssignmentContext,
} from "../native-runtime/native-review-participant.js";
import { claimQueuedNativeReviewRun } from "../native-runtime/native-review-dispatch.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { executionFailureRetryCount } from "../execution-recovery-attempt.js";
import {
  slackMentionAllowsRunStart,
  assertDurableChatWakeupReceipt,
  assertDurableChatWakeupRequest,
  authorizeFailedChatRunRetryWake,
  FailedChatRunRetryAuthorizationError,
  unadmittedChatWakeupCondition,
} from "../durable-chat-wakeup.js";
import { agentService } from "../agents.js";
import { normalizeLegacyRunnerProvider } from "@paperclipai/adapter-utils";
import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  chatConversations,
  chatEndpoints,
  companies,
  costEvents,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  conflict,
  HttpError,
  notFound,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { publishLiveEvent } from "../live-events.js";
import { allocateHeartbeatRunEventSeq } from "../heartbeat-run-events.js";
import {
  queuedCommentIdsFromWakePayload,
  queuedCommentIdsFromRunContext,
  withQueuedCommentIdsInWakePayload,
  withQueuedCommentIdsInRunContext,
} from "../issue-queued-comment-queue.js";
import {
  parseObject,
  asBoolean,
  asNumber,
} from "../../adapters/utils.js";
import { isExternalChatWaitAuthorizationContention } from "../native-runtime/chat-attachment-reuse.js";
import { emitAgentTaskRun } from "../agent-task-run-telemetry.js";
import {
  CHAT_CONTROL_RECOVERY_ADMISSION_KEY,
  CHAT_CONTROL_RECOVERY_STOP_CODE,
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  chatControlRecoveryAdmission,
  readChatControlRecoveryAdmission,
  readChatControlNativeParent,
  readChatControlRecoveryStop,
} from "../chat-control-recovery-stop.js";
import {
  ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
  ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  ISSUE_REWAKE_LOOKBACK_MS,
  ISSUE_REWAKE_RUN_SAMPLE_LIMIT,
  evaluateIssueRewakeThrottle,
  isRoutineRunCompletionComment,
  isThrottleCandidateIssueRewake,
} from "../issue-rewake-throttle.js";
import { logActivity } from "../activity-log.js";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../issue-dependency-wakeups.js";
import {
  ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
  isVerifiedIssueTreeControlInteractionWake,
} from "../issue-tree-control.js";
import {
  buildExecutionWorkspaceAdapterConfig,
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
} from "../execution-workspace-policy.js";
import { readContinuationAttempt } from "../recovery/index.js";
import { allowsIssueInteractionWake } from "../../modules/run-dispatch/index.js";
import { withAgentStartLock } from "../agent-start-lock.js";
import {
  evaluateAgentInvokability,
  shouldCancelRunsForNonInvokableAgent,
  type AgentOrgRow,
} from "../agent-invokability.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { isUuidLike } from "@paperclipai/shared";
import { retryChatControlAdmission } from "../chat-control-admission-retry.js";

import type { HeartbeatServiceOptions } from "../heartbeat.js";
import type { createHeartbeatRunState } from "./run-state.js";
import type { createHeartbeatRunPreparation } from "./run-preparation.js";
import type { HeartbeatRetryDependencies } from "./retries.js";
import type { HeartbeatRecoveryDependencies, createHeartbeatRecovery } from "./recovery.js";
import type { issueService } from "../issues.js";
import type { issueTreeControlService } from "../issue-tree-control.js";
import type { budgetService } from "../budgets.js";
import type { instanceSettingsService } from "../instance-settings.js";
import type { createRunDispatch } from "../../modules/run-dispatch/index.js";
import type { PostCommitEffect as WakeQueuePostCommitEffect, createWakeQueue } from "../../modules/wake-queue/index.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type HeartbeatRunState = ReturnType<typeof createHeartbeatRunState>;
type RunPreparation = ReturnType<typeof createHeartbeatRunPreparation>;

/** Queue policy uses the service's lifecycle effects and process-wide ownership sets. */
export interface HeartbeatQueueDependencies extends Pick<HeartbeatRetryDependencies,
  "setWakeupStatus" | "appendRunEvent" | "finalizeAgentStatus" |
  "getAgentInvokability" | "getWorktreeExecutionCutoff" | "applyRunDispatchPostCommitEffects">,
  Pick<RunPreparation, "toAgentOrgRow" | "listCompanyAgentOrgRows" |
    "resolveResponsibleUserIdForRun" | "getIssueExecutionContext" |
    "getRoutineEnvForExecutionIssue" | "resolveResponsibleUserIdForRunSeed">,
  Pick<HeartbeatRunState, "getAgent" | "getRun" | "resolveExplicitResumeSessionOverride" |
    "resolveSessionBeforeForWakeup" | "hasResolvablePriorSessionWorkspaceForWake">,
  Pick<HeartbeatRecoveryDependencies, "setRunStatus"> {
  sweepPendingCleanupLeases: ReturnType<typeof createHeartbeatRecovery>["sweepPendingCleanupLeases"];
  options: Pick<HeartbeatServiceOptions, "beforeChatControlRecoveryCheck">;
  issuesSvc: Pick<ReturnType<typeof issueService>, "getDependencyReadiness" | "listDependencyReadiness">;
  treeControlSvc: Pick<ReturnType<typeof issueTreeControlService>, "getActivePauseHoldGate">;
  budgets: Pick<ReturnType<typeof budgetService>, "getInvocationBlock">;
  instanceSettings: Pick<ReturnType<typeof instanceSettingsService>, "getExperimental">;
  runDispatch: Pick<ReturnType<typeof createRunDispatch>, "cancelStaleQueuedRun">;
  wakeQueue: Pick<ReturnType<typeof createWakeQueue>, "createAdmissionTransactionScope" | "admitWakeBehindIssueExecution">;
  activeRunExecutions: Set<string>;
  activeRunExecutionPromises: Set<Promise<void>>;
  activeWakeupPromises: Set<Promise<unknown>>;
  liveRunExecutions: { has(id: string): boolean };
  isHeartbeatRunTerminalStatus: (status: string | null | undefined) => boolean;
  isSameTaskScope: (left: string | null, right: string | null) => boolean;
  runTaskKey: (run: HeartbeatRun) => string | null;
  filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null, live: { has(id: string): boolean }) => T | null;
  getSchedulingSuppression: () => Promise<{ suppressed: boolean; reason: "worktree_instance" | "database_restore_in_progress" | "task_drain" | null }>;
  executeRun: (runId: string) => Promise<void>;
  releaseIssueExecutionAndPromote: (run: Pick<HeartbeatRun, "id" | "companyId">, options?: { suppressImmediateRecovery?: boolean; deferredPostCommitEffects?: WakeQueuePostCommitEffect[] }) => Promise<unknown>;
  applyWakeQueuePostCommitEffects: (effects: WakeQueuePostCommitEffect[]) => Promise<void>;
  publishRunLifecyclePluginEvent: (run: HeartbeatRun) => void;
  cancelRunInternal: (runId: string, reason?: string, options?: { errorCode?: string }) => Promise<unknown>;
  cancelActiveForAgentInternal: (agentId: string, reason: string) => Promise<unknown>;
  resumeExecutionWaitComments: () => Promise<unknown>;
  resumeQueuedCommentInterrupt: (companyId: string, queueId: string) => Promise<unknown>;
  resumeSavedLegacyComments: (companyId: string, queueId: string) => Promise<unknown>;
  formatIssueIdentifierLink: (identifier: string | null, fallback: string) => string;
}

const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;

const HEARTBEAT_MAX_CONCURRENT_RUNS_MIN = 1;

const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 50;

export const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";

export const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = [
  "queued",
  "running",
  "scheduled_retry",
] as const;

const TIMER_ACTIONABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;

export class ChatControlRecoveryUnresolvedError extends Error {
  constructor() {
    super(
      "Run admission could not acquire its database locks after bounded retries. No provider work started. Review database contention and send a fresh request; this attempt will not automatically retry.",
    );
  }
}

const RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP = new Set([
  CHAT_COMPLETION_WAKE_REASON,
  "approval_approved",
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  "issue_recovery_action_restored",
]);

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(
    asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT),
  );
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(
    HEARTBEAT_MAX_CONCURRENT_RUNS_MIN,
    Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed),
  );
}

export function shouldRequireIssueCommentForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.skipIssueComment === true) return false;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  return (
    wakeReason === "issue_assigned" ||
    wakeReason === "execution_review_requested" ||
    wakeReason === "execution_approval_requested" ||
    wakeReason === "execution_changes_requested"
  );
}

async function listUnresolvedBlockerSummaries(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueId: string,
  unresolvedBlockerIssueIds: string[],
) {
  const ids = [...new Set(unresolvedBlockerIssueIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return dbOrTx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        inArray(issues.id, ids),
      ),
    )
    .orderBy(asc(issues.title));
}

export function shouldDeferFollowupWakeForSameIssue(input: {
  activeRunStatus: string | null | undefined;
  isSameExecutionAgent: boolean;
  wakeCommentId: string | null | undefined;
  forceFreshSession: boolean;
}) {
  // A comment follow-up or explicit fresh-session wake needs a new run boundary.
  if (!input.isSameExecutionAgent) return false;
  if (input.activeRunStatus !== "running") return false;
  if (input.wakeCommentId) return true;
  if (input.forceFreshSession) return true;
  return false;
}

export function shouldQueueFollowupForRunningIssueWake(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  wakeCommentId: string | null;
}) {
  if (input.wakeCommentId) return true;
  // A structured interaction response is new input just like a comment. It
  // must run after the turn that created the interaction instead of being
  // merged into that still-running turn.
  if (
    readNonEmptyString(input.contextSnapshot?.interactionId) &&
    readNonEmptyString(input.contextSnapshot?.interactionStatus)
  ) {
    return true;
  }
  const wakeReason = readNonEmptyString(input.contextSnapshot?.wakeReason);
  if (wakeReason === "issue_children_completed" && (
    input.contextSnapshot?.onboardingCompletion === true ||
    (input.contextSnapshot?.statusDecisionSource === "native_status_decision" &&
      readNonEmptyString(input.contextSnapshot?.nativeChildCompletionDecisionId))
  )) return true;
  return Boolean(
    wakeReason && RUNNING_ISSUE_WAKE_REASONS_REQUIRING_FOLLOWUP.has(wakeReason),
  );
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Queue admission and dispatch share the service lifecycle callbacks and execution ownership. */
export function createHeartbeatQueue(db: Db, dependencies: HeartbeatQueueDependencies) {
  const {
    setRunStatus,
    setWakeupStatus,
    appendRunEvent,
    releaseIssueExecutionAndPromote,
    applyWakeQueuePostCommitEffects,
    issuesSvc,
    options,
    publishRunLifecyclePluginEvent,
    finalizeAgentStatus,
    getAgent,
    cancelRunInternal,
    toAgentOrgRow,
    getAgentInvokability,
    budgets,
    activeRunExecutions,
    treeControlSvc,
    runDispatch,
    applyRunDispatchPostCommitEffects,
    resolveResponsibleUserIdForRun,
    getIssueExecutionContext,
    isHeartbeatRunTerminalStatus,
    liveRunExecutions,
    getSchedulingSuppression,
    resumeExecutionWaitComments,
    getWorktreeExecutionCutoff,
    resumeQueuedCommentInterrupt,
    resumeSavedLegacyComments,
    cancelActiveForAgentInternal,
    listCompanyAgentOrgRows,
    executeRun,
    activeRunExecutionPromises,
    activeWakeupPromises,
    instanceSettings,
    getRun,
    sweepPendingCleanupLeases,
    resolveExplicitResumeSessionOverride,
    resolveSessionBeforeForWakeup,
    hasResolvablePriorSessionWorkspaceForWake,
    getRoutineEnvForExecutionIssue,
    resolveResponsibleUserIdForRunSeed,
    formatIssueIdentifierLink,
    wakeQueue,
    isSameTaskScope,
    runTaskKey,
    filterZombieCoalesceTarget,
  } = dependencies;

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, false),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: isHeartbeatWakeOnDemandEnabled(agent),
      // A Dot binding has one external turn. Competing assignments must retain
      // their queue position instead of claiming a second run that cannot bind.
      maxConcurrentRuns: agent.adapterType === "paperclip_runner" &&
        parseObject(agent.adapterConfig).provider === "openai_dot"
        ? 1 : normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      skipTimerWhenNoActionableWork: asBoolean(
        heartbeat.skipTimerWhenNoActionableWork ??
          heartbeat.requireActionableTimerWork ??
          heartbeat.issueOnlyTimer,
        false,
      ),
      maxDailyRuns: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyRuns ??
          heartbeat.dailyRunLimit ??
          heartbeat.dailyRunCap ??
          heartbeat.maxRunsPerDay,
      ),
      maxDailyCostCents: normalizeOptionalNonNegativeInteger(
        heartbeat.maxDailyCostCents ??
          heartbeat.dailyCostCentsLimit ??
          heartbeat.dailySpendCentsLimit ??
          heartbeat.dailyBudgetCents,
      ),
    };
  }

  function normalizeOptionalNonNegativeInteger(value: unknown) {
    if (value === null || value === undefined || value === "") return null;
    const normalized = Math.floor(asNumber(value, 0));
    return normalized >= 0 ? normalized : null;
  }

  function currentUtcDayWindow(now = new Date()) {
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const end = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0,
        0,
        0,
        0,
      ),
    );
    return { start, end };
  }

  async function getHeartbeatDailyCapBlock(
    agent: typeof agents.$inferSelect,
    policy: ReturnType<typeof parseHeartbeatPolicy>,
    options: {
      checkRunCap?: boolean;
      checkCostCap?: boolean;
      excludeRunId?: string | null;
    } = {},
    client: Pick<Db, "select"> = db,
  ) {
    const checkRunCap = options.checkRunCap ?? true;
    const checkCostCap = options.checkCostCap ?? true;
    const { start, end } = currentUtcDayWindow();
    if (checkRunCap && policy.maxDailyRuns !== null) {
      const conditions = [
        eq(heartbeatRuns.companyId, agent.companyId),
        eq(heartbeatRuns.agentId, agent.id),
        gte(heartbeatRuns.startedAt, start),
        lt(heartbeatRuns.startedAt, end),
        notInArray(heartbeatRuns.status, ["queued", "scheduled_retry"]),
      ];
      if (options.excludeRunId) {
        conditions.push(sql`${heartbeatRuns.id} <> ${options.excludeRunId}`);
      }
      const [row] = await client
        .select({ total: sql<number>`count(*)::integer` })
        .from(heartbeatRuns)
        .where(and(...conditions));
      const observed = Number(row?.total ?? 0);
      if (observed >= policy.maxDailyRuns) {
        return {
          reason: "heartbeat.daily_run_limit",
          observed,
          limit: policy.maxDailyRuns,
        };
      }
    }

    if (checkCostCap && policy.maxDailyCostCents !== null) {
      const [row] = await client
        .select({
          total: sql<string>`coalesce(sum(${costEvents.costCents}), 0)::text`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, agent.companyId),
            eq(costEvents.agentId, agent.id),
            gte(costEvents.occurredAt, start),
            lt(costEvents.occurredAt, end),
          ),
        );
      const observed = Number(row?.total ?? 0);
      if (compareCents(String(row?.total ?? 0), policy.maxDailyCostCents) >= 0) {
        return {
          reason: "heartbeat.daily_cost_limit",
          observed,
          limit: policy.maxDailyCostCents,
        };
      }
    }

    return null;
  }

  async function cancelQueuedRunForHeartbeatDailyCap(
    run: typeof heartbeatRuns.$inferSelect,
    dailyCapBlock: NonNullable<
      Awaited<ReturnType<typeof getHeartbeatDailyCapBlock>>
    >,
  ) {
    const now = new Date();
    const reason =
      "Cancelled because the agent reached a per-day heartbeat budget cap before adapter invocation";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: dailyCapBlock.reason,
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "heartbeat_daily_cap_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        reason: dailyCapBlock.reason,
        observed: dailyCapBlock.observed,
        limit: dailyCapBlock.limit,
      },
    });

    await releaseIssueExecutionAndPromote(cancelled, {
      suppressImmediateRecovery: true,
    });

    return cancelled;
  }

  async function hasActionableTimerWork(agent: typeof agents.$inferSelect) {
    const row = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, agent.companyId),
          eq(issues.assigneeAgentId, agent.id),
          isNull(issues.assigneeUserId),
          isNull(issues.hiddenAt),
          inArray(issues.status, [...TIMER_ACTIONABLE_ISSUE_STATUSES]),
          isNull(issues.conversationAgentId),
          nonIdleSlackIssueCondition(),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function markTimerHeartbeatChecked(
    agentId: string,
    source: WakeupOptions["source"],
  ) {
    if (source !== "timer") return;
    await db
      .update(agents)
      .set({
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));
  }

  async function claimDueTimerHeartbeat(
    agent: typeof agents.$inferSelect,
    now: Date,
    intervalSec: number,
  ) {
    const dueBefore = new Date(now.getTime() - intervalSec * 1000);
    const claimed = await db
      .update(agents)
      .set({
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(agents.id, agent.id),
          eq(agents.companyId, agent.companyId),
          or(
            lte(agents.lastHeartbeatAt, dueBefore),
            and(
              isNull(agents.lastHeartbeatAt),
              lte(agents.createdAt, dueBefore),
            ),
          ),
        ),
      )
      .returning({ id: agents.id })
      .then((rows) => rows[0] ?? null);
    if (!claimed) return null;
    return { wasFirstHeartbeat: !agent.lastHeartbeatAt };
  }

  function issueRunPriorityRank(priority: string | null | undefined) {
    switch (priority) {
      case "critical":
        return 0;
      case "high":
        return 1;
      case "medium":
        return 2;
      case "low":
        return 3;
      default:
        return 4;
    }
  }

  async function listQueuedRunDependencyReadiness(
    companyId: string,
    queuedRuns: Array<typeof heartbeatRuns.$inferSelect>,
  ) {
    const issueIds = [
      ...new Set(
        queuedRuns
          .map((run) =>
            readNonEmptyString(parseObject(run.contextSnapshot).issueId),
          )
          .filter((issueId): issueId is string => Boolean(issueId)),
      ),
    ];
    if (issueIds.length === 0) {
      return new Map<
        string,
        Awaited<ReturnType<typeof issuesSvc.getDependencyReadiness>>
      >();
    }
    return issuesSvc.listDependencyReadiness(companyId, issueIds);
  }

  async function countRunningRunsForAgent(agentId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    return Number(count ?? 0);
  }

  async function withChatControlRecoveryGate(
    run: typeof heartbeatRuns.$inferSelect,
    stage: "claim" | "dispatch",
    onClear: (tx: Db) => Promise<typeof heartbeatRuns.$inferSelect | null>,
    nativeRecovery = false,
  ) {
    const issueId = readNonEmptyString(
      parseObject(run.contextSnapshot).issueId,
    );
    if (!issueId || run.invocationSource !== "automation") return onClear(db);
    await options.beforeChatControlRecoveryCheck?.({
      runId: run.id,
      issueId,
      stage,
    });
    if (stage === "dispatch" && nativeRecovery) {
      // Protected historical/already-admitted owners did not previously take
      // this fence's locks. A fresh exact read keeps unrelated Board contention
      // from turning their recovery into a new admission failure.
      const [current] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.companyId, run.companyId),
            eq(heartbeatRuns.agentId, run.agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        )
        .limit(1);
      if (
        current &&
        current.wakeupRequestId === run.wakeupRequestId &&
        parseObject(current.contextSnapshot).issueId === issueId
      ) {
        const admission = readChatControlRecoveryAdmission(current);
        const expected = readChatControlRecoveryAdmission(run);
        if (
          expected !== "invalid" &&
          (admission === "admitted" ||
            (admission === "historical" && expected === "historical"))
        )
          return onClear(db);
      }
    }
    let terminal: typeof heartbeatRuns.$inferSelect | null = null;
    try {
      const attempt = () => db.transaction(async (tx) => {
        terminal = null;
        // Same queue-edit lock order, then the close committer's conversation
        // row. NOWAIT releases partial locks on contention. Claim defers to the
        // queue; dispatch retries this transaction before considering failure.
        const [issue] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (!issue) return null;
        if (run.wakeupRequestId)
          await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.id, run.wakeupRequestId),
                eq(agentWakeupRequests.companyId, run.companyId),
                eq(agentWakeupRequests.agentId, run.agentId),
              ),
            )
            .for("update", { noWait: true })
            .limit(1);
        const [current] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.agentId, run.agentId),
            ),
          )
          .for("update", { noWait: true })
          .limit(1);
        if (
          !current ||
          current.status !== (stage === "claim" ? "queued" : "running")
        )
          return null;
        const admission = readChatControlRecoveryAdmission(current);
        const expectedAdmission = readChatControlRecoveryAdmission(run);
        const admissionLost =
          expectedAdmission !== "historical" && admission === "historical";
        if (
          stage === "dispatch" &&
          nativeRecovery &&
          !admissionLost &&
          (admission === "historical" || admission === "admitted")
        )
          return onClear(tx as unknown as Db);
        // A new warm child can inherit a prior runner's PID during preparation.
        // Those fields do not prove this run's turn was dispatched.
        // Exact admitted/historical recovery retains its existing ownership;
        // a marked, unadmitted bootstrap must earn admission even after crash.
        const proof =
          admission === "invalid" || admissionLost
            ? { kind: "unresolved" as const }
            : await readChatControlRecoveryStop(
                tx as unknown as Db,
                {
                  companyId: run.companyId,
                  issueId,
                  agentId: run.agentId,
                  sourceRunId: run.id,
                },
                true,
              );
        if (proof.kind === "clear") {
          if (stage === "claim" || admission === "required")
            await tx
              .update(heartbeatRuns)
              .set({
                runnerProfileJson: {
                  ...parseObject(current.runnerProfileJson),
                  [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                    chatControlRecoveryAdmission(
                      current,
                      stage === "dispatch"
                        ? "admitted"
                        : admission === "admitted"
                          ? "admitted"
                          : "required",
                    ),
                },
                updatedAt: new Date(),
              })
              .where(eq(heartbeatRuns.id, current.id));
          return onClear(tx as unknown as Db);
        }
        if (proof.kind === "unresolved" && stage === "claim") return null;
        const now = new Date();
        const stopped = proof.kind === "stopped";
        const code = stopped
          ? CHAT_CONTROL_RECOVERY_STOP_CODE
          : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE;
        const error = stopped
          ? "Automatic continuation stopped by the committed chat conversation close. Send a new request in chat or on the Board to start fresh work."
          : "Automatic continuation source could not be verified before provider admission. Review the task and send a fresh request; this attempt will not automatically retry.";
        [terminal] = await tx
          .update(heartbeatRuns)
          .set({
            status: stopped ? "cancelled" : "failed",
            errorCode: code,
            error,
            finishedAt: now,
            resultJson: {
              ...parseObject(current.resultJson),
              automaticRecovery: {
                code,
                providerDispatched: false,
                ...(stopped
                  ? {
                      sourceRunId: proof.sourceRunId,
                      conversationId: proof.conversationId,
                      publicationId: proof.publicationId,
                    }
                  : {}),
              },
            },
            updatedAt: now,
          })
          .where(
            and(
              eq(heartbeatRuns.id, current.id),
              eq(heartbeatRuns.status, current.status),
            ),
          )
          .returning();
        if (!terminal) return null;
        if (current.wakeupRequestId)
          await tx
            .update(agentWakeupRequests)
            .set({
              status: stopped ? "skipped" : "failed",
              error,
              finishedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.id, current.wakeupRequestId),
                eq(agentWakeupRequests.companyId, current.companyId),
                eq(agentWakeupRequests.agentId, current.agentId),
                eq(agentWakeupRequests.runId, current.id),
                ne(agentWakeupRequests.status, "cancelled"),
              ),
            );
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.companyId, current.companyId),
              eq(issues.id, issueId),
              eq(issues.executionRunId, current.id),
            ),
          );
        return null;
      });
      const result = stage === "dispatch"
        ? await retryChatControlAdmission(attempt)
        : await attempt();
      if (terminal) {
        const settled = terminal as typeof heartbeatRuns.$inferSelect;
        publishLiveEvent({
          companyId: settled.companyId,
          type: "heartbeat.run.status",
          payload: {
            runId: settled.id,
            agentId: settled.agentId,
            status: settled.status,
            errorCode: settled.errorCode,
            error: settled.error,
          },
        });
        publishRunLifecyclePluginEvent(settled);
        if (stage === "dispatch")
          await finalizeAgentStatus(settled.agentId, "cancelled");
      }
      return result;
    } catch (error) {
      if (!isExternalChatWaitAuthorizationContention(error)) throw error;
      if (stage === "dispatch") {
        // No effect was admitted. Let the existing setup-failure path settle
        // this attempt distinctly; it must not become a successful close.
        throw new ChatControlRecoveryUnresolvedError();
      }
      return null;
    }
  }

  async function claimQueuedRun(
    run: typeof heartbeatRuns.$inferSelect,
    companyAgents?: AgentOrgRow[],
    deferredPostCommitEffects?: WakeQueuePostCommitEffect[],
  ) {
    if (run.status !== "queued") return run;
    // Claim is the first execution boundary. startedAt survives same-run
    // retries; restart recovery may also enter executeRun already running.
    // Neither may reinterpret an admitted, already-started message as new work.
    if (!run.startedAt && !(await slackMentionAllowsRunStart(db, run))) {
      const now = new Date();
      const reason = "Message did not @mention the bot";
      // This runs under the agent start lock. Do not use cancelRunInternal,
      // which recursively starts the next run and reacquires that lock.
      const cancelled = await setRunStatus(run.id, "cancelled", {
        finishedAt: now,
        error: reason,
        errorCode: "chat_mention_required",
      });
      if (cancelled) {
        await setWakeupStatus(run.wakeupRequestId, "skipped", { finishedAt: now, error: reason });
        await appendRunEvent(cancelled, {
          eventType: "lifecycle", stream: "system", level: "warn", message: reason,
        });
        await releaseIssueExecutionAndPromote(cancelled, {
          suppressImmediateRecovery: true, deferredPostCommitEffects,
        });
      }
      return null;
    }

    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(
        run.id,
        "Cancelled because the agent no longer exists",
      );
      return null;
    }
    // Keep accepted work in the durable queue until setup completes.
    if (isAgentAwaitingSetup(agent)) return null;
    const invokability = companyAgents
      ? evaluateAgentInvokability(toAgentOrgRow(agent), companyAgents)
      : await getAgentInvokability(agent);
    if (!invokability.invokable) {
      await cancelRunInternal(
        run.id,
        `Cancelled because the agent is not invokable: ${invokability.reason}`,
      );
      return null;
    }

    const context = parseObject(run.contextSnapshot);
    const budgetBlock = await budgets.getInvocationBlock(
      run.companyId,
      run.agentId,
      {
        issueId: readNonEmptyString(context.issueId),
        projectId: readNonEmptyString(context.projectId),
      },
    );
    if (budgetBlock) {
      await cancelRunInternal(run.id, budgetBlock.reason);
      return null;
    }

    const dailyCapBlock = await getHeartbeatDailyCapBlock(
      agent,
      parseHeartbeatPolicy(agent),
      {
        excludeRunId: run.id,
        checkRunCap: true,
        checkCostCap: true,
      },
    );
    if (dailyCapBlock) {
      await cancelQueuedRunForHeartbeatDailyCap(run, dailyCapBlock);
      return null;
    }

    const issueId = readNonEmptyString(context.issueId);
    if (issueId && activeRunExecutions.size > 0) {
      // Native finalization publishes success before workspace synchronization,
      // provider suspension, and lease release finish. A queued comment must
      // not acquire a fresh sandbox while its predecessor still owns that work.
      // The executor's finally block retries this agent after removing its owner.
      const [settlingOwner] = await db.select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId),
          eq(heartbeatRuns.runtimeMode, "native"),
          inArray(heartbeatRuns.id, [...activeRunExecutions]),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        ))
        .limit(1);
      if (settlingOwner) return null;
    }
    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        run.companyId,
        issueId,
      );
      const treeHoldInteractionWake =
        activePauseHold &&
        (await isVerifiedIssueTreeControlInteractionWake(db, {
          companyId: run.companyId,
          issueId,
          agentId: run.agentId,
          runId: run.id,
          wakeupRequestId: run.wakeupRequestId,
          contextSnapshot: context,
        }));
      if (activePauseHold && !treeHoldInteractionWake) {
        await cancelRunInternal(
          run.id,
          "Cancelled because issue is held by an active subtree pause hold",
        );
        await logActivity(db, {
          companyId: run.companyId,
          actorType: "system",
          actorId: "system",
          agentId: run.agentId,
          runId: run.id,
          action: "issue.tree_hold_run_interrupted",
          entityType: "heartbeat_run",
          entityId: run.id,
          issueId: issueId,
          details: {
            issueId,
            holdId: activePauseHold.holdId,
            rootIssueId: activePauseHold.rootIssueId,
            source: "heartbeat.claim_queued_run",
            securityPrinciples: [
              "Complete Mediation",
              "Fail Securely",
              "Secure Defaults",
            ],
          },
        });
        return null;
      }

      const dependencyReadiness = await issuesSvc.listDependencyReadiness(
        run.companyId,
        [issueId],
      );
      const readiness = dependencyReadiness.get(issueId);
      const unresolvedBlockerCount = readiness?.unresolvedBlockerCount ?? 0;
      if (
        unresolvedBlockerCount > 0 &&
        !allowsIssueInteractionWake(
          context,
          ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
        )
      ) {
        await cancelQueuedRunForBlockedDependencies(
          run,
          issueId,
          readiness?.unresolvedBlockerIssueIds ?? [],
        );
        logger.info(
          { runId: run.id, issueId, unresolvedBlockerCount },
          "claimQueuedRun: cancelled blocked queued run",
        );
        return null;
      }

      const staleness = await runDispatch.cancelStaleQueuedRun({
        runId: run.id,
        companyId: run.companyId,
        expectedStatus: "queued",
      });
      if (staleness.outcome === "cancelled" || staleness.outcome === "deferred") {
        applyRunDispatchPostCommitEffects(staleness.postCommitEffects);
        logger.info(
          {
            runId: run.id,
            issueId,
            outcome: staleness.outcome,
            errorCode: staleness.outcome === "cancelled" ? staleness.errorCode : undefined,
          },
          "claimQueuedRun: withheld queued run at the execution gate",
        );
        return null;
      }
    }

    const claimedAt = new Date();
    const responsibleUserId = await resolveResponsibleUserIdForRun({
      run,
      contextSnapshot: context,
      issueContext: issueId
        ? await getIssueExecutionContext(run.companyId, issueId)
        : null,
      routineEnvContext: {
        routineId: null,
        env: null,
        responsibleUserId: null,
      },
    });
    // All ordinary and comment claims use the same company-scoped issue
    // lock. A batch may claim several runs before executeRun tracks any owner.
    async function lockIssueExecutionClaim(tx: Db) {
      const [owner] = issueId ? await tx.select({
        assigneeAgentId: issues.assigneeAgentId,
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
      }).from(issues).where(and(
        eq(issues.id, issueId), eq(issues.companyId, run.companyId),
      )).for("update") : [];
      const ownsIssue = owner?.assigneeAgentId === run.agentId &&
        context.wakeReason !== "source_scoped_recovery_action";
      if (ownsIssue && ["native_safe_replacement", "native_provider_overloaded"].includes(run.scheduledRetryReason ?? "") &&
          owner.checkoutRunId && owner.checkoutRunId !== run.id) {
        return { ownsIssue, blocked: true };
      }
      if (run.scheduledRetryReason === "native_provider_overloaded" && owner?.executionRunId &&
          owner.executionRunId !== run.id && owner.executionRunId !== run.retryOfRunId) {
        return { ownsIssue, blocked: true };
      }
      const previousRunId = run.scheduledRetryReason === "native_provider_overloaded"
        ? run.retryOfRunId : ownsIssue ? owner?.executionRunId : null;
      if (previousRunId && previousRunId !== run.id) {
        const [previous] = await tx.select({ status: heartbeatRuns.status })
          .from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, previousRunId),
            eq(heartbeatRuns.companyId, run.companyId),
          ));
        // A terminal result can precede workspace/lease cleanup on this or
        // another controller. Local absence alone is not a release receipt.
        if (!isHeartbeatRunTerminalStatus(previous?.status) ||
            liveRunExecutions.has(previousRunId)) {
          return { ownsIssue, blocked: true };
        }
        const [pendingLease] = await tx.select({ id: environmentLeases.id })
          .from(environmentLeases).where(and(
            eq(environmentLeases.companyId, run.companyId),
            eq(environmentLeases.heartbeatRunId, previousRunId),
            or(and(isNull(environmentLeases.releasedAt),
                // Warm release deliberately retains the sandbox. Its successful
                // receipt settles the old run without destroying the resource.
                sql`not coalesce(${environmentLeases.status} = 'retained'
                  and ${environmentLeases.leasePolicy} = 'reuse_by_environment'
                  and ${environmentLeases.cleanupStatus} = 'success', false)`),
              eq(environmentLeases.status, "pending_cleanup"),
              eq(environmentLeases.cleanupStatus, "failed")),
          )).limit(1);
        const [finalization] = await tx.select({
          phase: nativeRunFinalizations.phase, leaseOwner: nativeRunFinalizations.leaseOwner,
        }).from(nativeRunFinalizations).where(and(
          eq(nativeRunFinalizations.companyId, run.companyId),
          eq(nativeRunFinalizations.runId, previousRunId),
        ));
        if (pendingLease || (finalization && (finalization.leaseOwner ||
            !["committed", "applied", "terminal_failure"].includes(finalization.phase)))) {
          return { ownsIssue, blocked: true };
        }
      }
      return { ownsIssue, blocked: false };
    }
    async function bindClaimedIssueExecution(tx: Db, ownsIssue: boolean, claimedRun: typeof heartbeatRuns.$inferSelect | null | undefined) {
      if (!claimedRun || !issueId || !ownsIssue) return;
      await tx.update(issues).set({
        executionRunId: claimedRun.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: claimedAt,
        updatedAt: claimedAt,
      }).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
    }
    const nativeReviewContext = readNativeReviewAssignmentContext(context);
    const queuedCommentIds = queuedCommentIdsFromRunContext(context);
    if (
      issueId &&
      run.invocationSource === "automation" &&
      queuedCommentIds.length > 0
    )
      await options.beforeChatControlRecoveryCheck?.({
        runId: run.id,
        issueId,
        stage: "claim",
      });
    const queuedCommentClaim =
      !nativeReviewContext && issueId && run.wakeupRequestId && queuedCommentIds.length > 0
        ? await db
            .transaction(async (tx) => {
              // Match the queue-edit lock order: issue, wake, then run. Once the
              // run becomes running, a concurrent discard must observe the
              // claimed wake and return an explicit conflict; if discard wins,
              // this claim observes the cancelled queue and does no work.
              const issueClaim = await lockIssueExecutionClaim(tx as unknown as Db);
              if (issueClaim.blocked) return { kind: "stale" as const, run: null };
              const wake = await tx
                .select()
                .from(agentWakeupRequests)
                .where(
                  and(
                    eq(agentWakeupRequests.id, run.wakeupRequestId!),
                    eq(agentWakeupRequests.companyId, run.companyId),
                    eq(agentWakeupRequests.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              const lockedRun = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.id, run.id),
                    eq(heartbeatRuns.companyId, run.companyId),
                    eq(heartbeatRuns.agentId, run.agentId),
                  ),
                )
                .for("update")
                .limit(1)
                .then((rows) => rows[0] ?? null);
              if (
                !wake ||
                wake.status !== "queued" ||
                wake.runId !== run.id ||
                !lockedRun ||
                lockedRun.status !== "queued" ||
                lockedRun.wakeupRequestId !== wake.id
              ) {
                return { kind: "stale" as const, run: null };
              }

              if (lockedRun.invocationSource === "automation") {
                const admission = readChatControlRecoveryAdmission(lockedRun);
                if (admission === "invalid")
                  return { kind: "stale" as const, run: null };
                const proof = await readChatControlRecoveryStop(
                  tx as unknown as Db,
                  {
                    companyId: lockedRun.companyId,
                    issueId,
                    agentId: lockedRun.agentId,
                    sourceRunId: lockedRun.id,
                  },
                  true,
                );
                if (proof.kind === "unresolved")
                  return { kind: "stale" as const, run: null };
                if (proof.kind === "stopped") {
                  const error =
                    "Automatic continuation stopped by the committed chat conversation close. Send a fresh request in chat or on the Board.";
                  const [cancelled] = await tx
                    .update(heartbeatRuns)
                    .set({
                      status: "cancelled",
                      errorCode: CHAT_CONTROL_RECOVERY_STOP_CODE,
                      error,
                      finishedAt: claimedAt,
                      resultJson: {
                        ...parseObject(lockedRun.resultJson),
                        automaticRecovery: {
                          code: CHAT_CONTROL_RECOVERY_STOP_CODE,
                          providerDispatched: false,
                          sourceRunId: proof.sourceRunId,
                          conversationId: proof.conversationId,
                          publicationId: proof.publicationId,
                        },
                      },
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(heartbeatRuns.id, lockedRun.id),
                        eq(heartbeatRuns.status, "queued"),
                      ),
                    )
                    .returning();
                  if (!cancelled) return { kind: "stale" as const, run: null };
                  await tx
                    .update(agentWakeupRequests)
                    .set({
                      status: "skipped",
                      error,
                      finishedAt: claimedAt,
                      updatedAt: claimedAt,
                    })
                    .where(eq(agentWakeupRequests.id, wake.id));
                  await tx
                    .update(issues)
                    .set({
                      executionRunId: null,
                      executionAgentNameKey: null,
                      executionLockedAt: null,
                      updatedAt: claimedAt,
                    })
                    .where(
                      and(
                        eq(issues.id, issueId),
                        eq(issues.companyId, run.companyId),
                        eq(issues.executionRunId, run.id),
                      ),
                    );
                  return { kind: "cancelled" as const, run: cancelled };
                }
                await tx
                  .update(heartbeatRuns)
                  .set({
                    runnerProfileJson: {
                      ...parseObject(lockedRun.runnerProfileJson),
                      [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]:
                        chatControlRecoveryAdmission(
                          lockedRun,
                          admission === "admitted" ? "admitted" : "required",
                        ),
                    },
                    updatedAt: claimedAt,
                  })
                  .where(eq(heartbeatRuns.id, lockedRun.id));
              }
              const authoritativeIds = queuedCommentIdsFromWakePayload(
                wake.payload,
              );
              if (authoritativeIds.length === 0) {
                // Legacy/direct comment wakes carry comment ids in their ordinary
                // payload and context, not in the authoritative queued-message
                // envelope. Preserve their established claim path; only an
                // explicitly bound queued-message envelope is subject to the
                // live-comment discard gate below.
                const [claimedRun] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "running",
                    runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
                    ...legacyControllerClaim(run.runtimeMode),
                    responsibleUserId,
                    startedAt: lockedRun.startedAt ?? claimedAt,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
                return claimedRun
                  ? { kind: "claimed" as const, run: claimedRun }
                  : { kind: "stale" as const, run: null };
              }
              const commentRows = await tx
                .select({
                  id: issueComments.id,
                  deletedAt: issueComments.deletedAt,
                })
                .from(issueComments)
                .where(
                  and(
                    eq(issueComments.companyId, run.companyId),
                    eq(issueComments.issueId, issueId),
                    inArray(issueComments.id, authoritativeIds),
                  ),
                );
              const liveIds = authoritativeIds.filter((commentId) => {
                const comment = commentRows.find((row) => row.id === commentId);
                return Boolean(comment && !comment.deletedAt);
              });
              if (liveIds.length === 0) {
                const reason = "Queued messages were discarded before dispatch";
                const [cancelled] = await tx
                  .update(heartbeatRuns)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    errorCode: "queued_comment_discarded",
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(heartbeatRuns.id, lockedRun.id),
                      eq(heartbeatRuns.status, "queued"),
                    ),
                  )
                  .returning();
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: claimedAt,
                    error: reason,
                    updatedAt: claimedAt,
                  })
                  .where(eq(agentWakeupRequests.id, wake.id));
                await tx
                  .update(issues)
                  .set({
                    executionRunId: null,
                    executionAgentNameKey: null,
                    executionLockedAt: null,
                    updatedAt: claimedAt,
                  })
                  .where(
                    and(
                      eq(issues.id, issueId),
                      eq(issues.companyId, run.companyId),
                      eq(issues.executionRunId, run.id),
                    ),
                  );
                return {
                  kind: "cancelled" as const,
                  run: cancelled ?? lockedRun,
                };
              }

              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "claimed",
                  claimedAt,
                  payload: withQueuedCommentIdsInWakePayload(
                    wake.payload,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(eq(agentWakeupRequests.id, wake.id));
              const [claimedRun] = await tx
                .update(heartbeatRuns)
                .set({
                  status: "running",
                  runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
                    ...legacyControllerClaim(run.runtimeMode),
                  responsibleUserId,
                  startedAt: lockedRun.startedAt ?? claimedAt,
                  contextSnapshot: withQueuedCommentIdsInRunContext(
                    lockedRun.contextSnapshot,
                    liveIds,
                  ),
                  updatedAt: claimedAt,
                })
                .where(
                  and(
                    eq(heartbeatRuns.id, lockedRun.id),
                    eq(heartbeatRuns.status, "queued"),
                  ),
                )
                .returning();
              await bindClaimedIssueExecution(tx as unknown as Db, issueClaim.ownsIssue, claimedRun);
              return claimedRun
                ? { kind: "claimed" as const, run: claimedRun }
                : { kind: "stale" as const, run: null };
            })
            .catch((error) => {
              if (isExternalChatWaitAuthorizationContention(error))
                return { kind: "stale" as const, run: null };
              throw error;
            })
        : null;
    if (queuedCommentClaim?.kind === "cancelled") {
      await appendRunEvent(queuedCommentClaim.run, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message:
          queuedCommentClaim.run.error ??
          "Queued messages were discarded before dispatch",
      });
      publishLiveEvent({
        companyId: queuedCommentClaim.run.companyId,
        type: "heartbeat.run.status",
        payload: {
          runId: queuedCommentClaim.run.id,
          agentId: queuedCommentClaim.run.agentId,
          status: queuedCommentClaim.run.status,
          invocationSource: queuedCommentClaim.run.invocationSource,
          triggerDetail: queuedCommentClaim.run.triggerDetail,
          error: queuedCommentClaim.run.error ?? null,
          errorCode: queuedCommentClaim.run.errorCode ?? null,
          startedAt: queuedCommentClaim.run.startedAt
            ? new Date(queuedCommentClaim.run.startedAt).toISOString()
            : null,
          finishedAt: queuedCommentClaim.run.finishedAt
            ? new Date(queuedCommentClaim.run.finishedAt).toISOString()
            : null,
        },
      });
      publishRunLifecyclePluginEvent(queuedCommentClaim.run);
      // Fire-and-forget: nothing else in this path depends on the emission,
      // so it must not delay the return.
      void emitAgentTaskRun(db, queuedCommentClaim.run);
      return null;
    }
    const claimed = queuedCommentClaim
      ? queuedCommentClaim.run
      : await withChatControlRecoveryGate(run, "claim", async (tx) => {
          const claimValues = {
            status: "running",
            runnerProfileJson: sql`(case when jsonb_typeof(${heartbeatRuns.runnerProfileJson}) = 'object' then ${heartbeatRuns.runnerProfileJson} else '{}'::jsonb end) || ${JSON.stringify({ adapterDispatch: { adapterType: agent.adapterType } })}::jsonb`,
            ...legacyControllerClaim(run.runtimeMode),
            responsibleUserId,
            startedAt: run.startedAt ?? claimedAt,
            updatedAt: claimedAt,
          };
          if (nativeReviewContext) {
            if (run.scheduledRetryReason === "native_provider_overloaded") {
              const predecessor = await lockIssueExecutionClaim(tx);
              if (predecessor.blocked) return null;
            }
            return claimQueuedNativeReviewRun(tx, {
              run, claimedAt, claimValues,
              agentNameKey: normalizeAgentNameKey(agent.name),
            });
          }
          return tx.transaction(async (claimTx) => {
            const issueClaim = await lockIssueExecutionClaim(claimTx as unknown as Db);
            if (issueClaim.blocked) return null;
            const claimedRun = await claimTx.update(heartbeatRuns).set(claimValues).where(and(
              eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued"),
            )).returning().then((rows) => rows[0] ?? null);
            await bindClaimedIssueExecution(claimTx as unknown as Db, issueClaim.ownsIssue, claimedRun);
            return claimedRun;
          });
        });
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
        startedAt: claimed.startedAt
          ? new Date(claimed.startedAt).toISOString()
          : null,
        finishedAt: claimed.finishedAt
          ? new Date(claimed.finishedAt).toISOString()
          : null,
      },
    });
    publishRunLifecyclePluginEvent(claimed);

    if (!nativeReviewContext) {
      await setWakeupStatus(claimed.wakeupRequestId, "claimed", { claimedAt });
    }

    // Fix A (lazy locking): stamp executionRunId now that the run is actually running,
    // not at queue time. Guard is idempotent — safe if called more than once.
    const claimedContext = parseObject(claimed.contextSnapshot);
    const claimedIssueId = readNonEmptyString(claimedContext.issueId);
    const claimedWakeReason = readNonEmptyString(claimedContext.wakeReason);
    if (
      !nativeReviewContext && claimedIssueId &&
      claimedWakeReason !== "source_scoped_recovery_action"
    ) {
      const claimedAgent = await getAgent(claimed.agentId);
      await db
        .update(issues)
        .set({
          executionRunId: claimed.id,
          executionAgentNameKey: normalizeAgentNameKey(claimedAgent?.name),
          executionLockedAt: claimedAt,
          updatedAt: claimedAt,
        })
        .where(
          and(
            eq(issues.id, claimedIssueId),
            eq(issues.companyId, claimed.companyId),
            // Mention/context runs can touch an issue, but only the current assignee
            // owns the issue execution lock shown as the active run.
            eq(issues.assigneeAgentId, claimed.agentId),
            ["native_safe_replacement", "native_provider_overloaded"].includes(claimed.scheduledRetryReason ?? "")
              ? or(
                  isNull(issues.checkoutRunId),
                  eq(issues.checkoutRunId, claimed.id),
                )
              : undefined,
            or(
              isNull(issues.executionRunId),
              eq(issues.executionRunId, claimed.id),
            ),
          ),
        );
    }

    return claimed;
  }

  // startNextQueuedRunForAgent checks admission suppression once, then claims
  // runs (sets status "running"), then dispatches each to executeRun, which
  // checks suppression again before it does any work. Suppression (task
  // drain, worktree mode, a database restore) can start in the gap between
  // those two checks. When executeRun's check catches that, the run is
  // already claimed — release it back to "queued" so it does not keep a
  // running execution lock that nothing will ever process. This runs inside
  // the same promise startNextQueuedRunForAgent already tracks in
  // activeRunExecutionPromises, so getTaskDrainStatus() keeps reporting the
  // run as active until the release finishes.
  //
  // The run row, the wakeup request, and the issue execution lock all guard
  // the same claim, so one transaction commits all three writes together. A
  // partial write (for example the run flips to "queued" but the wakeup or
  // issue update then fails) would let the execution promise clear from
  // activeRunExecutionPromises while the wakeup stayed "claimed" or the
  // issue stayed locked to a queued run — task-drain status would then read
  // quiescent while the database still held part of the old claim.
  async function releaseRunClaimedJustBeforeSuppression(runId: string) {
    const now = new Date();
    await db.transaction(async (tx) => {
      const released = await tx
        .update(heartbeatRuns)
        .set({
          status: "queued",
          startedAt: null,
          responsibleUserId: null,
          updatedAt: now,
        })
        .where(
          and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!released) return;

      if (released.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({ status: "queued", claimedAt: null, updatedAt: now })
          .where(and(eq(agentWakeupRequests.id, released.wakeupRequestId), ne(agentWakeupRequests.status, "cancelled")));
      }

      const context = parseObject(released.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      if (issueId) {
        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, released.companyId),
              eq(issues.executionRunId, released.id),
            ),
          );
      }
    });
  }

  async function cancelQueuedRunForBlockedDependencies(
    run: typeof heartbeatRuns.$inferSelect,
    issueId: string,
    unresolvedBlockerIssueIds: string[],
  ) {
    const now = new Date();
    const reason =
      "Cancelled because issue dependencies are still blocked; Paperclip will wake the assignee when blockers resolve";
    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: now,
      error: reason,
      errorCode: "issue_dependencies_blocked",
      resultJson: {
        ...parseObject(run.resultJson),
        stopReason: "issue_dependencies_blocked",
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "dependency_gate",
        timeoutFired: false,
      },
    });
    if (!cancelled) return null;

    await setWakeupStatus(run.wakeupRequestId, "skipped", {
      finishedAt: now,
      error: reason,
    });

    await db
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, run.companyId),
          eq(issues.id, issueId),
          eq(issues.executionRunId, run.id),
        ),
      );

    await appendRunEvent(cancelled, {
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: reason,
      payload: {
        issueId,
        unresolvedBlockerIssueIds,
      },
    });

    return cancelled;
  }

  async function resumeQueuedRuns() {
    if ((await getSchedulingSuppression()).suppressed) return;
    await resumeExecutionWaitComments();
    const cutoff = await getWorktreeExecutionCutoff();
    const pendingInterrupts = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId })
      .from(agentWakeupRequests).innerJoin(companies, eq(companies.id, agentWakeupRequests.companyId))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(companies.status, "active"),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
        lte(agentWakeupRequests.updatedAt, new Date(Date.now() - 30_000)),
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const wake of pendingInterrupts) {
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      await resumeQueuedCommentInterrupt(wake.companyId, wake.id).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to resume interrupted comment queue");
      });
    }
    // A server restart or a message/cleanup race can leave a deferred wake
    // after its owner has released the issue lock. Revisit it through the same
    // release admission, so recovery holds and operator Stops still apply.
    const strandedQueues = await db.select({ wake: agentWakeupRequests })
      .from(agentWakeupRequests)
      .innerJoin(issues, and(eq(issues.companyId, agentWakeupRequests.companyId),
        sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
        eq(issues.assigneeAgentId, agentWakeupRequests.agentId)))
      .innerJoin(companies, and(eq(companies.id, issues.companyId), eq(companies.status, "active")))
      .where(and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        isNull(issues.executionRunId),
        or(and(
          sql`jsonb_typeof(${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'`,
          sql`${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
        ), sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`),
        sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is null`,
        cutoff ? gte(agentWakeupRequests.requestedAt, cutoff) : undefined))
      .orderBy(asc(agentWakeupRequests.updatedAt)).limit(50);
    for (const { wake } of strandedQueues) {
      if (!queuedCommentIdsFromWakePayload(wake.payload).length &&
          !await readQueuedInteractionResponse(db, wake.companyId, String(wake.payload?.issueId), wake.payload)) continue;
      const [latest] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${String(wake.payload?.issueId)}`,
      )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
      await db.update(agentWakeupRequests).set({ updatedAt: new Date() }).where(and(
        eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      if (!latest || !isHeartbeatRunTerminalStatus(latest.status)) continue;
      if (latest.runtimeMode === "native" && typeof wake.payload?.dotAssignmentFollowUp === "string") {
        await releaseIssueExecutionAndPromote(latest, { suppressImmediateRecovery: true }).catch(err => {
          logger.warn({ err, queueId: wake.id }, "failed to promote unread Dot comment after recovery");
        });
        continue;
      }
      if (latest.runtimeMode !== "legacy") continue;
      const cancelledAdmission = latest.status === "cancelled" && !latest.startedAt &&
        latest.errorCode === "execution_reconciliation_required";
      if ((latest.status !== "cancelled" || cancelledAdmission) && await getExecutionBlocker(db, wake.companyId, String(wake.payload?.issueId))) {
        await resumeSavedLegacyComments(wake.companyId, wake.id).catch(err => {
          logger.warn({ err, queueId: wake.id }, "failed to deliver saved legacy comment after recovery stopped");
        });
      }
      await releaseIssueExecutionAndPromote(latest, { suppressImmediateRecovery: true }).catch(err => {
        logger.warn({ err, queueId: wake.id }, "failed to promote stranded legacy comments");
      });
    }

    // The cancellation marker is durable intent. Retry while its exact queue
    // is still deferred, including after a failed cleanup promotion or restart.
    // Normal admission still checks process ownership, leases, pauses, and scope.
    const interruptedQueues = await db
      .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, and(
        sql`${heartbeatRuns.resultJson}->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text`,
        eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
        eq(heartbeatRuns.agentId, agentWakeupRequests.agentId),
      ))
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        eq(heartbeatRuns.status, "cancelled"),
        eq(heartbeatRuns.runtimeMode, "legacy"),
        eq(companies.status, "active"),
        cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
      ));
    for (const run of interruptedQueues) {
      await releaseIssueExecutionAndPromote(run, { suppressImmediateRecovery: true }).catch((err) => {
        logger.error({ err, runId: run.id }, "failed to retry interrupted comment queue");
      });
    }

    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          eq(companies.status, "active"),
          cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
        ),
      );

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  // A 403 from claimQueuedRun comes from the run's own persisted identity
  // (an unverifiable interrupt receipt, a manual wake with no user). Those rows
  // do not change, so the claim fails the same way on every pass and restart.
  function isPermanentClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status === 403;
  }

  // Other 4xx rejections can clear later (a responsible user gets assigned, a
  // conflicting claim finishes). Keep the run queued, but do not let it stop
  // the rest of the queue or startup recovery.
  function isDeferrableClaimRejection(err: unknown): err is HttpError {
    return err instanceof HttpError && err.status >= 400 && err.status < 500;
  }

  // Settle runs that can never be claimed. Letting the error escape stalls the
  // agent's queue and, during startup recovery, stops the server from booting.
  async function cancelRejectedQueuedRuns(
    rejected: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }>,
  ) {
    for (const { run, err } of rejected) {
      logger.warn(
        { err, runId: run.id, agentId: run.agentId, companyId: run.companyId },
        "cancelling queued heartbeat run whose claim was rejected",
      );
      try {
        await cancelRunInternal(
          run.id,
          `Cancelled because the queued run cannot be claimed: ${err.message}`,
          { errorCode: "queued_run_claim_rejected" },
        );
      } catch (cancelErr) {
        logger.error(
          { err: cancelErr, runId: run.id },
          "failed to cancel queued heartbeat run whose claim was rejected; it stays queued for the next recovery pass",
        );
      }
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    if ((await getSchedulingSuppression()).suppressed) return [];
    const cutoff = await getWorktreeExecutionCutoff();
    // Cancelled after the start lock is released: cancelRunInternal promotes the
    // agent's next queued run, which takes this same lock.
    const rejectedClaims: Array<{ run: typeof heartbeatRuns.$inferSelect; err: HttpError }> = [];
    const deferredPostCommitEffects: WakeQueuePostCommitEffect[] = [];
    let cancellationReason: string | undefined;

    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      const invokability = await getAgentInvokability(agent);
      if (!invokability.invokable) {
        if (shouldCancelRunsForNonInvokableAgent(invokability)) {
          cancellationReason = `Cancelled because the agent is not invokable: ${invokability.reason}`;
        }
        return [];
      }
      const policy = parseHeartbeatPolicy(agent);
      const runningCount = await countRunningRunsForAgent(agentId);
      const availableSlots = Math.max(
        0,
        policy.maxConcurrentRuns - runningCount,
      );
      if (availableSlots <= 0) return [];

      const queuedRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "queued"),
            cutoff ? gte(heartbeatRuns.createdAt, cutoff) : undefined,
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt));
      if (queuedRuns.length === 0) return [];

      const dependencyReadiness = await listQueuedRunDependencyReadiness(
        agent.companyId,
        queuedRuns,
      );
      const queuedIssueIds = [
        ...new Set(
          queuedRuns
            .map((run) =>
              readNonEmptyString(parseObject(run.contextSnapshot).issueId),
            )
            .filter((issueId): issueId is string => Boolean(issueId)),
        ),
      ];
      const issueRows = await db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          queuedIssueIds.length > 0
            ? and(
                eq(issues.companyId, agent.companyId),
                inArray(issues.id, queuedIssueIds),
              )
            : sql`false`,
        );
      const issueById = new Map(issueRows.map((row) => [row.id, row]));
      const companyAgents = await listCompanyAgentOrgRows(agent.companyId);
      const prioritizedRuns = [...queuedRuns].sort((left, right) => {
        const leftIssueId = readNonEmptyString(
          parseObject(left.contextSnapshot).issueId,
        );
        const rightIssueId = readNonEmptyString(
          parseObject(right.contextSnapshot).issueId,
        );
        const leftReadiness = leftIssueId
          ? dependencyReadiness.get(leftIssueId)
          : null;
        const rightReadiness = rightIssueId
          ? dependencyReadiness.get(rightIssueId)
          : null;
        const leftReady = leftIssueId
          ? (leftReadiness?.isDependencyReady ?? true)
          : true;
        const rightReady = rightIssueId
          ? (rightReadiness?.isDependencyReady ?? true)
          : true;
        const leftIssue = leftIssueId ? issueById.get(leftIssueId) : null;
        const rightIssue = rightIssueId ? issueById.get(rightIssueId) : null;
        const leftRank = leftIssueId
          ? leftReady
            ? leftIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        const rightRank = rightIssueId
          ? rightReady
            ? rightIssue?.status === "in_progress"
              ? 0
              : 1
            : 3
          : 2;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const leftPriorityRank = issueRunPriorityRank(leftIssue?.priority);
        const rightPriorityRank = issueRunPriorityRank(rightIssue?.priority);
        if (leftPriorityRank !== rightPriorityRank)
          return leftPriorityRank - rightPriorityRank;
        return left.createdAt.getTime() - right.createdAt.getTime();
      });

      const claimedRuns: Array<typeof heartbeatRuns.$inferSelect> = [];
      for (const queuedRun of prioritizedRuns) {
        if (claimedRuns.length >= availableSlots) break;
        let claimed: typeof heartbeatRuns.$inferSelect | null;
        try {
          claimed = await claimQueuedRun(queuedRun, companyAgents, deferredPostCommitEffects);
        } catch (err) {
          if (isPermanentClaimRejection(err)) {
            rejectedClaims.push({ run: queuedRun, err });
            continue;
          }
          if (!isDeferrableClaimRejection(err)) throw err;
          logger.warn(
            { err, runId: queuedRun.id, agentId: queuedRun.agentId, companyId: queuedRun.companyId },
            "queued heartbeat run claim was rejected; leaving it queued for the next recovery pass",
          );
          continue;
        }
        if (claimed) claimedRuns.push(claimed);
      }
      if (claimedRuns.length === 0) return [];

      for (const claimedRun of claimedRuns) {
        const execution = executeRun(claimedRun.id).catch((err) => {
          logger.error(
            { err, runId: claimedRun.id },
            "queued heartbeat execution failed",
          );
        });
        // Register the in-flight execution so drainActiveRunExecutions() can await
        // it. executeRun resolves only after its finally block finishes flushing
        // run rows/events, so awaiting this promise guarantees the run's writes
        // have landed before a caller (e.g. a test's afterEach) mutates the DB.
        activeRunExecutionPromises.add(execution);
        void execution.finally(() => {
          // drainActiveRunExecutions loops on activeRunExecutionPromises.size,
          // so an entry that never clears here would hang it forever.
          activeRunExecutionPromises.delete(execution);
        });
      }
      return claimedRuns;
    }).finally(async () => {
      // Dispatch promoted inputs after the agent start lock is released.
      try {
        await applyWakeQueuePostCommitEffects(deferredPostCommitEffects);
      } finally {
        if (cancellationReason) await cancelActiveForAgentInternal(agentId, cancellationReason);
        await cancelRejectedQueuedRuns(rejectedClaims);
      }
    });
  }

  // Public wakeup entry point. Callers dispatch it fire-and-forget, so register
  // the promise in activeWakeupPromises before it starts its asynchronous
  // prologue. drainActiveRunExecutions can then await a wake that is still before
  // run registration. Internal callers reference enqueueWakeup directly and
  // already await it, so they do not need this registration.
  function trackWakeup(
    agentId: string,
    opts: WakeupOptions = {},
  ): ReturnType<typeof enqueueWakeup> {
    const promise = enqueueWakeup(agentId, opts);
    activeWakeupPromises.add(promise);
    void promise
      .catch(() => {})
      .finally(() => {
        activeWakeupPromises.delete(promise);
      });
    return promise;
  }

  async function enqueueWakeup(agentId: string, opts: WakeupOptions = {}, executionWaitRequestId?: string) {
    const source = opts.source ?? "on_demand";
    const triggerDetail = opts.triggerDetail ?? null;
    const contextSnapshot: Record<string, unknown> = {
      ...(opts.contextSnapshot ?? {}),
    };
    const reason = opts.reason ?? null;
    let payload = opts.payload ? { ...opts.payload } : null;
    // Only the board queue route can record interruption authority on an
    // existing receipt. Never accept this internal marker from a wake caller.
    if (payload) {
      delete payload.queuedCommentInterrupt;
      delete payload.manualUserWake;
    }
    if (opts.manualUserWake) {
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId || opts.failedRunId) {
        throw new HttpError(403, "Manual wake requires an authenticated user");
      }
      payload = { ...payload, manualUserWake: true };
    }
    const executionReconciliationWake =
      contextSnapshot.source === "execution.reconciled" ||
      opts.idempotencyKey?.startsWith("execution-reconciliation:") === true;
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
    // Keep each request's own server-derived origin, including coalesced wakes.
    // A run's merged context cannot establish which caller authored one receipt.
    // Overwrite caller-supplied nested context rather than trusting it.
    payload = { ...payload, [DEFERRED_WAKE_CONTEXT_KEY]: { ...enrichedContextSnapshot } };
    let issueId =
      readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;
    if (executionReconciliationWake && !issueId) return null;

    let agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    // Mentions only annotate comments. Ignore legacy callers before creating
    // a run or deferred request; assignment and review have their own wakes.
    if (reason === "issue_comment_mentioned" || enrichedContextSnapshot.wakeReason === "issue_comment_mentioned") return null;
    if (issueId) {
      const conversation = await getIssueExecutionContext(agent.companyId, issueId);
      if (reason === "issue_children_completed" && conversation?.originKind === "onboarding_first_task") enrichedContextSnapshot.onboardingCompletion = true;
      if (isConversation(conversation)) {
        if (opts.manualUserWake && conversation!.conversationUserId !== opts.requestedByActorId) {
          throw new HttpError(403, "Only the conversation owner can start a chat run");
        }
        if (isConversationExecutionWake(conversation, reason ?? readNonEmptyString(enrichedContextSnapshot.wakeReason))) return null;
        if (agent.id !== conversation!.conversationAgentId) return null;
        if (!(await instanceSettings.getExperimental()).enableAgentChat) return null;
        if (!wakeCommentId && isWaitingConversation(conversation) && !hasInteractionContinuationWakeContext(enrichedContextSnapshot) && reason !== CHAT_COMPLETION_WAKE_REASON) return null;
      }
    }
    if (agent.adapterType === "paperclip_runner") {
      const oldConfig = parseObject(agent.adapterConfig);
      const nextConfig = normalizeLegacyRunnerProvider(oldConfig);
      if (nextConfig !== oldConfig) {
        await agentService(db).update(
          agent.id,
          { adapterConfig: nextConfig },
          {
            recordRevision: {
              source: "normalize_runner_provider",
              createdByAgentId: null,
              createdByUserId: null,
            },
          },
        );
        await logActivity(db, {
          companyId: agent.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          details: { provider: "codex", reason: "native_codex_provider" },
        });
        agent = (await getAgent(agentId))!;
      }
    }

    if (opts.failedRunId) {
      const failed = await getRun(opts.failedRunId, { includeExecutionEvidence: true });
      if (opts.requestedByActorType !== "user" || !opts.requestedByActorId ||
          reason !== "retry_failed_run" || source !== "on_demand" || triggerDetail !== "manual" ||
          !failed || failed.companyId !== agent.companyId || failed.agentId !== agentId ||
          !(await canRetryStoppedRun(db, failed)) ||
          (failed.nativeIssueId ?? readNonEmptyString(failed.contextSnapshot?.issueId)) !== issueId) {
        throw conflict("The selected failed run cannot be retried for this task.");
      }
      if (!activeRunExecutions.has(failed.id) && !adapterExecutionControls.has(failed.id)) {
        await sweepPendingCleanupLeases({ explicitRetry: {
          companyId: failed.companyId, runId: failed.id, actorId: opts.requestedByActorId,
        } });
      }
      if (isConversationAdapter(agent.adapterType) || agent.adapterType === "paperclip_runner") {
        enrichedContextSnapshot.previousRunId = failed.id;
        enrichedContextSnapshot.forceFreshSession = true;
      }
    }

    const durableRequest = opts.durableChatRequest;
    if (durableRequest) {
      assertDurableChatWakeupRequest(durableRequest, {
        agentId,
        companyId: agent.companyId,
        issueId,
        commentId: wakeCommentId ?? null,
        requestedByActorType: opts.requestedByActorType,
        requestedByActorId: opts.requestedByActorId,
      });
      opts = { ...opts, idempotencyKey: durableRequest.idempotencyKey };
    }
    if (
      Object.hasOwn(enrichedContextSnapshot, "chatFailedRunRetry") &&
      !durableRequest?.failedRunRetry
    ) {
      throw new FailedChatRunRetryAuthorizationError();
    }
    if (durableRequest?.failedRunRetry) {
      opts = { ...opts, allowRunCoalescing: false };
    }
    const dotRequest = opts.durableDotRequest;
    if (dotRequest && (durableRequest || dotRequest.agentId !== agentId ||
        dotRequest.companyId !== agent.companyId || dotRequest.issueId !== issueId ||
        dotRequest.requestId !== payload?.dotRequestId || source !== "assignment" ||
        opts.requestedByActorType !== "agent" || opts.requestedByActorId !== agentId ||
        agent.adapterType !== "paperclip_runner" || parseObject(agent.adapterConfig).provider !== "openai_dot" ||
        opts.idempotencyKey !== dotRequest.idempotencyKey)) {
      throw conflict("Dot work request does not match its admission authority.");
    }
    const receiptRequest = durableRequest ?? dotRequest;
    const durableReceiptFields = receiptRequest
      ? { id: receiptRequest.id, requestedAt: receiptRequest.requestedAt }
      : {};
    const existingDurableReceipt = async (queryDb: Db) => {
      if (!receiptRequest) return null;
      const receipt = await queryDb
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, receiptRequest.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (receipt && durableRequest) assertDurableChatWakeupReceipt(durableRequest, receipt);
      if (receipt && dotRequest && (receipt.companyId !== dotRequest.companyId ||
          receipt.agentId !== dotRequest.agentId || receipt.source !== "assignment" ||
          receipt.requestedByActorType !== "agent" || receipt.requestedByActorId !== dotRequest.agentId ||
          receipt.idempotencyKey !== dotRequest.idempotencyKey || receipt.payload?.issueId !== dotRequest.issueId ||
          receipt.payload?.dotRequestId !== dotRequest.requestId)) {
        throw conflict("requestId was reused for another task.");
      }
      return receipt;
    };
    const priorReceipt = await existingDurableReceipt(db);
    if (priorReceipt) {
      // Replaying an admission receipt is not fresh authority to dispatch it.
      // The normal queue owns dispatch and its current execution-policy checks.
      return priorReceipt.runId ? getRun(priorReceipt.runId) : null;
    }

    const agentDebug = parseObject(parseObject(agent.runtimeConfig).debug);
    const runDebug = parseObject(enrichedContextSnapshot.debug);
    if (
      agentDebug.providerTrace === "raw" &&
      runDebug.providerTrace !== "raw"
    ) {
      enrichedContextSnapshot.debug = {
        ...runDebug,
        providerTrace: "raw",
      };
      enrichedContextSnapshot.providerTraceRequestedBy = `agent:${agent.id}:debug-setting`;
      enrichedContextSnapshot.providerTraceRequestSource =
        "agent_debug_setting";
    }

    // Automatic signals are replaceable; user input and interaction delivery
    // retain distinct durable receipts even when the same gate blocks them.
    const coalesceExecutionWait =
      opts.requestedByActorType === "system" &&
      !receiptRequest &&
      !wakeCommentId &&
      queuedCommentIdsFromRunContext(enrichedContextSnapshot).length === 0 &&
      !isInteractionResolutionWakePayload(payload ?? {}) &&
      !hasInteractionContinuationWakeContext(enrichedContextSnapshot);
    const writeSkippedRequest = async (
      skipReason: string,
      patch: Partial<typeof agentWakeupRequests.$inferInsert> = {},
      waitCondition?: Record<string, unknown>,
    ) => {
      if (executionWaitRequestId) {
        await db.update(agentWakeupRequests).set({
          payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}',
            coalesce(${agentWakeupRequests.payload}->'executionWait', '{}'::jsonb) || ${JSON.stringify({
              reason: skipReason, message: patch.error ?? (skipReason === "issue_tree_hold_active"
                ? "This task is paused. Resume it to send your saved message."
                : "Waiting for task execution to be enabled. Your message is saved."),
            })}::jsonb)`,
          updatedAt: new Date(),
        }).where(and(eq(agentWakeupRequests.id, executionWaitRequestId),
          eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, "deferred_issue_execution")));
        return { created: false };
      }
      const request = {
        ...durableReceiptFields,
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: skipReason,
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
        ...patch,
      };
      if (waitCondition && issueId && isUuidLike(issueId)) {
        const waitIssueId = issueId;
        return db.transaction(async (tx) => {
          await tx.execute(sql`select id from issues where id = ${waitIssueId} and company_id = ${agent.companyId} for update`);
          return recordExecutionWait(tx as unknown as Db, {
            issueId: waitIssueId, request, condition: waitCondition, coalesce: coalesceExecutionWait,
          });
        });
      }
      await db.insert(agentWakeupRequests).values(request);
      return { created: true };
    };
    const writeSkippedHeartbeatRequest = async (
      skipReason: string,
      details: Record<string, unknown>,
    ) => {
      await writeSkippedRequest(skipReason, {
        payload: {
          ...(payload ?? {}),
          heartbeatSkip: details,
        },
      });
    };

    const schedulingSuppression = await getSchedulingSuppression();
    // A task drain holds ADMISSION, not the request. The drain is a
    // process-local pre-restart hold, so a wake that arrives while it is
    // active still names real work that must run once the process comes
    // back: leave it in the durable queue and let the dispatch-side checks
    // (startNextQueuedRunForAgent / executeRun) keep it from starting until
    // the drain lifts or the restart clears it. Writing it as `skipped`
    // here dropped the wake permanently — an accepted plan whose
    // continuation wake landed mid-drain left its issue in `todo` with no
    // run and no path until a person noticed.
    if (
      schedulingSuppression.suppressed &&
      schedulingSuppression.reason !== "task_drain"
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.scheduling_suppressed", {
        reason: schedulingSuppression.reason,
      });
      return null;
    }

    const worktreeExecutionCutoff =
      opts.requestedByActorType === "user"
        ? null
        : await getWorktreeExecutionCutoff();

    const company = await db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, agent.companyId))
      .then((rows) => rows[0] ?? null);

    if (!company || company.status !== "active") {
      const companyStatus = company?.status ?? "missing";
      if (opts.requestedByActorType === "user") {
        throw conflict("Company is not active", { status: companyStatus });
      }
      await writeSkippedRequest("company.inactive", {
        error: `Wake suppressed because company status is ${companyStatus}`,
      }, { companyStatus });
      return null;
    }

    const explicitResumeSession = await resolveExplicitResumeSessionOverride(
      agent,
      payload,
      taskKey,
    );
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId =
        explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId =
        explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams =
        explicitResumeSession.sessionParams;
      if (
        !readNonEmptyString(enrichedContextSnapshot.issueId) &&
        explicitResumeSession.issueId
      ) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskId) &&
        explicitResumeSession.taskId
      ) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (
        !readNonEmptyString(enrichedContextSnapshot.taskKey) &&
        explicitResumeSession.taskKey
      ) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey =
      readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      (await resolveSessionBeforeForWakeup(agent, effectiveTaskKey));
    let hasResolvablePriorSessionWorkspace: boolean | null = null;
    const resolveHasResolvablePriorSessionWorkspace = async () => {
      if (hasResolvablePriorSessionWorkspace !== null)
        return hasResolvablePriorSessionWorkspace;
      hasResolvablePriorSessionWorkspace = issueId
        ? await hasResolvablePriorSessionWorkspaceForWake({
            agent,
            contextSnapshot: enrichedContextSnapshot,
            taskKey: effectiveTaskKey,
            explicitResumeSession,
          })
        : false;
      return hasResolvablePriorSessionWorkspace;
    };
    const continuationAttempt = readContinuationAttempt(
      enrichedContextSnapshot.livenessContinuationAttempt,
    );

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      // Look up by either UUID or identifier (e.g. "ENV-13"), but always scope
      // by companyId so a row from another tenant can never be returned even
      // when identifiers collide across companies. Guard the UUID arm because
      // issues.id is a Postgres uuid column — passing "ENV-13" into eq(issues.id, …)
      // would fail with an invalid-input-syntax cast error before the OR is
      // evaluated.
      const lookupIsUuid = isUuidLike(issueId);
      const idMatch = lookupIsUuid
        ? or(
            eq(issues.id, issueId),
            eq(issues.identifier, issueId.toUpperCase()),
          )
        : eq(issues.identifier, issueId.toUpperCase());
      const resolvedIssue = await db
        .select({
          id: issues.id,
          projectId: issues.projectId,
          createdAt: issues.createdAt,
        })
        .from(issues)
        .where(and(eq(issues.companyId, agent.companyId), idMatch))
        .then((rows) => rows[0] ?? null);
      if (resolvedIssue) {
        if (
          worktreeExecutionCutoff &&
          resolvedIssue.createdAt < worktreeExecutionCutoff
        ) {
          await writeSkippedHeartbeatRequest(
            "heartbeat.worktree_execution_cutoff",
            {
              reason: "worktree_execution_cutoff",
              cutoff: worktreeExecutionCutoff.toISOString(),
              issueId: resolvedIssue.id,
            },
          );
          return null;
        }
        projectId = resolvedIssue.projectId ?? null;
        // Canonicalize context to the UUID so downstream lookups always use UUID
        if (resolvedIssue.id !== issueId) {
          issueId = resolvedIssue.id;
          enrichedContextSnapshot.issueId = issueId;
          if (readNonEmptyString(enrichedContextSnapshot.taskId)) {
            enrichedContextSnapshot.taskId = issueId;
          }
        }
      }
    }
    // Propagate projectId into context so resolveWorkspaceForRun can bind the
    // project workspace even when context.projectId wasn't set by the caller.
    if (projectId && !readNonEmptyString(enrichedContextSnapshot.projectId)) {
      enrichedContextSnapshot.projectId = projectId;
    }
    const isolatedWorkspacesEnabled = issueId
      ? (await instanceSettings.getExperimental()).enableIsolatedWorkspaces
      : false;
    let operatorResponsibleUserId: string | null = opts.manualUserWake ? opts.requestedByActorId! : null;
    let queuedResponsibleUserIdPromise: Promise<string> | null = null;
    const resolveQueuedResponsibleUserId = () => {
      if (operatorResponsibleUserId) return Promise.resolve(operatorResponsibleUserId);
      queuedResponsibleUserIdPromise ??= (async () => {
        const queuedIssueContext = issueId
          ? await getIssueExecutionContext(agent.companyId, issueId)
          : null;
        const queuedRoutineEnvContext = await getRoutineEnvForExecutionIssue(
          agent.companyId,
          queuedIssueContext,
        );
        const queuedResponsibleUserId =
          await resolveResponsibleUserIdForRunSeed({
            companyId: agent.companyId,
            contextSnapshot: enrichedContextSnapshot,
            issueContext: queuedIssueContext,
            routineEnvContext: queuedRoutineEnvContext,
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            source,
            triggerDetail,
          });
        if (!queuedResponsibleUserId) {
          throw new HttpError(
            422,
            "Unable to resolve responsible user for heartbeat run dispatch",
            {
              code: "responsible_user_unresolved",
              agentId,
              companyId: agent.companyId,
              issueId: issueId ?? null,
              source,
              triggerDetail,
              wakeReason: readNonEmptyString(
                enrichedContextSnapshot.wakeReason,
              ),
            },
          );
        }
        return queuedResponsibleUserId;
      })();
      return queuedResponsibleUserIdPromise;
    };

    const budgetBlock = await budgets.getInvocationBlock(
      agent.companyId,
      agentId,
      {
        issueId,
        projectId,
      },
    );
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked", { error: budgetBlock.reason }, {
        scopeType: budgetBlock.scopeType, scopeId: budgetBlock.scopeId,
      });
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    // Setup delays execution, but must not discard work accepted by a caller.
    const invokability = await getAgentInvokability(isAgentAwaitingSetup(agent) ? { ...agent, status: "idle" } : agent);
    if (!invokability.invokable) {
      if (opts.requestedByActorType !== "user" || executionWaitRequestId) {
        await writeSkippedRequest("agent.not_invokable", {
          error: invokability.message,
        }, { status: agent.status, reason: invokability.reason });
      }
      throw conflict(invokability.message, {
        status: agent.status,
        reason: invokability.reason,
        invalidOrgChain: invokability.invalidOrgChain,
        ...invokability.details,
      });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled", {}, { enabled: false });
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled", {}, { wakeOnDemand: false });
      return null;
    }

    const genericTimerWake =
      source === "timer" &&
      !issueId &&
      !wakeCommentId &&
      !readNonEmptyString(enrichedContextSnapshot.taskId) &&
      !readNonEmptyString(enrichedContextSnapshot.taskKey);
    if (
      policy.skipTimerWhenNoActionableWork &&
      genericTimerWake &&
      !(await hasActionableTimerWork(agent))
    ) {
      await writeSkippedHeartbeatRequest("heartbeat.timer.no_actionable_work", {
        reason:
          "No assigned todo or in_progress issue requires this agent before timer adapter invocation.",
      });
      await markTimerHeartbeatChecked(agentId, source);
      return null;
    }

    if (issueId) {
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
        agent.companyId,
        issueId,
      );
      if (activePauseHold) {
        const treeHoldInteractionWake =
          await isVerifiedIssueTreeControlInteractionWake(db, {
            companyId: agent.companyId,
            issueId,
            agentId,
            contextSnapshot: enrichedContextSnapshot,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
          });

        if (!treeHoldInteractionWake) {
          const wait = await writeSkippedRequest("issue_tree_hold_active", {}, {
            holdId: activePauseHold.holdId,
          });
          if (wait.created) await logActivity(db, {
            companyId: agent.companyId,
            actorType: "system",
            actorId: "system",
            agentId,
            runId: null,
            action: "issue.tree_hold_wakeup_deferred",
            entityType: "issue",
            entityId: issueId,
            details: {
              holdId: activePauseHold.holdId,
              rootIssueId: activePauseHold.rootIssueId,
              requestedReason: reason,
              source,
              triggerDetail,
              securityPrinciples: [
                "Complete Mediation",
                "Fail Securely",
                "Secure Defaults",
              ],
            },
          });
          return null;
        }

        enrichedContextSnapshot.treeHoldInteraction = true;
        enrichedContextSnapshot.activeTreeHold = {
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          reason: activePauseHold.reason,
          releasePolicy: activePauseHold.releasePolicy,
          interaction: true,
        };
      }
    }

    if (issueId) {
      // Mention-triggered wakes can request input from another agent, but they must
      // still respect the issue execution lock so a second agent cannot start on the
      // same issue workspace while the assignee already has a live run.
      const agentNameKey = normalizeAgentNameKey(agent.name);

      const cancelledRunsToEmit: (typeof heartbeatRuns.$inferSelect)[] = [];

      const outcome = await db
        .transaction(async (tx) => {
          await tx.execute(
            sql`select id from issues where id = ${issueId} and company_id = ${agent.companyId} for update`,
          );

          if (executionWaitRequestId) {
            const [pending] = await tx.select().from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.id, executionWaitRequestId), eq(agentWakeupRequests.companyId, agent.companyId),
              eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
              // A user message can join a queue originally created by a
              // system wake. Admission validates the saved user comment or board click.
              (opts.queuedCommentInterruptId ?? opts.queuedCommentRequestId) === executionWaitRequestId
                ? undefined : eq(agentWakeupRequests.requestedByActorType, "user"),
              opts.queuedCommentInterruptId === executionWaitRequestId
                ? sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt'->>'actorId' = ${opts.requestedByActorId ?? ""}`
                : opts.queuedCommentRequestId === executionWaitRequestId ? undefined
                  : eq(agentWakeupRequests.requestedByActorId, opts.requestedByActorId ?? ""),
              sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
            ));
            // The issue lock serializes cleanup callbacks and periodic workers.
            // An adopted, discarded, or edited receipt is no longer authority.
            if (!pending || (!(wakeCommentId && queuedCommentIdsFromWakePayload(pending.payload).includes(wakeCommentId)) &&
                !(opts.queuedCommentInterruptId && await readQueuedInteractionResponse(tx as unknown as Db,
                  agent.companyId, issueId, pending.payload)))) {
              return { kind: "deferred" as const };
            }
            if (opts.queuedCommentRequestId) {
              const ids = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
                agent.companyId, issueId, agentId, queuedCommentIdsFromWakePayload(pending.payload));
              if (!wakeCommentId || !ids.includes(wakeCommentId)) return { kind: "deferred" as const };
              pending.payload = withQueuedCommentIdsInWakePayload(parseObject(pending.payload), ids);
              await tx.update(agentWakeupRequests).set({ payload: pending.payload }).where(and(
                eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, agent.companyId),
              ));
            }
            if (!opts.queuedCommentInterruptId && !opts.queuedCommentRequestId && pending.payload?.manualUserWake === true) {
              // A persisted manual wake keeps its actor when an execution wait
              // resumes. The locked receipt above has revalidated that actor.
              payload = { ...payload, manualUserWake: true };
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId) {
              // The locked board receipt supplies execution authority even when
              // another user authored the messages. Dispatch revalidates the receipt.
              operatorResponsibleUserId = opts.requestedByActorId!;
            }
            if (opts.queuedCommentInterruptId || opts.queuedCommentRequestId) {
              // Edits/discards between the click and dispatch remain authoritative.
              Object.assign(enrichedContextSnapshot, withQueuedCommentIdsInRunContext(
                enrichedContextSnapshot, queuedCommentIdsFromWakePayload(pending.payload),
              ));
            }
          }
          let automaticParentRunId: string | null = null;
          if (
            source === "automation" &&
            opts.requestedByActorType === "system"
          ) {
            const nativeParent = await readChatControlNativeParent(
              tx as unknown as Db,
              { companyId: agent.companyId, issueId, agentId },
              opts.requestedByActorId ?? null,
            );
            const genericParent =
              !opts.requestedByActorId && reason === "issue_continuation_needed"
                ? readNonEmptyString(enrichedContextSnapshot.retryOfRunId)
                : null;
            automaticParentRunId =
              nativeParent.kind === "parent"
                ? nativeParent.runId
                : genericParent;
            if (automaticParentRunId) {
              const [parent] = await tx
                .select({
                  agentId: heartbeatRuns.agentId,
                  context: heartbeatRuns.contextSnapshot,
                })
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, agent.companyId),
                    eq(heartbeatRuns.id, automaticParentRunId),
                  ),
                )
                .limit(1);
              if (
                parent &&
                (parseObject(parent.context).issueId ??
                  parseObject(parent.context).taskId) === issueId &&
                parent.agentId !== agentId
              )
                automaticParentRunId = null;
            }
            const proof =
              nativeParent.kind === "unresolved"
                ? { kind: "unresolved" as const }
                : automaticParentRunId
                  ? await readChatControlRecoveryStop(
                      tx as unknown as Db,
                      {
                        companyId: agent.companyId,
                        issueId,
                        agentId,
                        sourceRunId: automaticParentRunId,
                      },
                      true,
                    )
                  : { kind: "clear" as const };
            if (proof.kind !== "clear") {
              await tx
                .insert(agentWakeupRequests)
                .values({
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason:
                    proof.kind === "stopped"
                      ? CHAT_CONTROL_RECOVERY_STOP_CODE
                      : CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
                  payload: { issueId },
                  status: "skipped",
                  requestedByActorType: "system",
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: new Date(),
                });
              return { kind: "skipped" as const };
            }
          }

          const durableReceipt = await existingDurableReceipt(
            tx as unknown as Db,
          );
          if (durableReceipt)
            return { kind: "durable" as const, receipt: durableReceipt };
          const failedChatRetry = await authorizeFailedChatRunRetryWake(
            db,
            tx as unknown as Db,
            {
              phase: "admission",
              wakeupRequestId: durableRequest?.id ?? null,
              companyId: agent.companyId,
              agentId,
              issueId,
              contextSnapshot: enrichedContextSnapshot,
            },
          );
          if (
            failedChatRetry !== Boolean(durableRequest?.failedRunRetry) ||
            (failedChatRetry &&
              durableRequest?.failedRunRetry?.failedRunId !==
                readNonEmptyString(enrichedContextSnapshot.retryOfRunId))
          ) {
            throw new FailedChatRunRetryAuthorizationError();
          }
          if (durableRequest) {
            if (issueId !== durableRequest.issueId)
              throw new Error("chat_inbound_wakeup_binding_denied");
            await durableRequest.authorize(tx as unknown as Db);
          } else {
            if (
              source === "on_demand" &&
              triggerDetail === "manual" &&
              reason === "retry_failed_run"
            ) {
              // Generic Board retry does not carry server-authorized failed-run
              // lineage. Caller-supplied source/comment/retry markers cannot
              // restore it, including for a retired conversation generation.
              const [chatBinding] = await tx
                .select({ id: chatConversations.id })
                .from(chatConversations)
                .innerJoin(chatEndpoints, eq(chatEndpoints.id, chatConversations.endpointId))
                .where(
                  and(
                    eq(chatEndpoints.externalExecutionPolicy, "restricted"),
                    eq(chatConversations.companyId, agent.companyId),
                    eq(chatConversations.issueId, issueId),
                  ),
                )
                .limit(1);
              if (chatBinding) {
                throw conflict(
                  "Retry needs the exact failed chat request and current access. Send the request again in the current connected conversation.",
                  { code: "chat_failed_run_retry_requires_authorized_context" },
                );
              }
            }
            const [held] = await tx
              .select({ id: issues.id })
              .from(issues)
              .where(
                and(
                  eq(issues.id, issueId),
                  eq(issues.companyId, agent.companyId),
                  unadmittedChatWakeupCondition(issues.id, issues.companyId),
                ),
              )
              .limit(1);
            if (held) {
              throw conflict(
                "This task has external chat input that has not been admitted. Check the connection's Activity; let pending input finish, or restore access and send a new authorized message before starting the task.",
                { code: "chat_inbound_wakeup_unadmitted", issueId },
              );
            }
          }

          const issue = await tx
            .select({
              id: issues.id,
              companyId: issues.companyId,
              identifier: issues.identifier,
              conversationAgentId: issues.conversationAgentId,
              conversationUserId: issues.conversationUserId,
              conversationState: issues.conversationState,
              status: issues.status,
              statusVersion: issues.statusVersion,
              projectId: issues.projectId,
              projectWorkspaceId: issues.projectWorkspaceId,
              executionWorkspaceId: issues.executionWorkspaceId,
              executionWorkspacePreference: issues.executionWorkspacePreference,
              executionWorkspaceSettings: issues.executionWorkspaceSettings,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
              monitorNextCheckAt: issues.monitorNextCheckAt,
              monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
              executionRunId: issues.executionRunId,
              executionAgentNameKey: issues.executionAgentNameKey,
              createdAt: issues.createdAt,
            })
            .from(issues)
            .where(
              and(
                eq(issues.id, issueId),
                eq(issues.companyId, agent.companyId),
              ),
            )
            .then((rows) => rows[0] ?? null);

          if (!issue) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
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

          const issueStateGuard = opts.issueStateGuard;
          const activeMonitorRun = issueStateGuard?.monitorNextCheckAt === undefined ? null
            : await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.nativeIssueId, issue.id),
              eq(heartbeatRuns.runtimeMode, "native"), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
            )).limit(1).then(rows => rows[0] ?? null);
          if (
            issueStateGuard &&
            (!issueStateGuard.statuses.includes(issue.status) ||
              issue.assigneeAgentId !== issueStateGuard.assigneeAgentId ||
              (issueStateGuard.statusVersion !== undefined && issue.statusVersion !== issueStateGuard.statusVersion) ||
              (issueStateGuard.monitorNextCheckAt !== undefined && (
                activeMonitorRun !== null || issue.assigneeUserId !== null ||
                issue.monitorNextCheckAt?.toISOString() !== issueStateGuard.monitorNextCheckAt ||
                issue.monitorWakeRequestedAt?.toISOString() !== issueStateGuard.monitorWakeRequestedAt
              )))
          ) {
            // A deferred monitor retains its schedule; do not create a receipt
            // that could suppress its next admission attempt.
            if (issueStateGuard.monitorNextCheckAt !== undefined) return { kind: "skipped" as const };
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "issue_state_guard_mismatch",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Issue status or assignee changed before the wake could be queued.",
                  issueId: issue.id,
                  expectedStatuses: issueStateGuard.statuses,
                  actualStatus: issue.status,
                  expectedAssigneeAgentId: issueStateGuard.assigneeAgentId,
                  actualAssigneeAgentId: issue.assigneeAgentId,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          if (opts.failedRunId) {
            // The issue lock makes double-clicks and network retries adopt the
            // same successor, including after it has already finished.
            const [previousRetry] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId),
              eq(heartbeatRuns.retryOfRunId, opts.failedRunId),
              sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'retry_failed_run'`,
            )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
            if (previousRetry) return { kind: "replayed" as const, run: previousRetry };
          }

          let reconciledSourceRunId: string | null = null;
          let reconciledRestoreRetryCount: number | null = null;
          if (executionReconciliationWake) {
            const actionId = readNonEmptyString(
              enrichedContextSnapshot.recoveryActionId,
            );
            if (
              !actionId ||
              !isUuidLike(actionId) ||
              source !== "automation" ||
              triggerDetail !== "system" ||
              reason !== "issue_recovery_action_restored" ||
              opts.requestedByActorType !== "system" ||
              opts.requestedByActorId !== "execution-recovery" ||
              opts.idempotencyKey !== `execution-reconciliation:${actionId}` ||
              enrichedContextSnapshot.source !== "execution.reconciled" ||
              enrichedContextSnapshot.forceFreshSession !== true ||
              payload?.issueId !== issue.id ||
              payload?.recoveryActionId !== actionId ||
              issue.assigneeAgentId !== agentId ||
              ["done", "cancelled"].includes(issue.status)
            )
              return { kind: "skipped" as const };

            // The issue lock serializes all admissions for this source. Validate
            // the durable operator decision, then reconcile a prior queue commit
            // before considering a new wake (including a now-terminal successor).
            const [action] = await tx
              .select()
              .from(issueRecoveryActions)
              .where(
                and(
                  eq(issueRecoveryActions.companyId, issue.companyId),
                  eq(issueRecoveryActions.sourceIssueId, issue.id),
                  eq(issueRecoveryActions.id, actionId),
                ),
              )
              .for("update");
            const decision = parseObject(
              action?.evidence.executionReconciliation,
            );
            const sourceRunId = readNonEmptyString(decision.runId);
            if (
              !action ||
              action.status !== "resolved" ||
              action.kind !== "active_run_watchdog" ||
              action.returnOwnerAgentId !== agentId ||
              !sourceRunId ||
              !isUuidLike(sourceRunId) ||
              decision.providerStopped !== true ||
              !["completed", "not_performed", "mixed"].includes(
                String(decision.actionOutcome),
              ) ||
              !readNonEmptyString(decision.outcomeEvidence) ||
              enrichedContextSnapshot.previousRunId !== sourceRunId ||
              enrichedContextSnapshot.retryOfRunId !== sourceRunId ||
              !["pending", "delivered"].includes(
                String(action.evidence.continuationDelivery),
              )
            )
              return { kind: "skipped" as const };

            const [existingWake] = await tx
              .select()
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, issue.companyId),
                  eq(agentWakeupRequests.agentId, agentId),
                  eq(agentWakeupRequests.idempotencyKey, opts.idempotencyKey),
                  ne(agentWakeupRequests.status, "skipped"),
                ),
              )
              .orderBy(asc(agentWakeupRequests.requestedAt))
              .limit(1);
            if (existingWake) {
              if (
                existingWake.payload?.issueId !== issue.id ||
                existingWake.payload?.recoveryActionId !== action.id ||
                existingWake.requestedByActorType !== "system" ||
                existingWake.requestedByActorId !== "execution-recovery" ||
                !existingWake.runId
              )
                return { kind: "deferred" as const };
              const [existingRun] = await tx
                .select()
                .from(heartbeatRuns)
                .where(
                  and(
                    eq(heartbeatRuns.companyId, issue.companyId),
                    eq(heartbeatRuns.agentId, agentId),
                    eq(heartbeatRuns.id, existingWake.runId),
                  ),
                );
              if (
                !existingRun ||
                existingRun.contextSnapshot?.issueId !== issue.id ||
                existingRun.contextSnapshot?.recoveryActionId !== action.id ||
                existingRun.contextSnapshot?.previousRunId !== sourceRunId
              )
                return { kind: "deferred" as const };
              return { kind: "replayed" as const, run: existingRun };
            }
            if (action.evidence.continuationDelivery !== "pending")
              return { kind: "skipped" as const };
            const [reconciledRun] = await tx.select().from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, sourceRunId),
            ));
            if (hasWorkspaceRestoreFailure(reconciledRun?.resultJson)) {
              if ((readNonEmptyString(decision.workspaceRepairEvidence)?.length ?? 0) < 20)
                return { kind: "skipped" as const };
              // Repair does not reset the remaining automatic retry budget.
              reconciledRestoreRetryCount = executionFailureRetryCount(reconciledRun!);
            }
            reconciledSourceRunId = sourceRunId;
          }

          let continuationWait = { reason: "execution_recovery", message: "Waiting for execution recovery. Your message is saved." };
          const deferBlockedExecution = async (
            executionBlocker: NonNullable<Awaited<ReturnType<typeof getExecutionBlocker>>>,
          ) => {
            const condition = { recoveryActionId: executionBlocker.recoveryActionId, ...continuationWait };
            if (executionWaitRequestId) {
              await tx.update(agentWakeupRequests).set({
                payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}', ${JSON.stringify(condition)}::jsonb)`,
                updatedAt: new Date(),
              }).where(eq(agentWakeupRequests.id, executionWaitRequestId));
              return { kind: "deferred" as const };
            }
            if (durableRequest || wakeCommentId ||
                hasInteractionContinuationWakeContext(enrichedContextSnapshot) ||
                readNonEmptyString(enrichedContextSnapshot.nativeStatusWakeIntentId)) {
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId, agentId, source, triggerDetail, reason,
                payload: withQueuedCommentIdsInWakePayload({
                  ...payload,
                  issueId: issue.id,
                  [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot,
                  executionWait: condition,
                }, [...new Set([
                  ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
                  ...(wakeCommentId ? [wakeCommentId] : []),
                ])]),
                status: "deferred_issue_execution",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              });
            } else {
              await recordExecutionWait(tx as unknown as Db, {
                issueId: issue.id, condition, coalesce: coalesceExecutionWait,
                request: {
                  ...durableReceiptFields,
                  companyId: agent.companyId, agentId, source, triggerDetail,
                  reason: "execution_reconciliation_required",
                  error: executionBlocker.nextAction,
                  payload,
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                },
              });
            }
            return { kind: "deferred" as const };
          };
          const explicitContinuationRunId = randomUUID();
          const executionBlocker = await getExecutionBlocker(
            tx as unknown as Db, issue.companyId, issue.id,
            { conversationResetCommentId: opts.requestedByActorType === "user" ? wakeCommentId : null },
          );
          // Prove eligibility without retiring the hold. Later gates can still
          // decline this wake; hold retirement and successor creation stay atomic.
          // A bound chat request has already rechecked its current principal
          // above. Treat its new user message like a board comment, but keep
          // failed-run retry actions on their separate exact-request path.
          if (executionBlocker && !(await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
            dryRun: true,
            onBlocked: (reason, message) => { continuationWait = { reason, message }; },
          }))) return deferBlockedExecution(executionBlocker);


          if (
            worktreeExecutionCutoff &&
            issue.createdAt < worktreeExecutionCutoff
          ) {
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: "heartbeat.worktree_execution_cutoff",
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason: "worktree_execution_cutoff",
                  cutoff: worktreeExecutionCutoff.toISOString(),
                  issueId: issue.id,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: new Date(),
            });
            return { kind: "skipped" as const };
          }

          const cancelStaleScheduledRetry = async (
            scheduledRun: typeof heartbeatRuns.$inferSelect,
          ) => {
            const issueCancelled = issue.status === "cancelled";
            if (
              scheduledRun.status !== "scheduled_retry" ||
              (scheduledRun.agentId === issue.assigneeAgentId &&
                !issueCancelled)
            ) {
              return false;
            }

            const now = new Date();
            const reason = issueCancelled
              ? "Cancelled because the issue was cancelled before the scheduled retry became due"
              : "Cancelled because the issue was reassigned before the scheduled retry became due";
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: reason,
                errorCode: issueCancelled
                  ? "issue_cancelled"
                  : "issue_reassigned",
                updatedAt: now,
              })
              .where(
                and(
                  eq(heartbeatRuns.id, scheduledRun.id),
                  eq(heartbeatRuns.status, "scheduled_retry"),
                ),
              )
              .returning()
              .then((rows) => rows[0] ?? null);

            if (!cancelled) return false;

            if (scheduledRun.wakeupRequestId) {
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: reason,
                  updatedAt: now,
                })
                .where(
                  eq(agentWakeupRequests.id, scheduledRun.wakeupRequestId),
                );
            }

            if (issue.executionRunId === scheduledRun.id) {
              await tx
                .update(issues)
                .set({
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(issues.id, issue.id),
                    eq(issues.executionRunId, scheduledRun.id),
                  ),
                );
            }

            const eventSeq = await allocateHeartbeatRunEventSeq(
              tx as unknown as Db,
              cancelled.id,
            );

            await tx.insert(heartbeatRunEvents).values({
              companyId: cancelled.companyId,
              runId: cancelled.id,
              agentId: cancelled.agentId,
              seq: eventSeq,
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: issueCancelled
                ? "Scheduled retry cancelled because issue was cancelled before it became due"
                : "Scheduled retry cancelled because issue ownership changed before it became due",
              payload: {
                issueId: issue.id,
                issueStatus: issue.status,
                scheduledRetryAttempt: cancelled.scheduledRetryAttempt,
                scheduledRetryAt: cancelled.scheduledRetryAt
                  ? new Date(cancelled.scheduledRetryAt).toISOString()
                  : null,
                scheduledRetryReason: cancelled.scheduledRetryReason,
                previousRetryAgentId: cancelled.agentId,
                currentAssigneeAgentId: issue.assigneeAgentId,
              },
            });
            await tx
              .update(heartbeatRuns)
              .set({ nextEventSeq: eventSeq + 1, updatedAt: now })
              .where(eq(heartbeatRuns.id, cancelled.id));

            cancelledRunsToEmit.push(cancelled);

            return true;
          };

          let activeExecutionRun = issue.executionRunId
            ? await tx
                .select()
                .from(heartbeatRuns)
                .where(eq(heartbeatRuns.id, issue.executionRunId))
                .then((rows) => rows[0] ?? null)
            : null;

          if (
            activeExecutionRun &&
            !EXECUTION_PATH_HEARTBEAT_RUN_STATUSES.includes(
              activeExecutionRun.status as (typeof EXECUTION_PATH_HEARTBEAT_RUN_STATUSES)[number],
            )
          ) {
            activeExecutionRun = null;
          }

          if (
            activeExecutionRun &&
            (await cancelStaleScheduledRetry(activeExecutionRun))
          ) {
            activeExecutionRun = null;
          }

          // A queued/scheduled run holding the lock for an agent that is
          // no longer the issue's assignee is stale by design — the issue
          // has been re-routed (e.g. blocked → in_review with a different
          // assignee). Cancel it and release the lock; otherwise the new
          // assignee's wake gets parked in `deferred_issue_execution`
          // forever, because the original queued holder will never run
          // (the issue's status / target now belongs to someone else).
          //
          // Race guard: pin the cancel UPDATE to the exact non-running
          // status we read above. A worker could transition the holder
          // from `queued` → `running` between the SELECT and this UPDATE;
          // the status predicate ensures we never clobber a freshly-
          // claimed running run. If zero rows matched, leave
          // `activeExecutionRun` populated so the defer path runs
          // normally against the now-running holder.
          if (
            activeExecutionRun &&
            activeExecutionRun.status !== "running" &&
            issue.assigneeAgentId &&
            activeExecutionRun.agentId !== issue.assigneeAgentId
          ) {
            const cancelled = await tx
              .update(heartbeatRuns)
              .set({
                status: "cancelled",
                finishedAt: new Date(),
                error:
                  "Execution lock released after issue reassigned to a different agent",
                errorCode: "lock_released_on_reassignment",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(heartbeatRuns.id, activeExecutionRun.id),
                  eq(heartbeatRuns.status, activeExecutionRun.status),
                ),
              )
              .returning();
            if (cancelled.length > 0) {
              cancelledRunsToEmit.push(cancelled[0]);
              if (activeExecutionRun.wakeupRequestId) {
                await tx
                  .update(agentWakeupRequests)
                  .set({
                    status: "cancelled",
                    finishedAt: new Date(),
                    error:
                      "Execution lock released after issue reassigned to a different agent",
                    updatedAt: new Date(),
                  })
                  .where(
                    eq(
                      agentWakeupRequests.id,
                      activeExecutionRun.wakeupRequestId,
                    ),
                  );
              }
              activeExecutionRun = null;
            }
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
                  inArray(heartbeatRuns.status, [
                    ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
                  ]),
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
              if (await cancelStaleScheduledRetry(legacyRun)) {
                activeExecutionRun = null;
              } else {
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
                    executionAgentNameKey: normalizeAgentNameKey(
                      legacyAgent?.name,
                    ),
                    executionLockedAt: new Date(),
                    updatedAt: new Date(),
                  })
                  .where(eq(issues.id, issue.id));
              }
            }
          }

          const dependencyReadiness = await issuesSvc
            .listDependencyReadiness(issue.companyId, [issue.id], tx)
            .then((rows) => rows.get(issue.id) ?? null);

          // Blocked descendants should stay idle until the final blocker resolves.
          // Human comment/mention wakes are the exception: they may run in a
          // bounded interaction mode so the assignee can answer or triage.
          const blockedInteractionWake =
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            allowsIssueInteractionWake(
              enrichedContextSnapshot,
              ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS,
            );

          if (blockedInteractionWake) {
            enrichedContextSnapshot.dependencyBlockedInteraction = true;
            enrichedContextSnapshot.unresolvedBlockerIssueIds =
              dependencyReadiness.unresolvedBlockerIssueIds;
            enrichedContextSnapshot.unresolvedBlockerCount =
              dependencyReadiness.unresolvedBlockerCount;
            enrichedContextSnapshot.unresolvedBlockerSummaries =
              await listUnresolvedBlockerSummaries(
                tx,
                issue.companyId,
                issue.id,
                dependencyReadiness.unresolvedBlockerIssueIds,
              );
          }

          if (
            !activeExecutionRun &&
            dependencyReadiness &&
            !dependencyReadiness.isDependencyReady &&
            !blockedInteractionWake
          ) {
            await recordExecutionWait(tx as unknown as Db, {
              issueId: issue.id,
              coalesce: coalesceExecutionWait,
              condition: { unresolvedBlockerIssueIds: [...dependencyReadiness.unresolvedBlockerIssueIds].sort() },
              request: {
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: "issue_dependencies_blocked",
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  unresolvedBlockerIssueIds:
                    dependencyReadiness.unresolvedBlockerIssueIds,
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: new Date(),
              },
            });
            return { kind: "skipped" as const };
          }

          if (
            isolatedWorkspacesEnabled &&
            !activeExecutionRun &&
            issue.status !== "done" &&
            issue.status !== "cancelled"
          ) {
            const issueSettings = parseIssueExecutionWorkspaceSettings(
              issue.executionWorkspaceSettings,
            );
            const resolvedMode = resolveExecutionWorkspaceMode({
              projectPolicy: null,
              issueSettings,
              legacyUseProjectWorkspace: null,
            });
            const workspaceManagedConfig = buildExecutionWorkspaceAdapterConfig(
              {
                agentConfig: parseObject(agent.adapterConfig),
                projectPolicy: null,
                issueSettings,
                mode: resolvedMode,
                legacyUseProjectWorkspace: null,
              },
            );
            const resolvedStrategy = resolveEffectiveWorkspaceStrategyType(
              resolvedMode,
              workspaceManagedConfig,
            );
            const existingExecutionWorkspaceStatus = issue.executionWorkspaceId
              ? await tx
                  .select({ status: executionWorkspaces.status })
                  .from(executionWorkspaces)
                  .where(
                    and(
                      eq(executionWorkspaces.id, issue.executionWorkspaceId),
                      eq(executionWorkspaces.companyId, issue.companyId),
                    ),
                  )
                  .then((rows) => rows[0]?.status ?? null)
              : null;
            const reuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
              issueExecutionWorkspaceId: issue.executionWorkspaceId,
              issueExecutionWorkspacePreference:
                issue.executionWorkspacePreference,
              existingExecutionWorkspaceStatus,
            });
            const hasResolvablePriorSessionWorkspace =
              await resolveHasResolvablePriorSessionWorkspace();

            if (
              isUnrunnableWorktreeCombo({
                issue: {
                  projectId: issue.projectId ?? projectId ?? null,
                  projectWorkspaceId: issue.projectWorkspaceId,
                  executionWorkspaceId: issue.executionWorkspaceId,
                  executionWorkspacePreference:
                    issue.executionWorkspacePreference,
                },
                resolvedMode,
                resolvedStrategy,
                reusableExecutionWorkspaceAvailable:
                  reuseRequest.existingExecutionWorkspaceAvailable,
                hasResolvablePriorSessionWorkspace,
              })
            ) {
              const now = new Date();
              const issueLabel = formatIssueIdentifierLink(
                issue.identifier,
                issue.id,
              );
              const blockedComment = [
                `Paperclip blocked ${issueLabel} before dispatch because its workspace settings are not runnable.`,
                "",
                `- Code: \`${WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE}\``,
                `- Reason: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE}`,
                `- Next action: ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`,
              ].join("\n");
              await tx
                .update(issues)
                .set({
                  status: "blocked",
                  checkoutRunId: null,
                  executionRunId: null,
                  executionAgentNameKey: null,
                  executionLockedAt: null,
                  updatedAt: now,
                })
                .where(eq(issues.id, issue.id));
              await tx.insert(issueComments).values({
                companyId: issue.companyId,
                issueId: issue.id,
                body: blockedComment,
                createdAt: now,
                updatedAt: now,
              });
              await tx.insert(agentWakeupRequests).values({
                ...durableReceiptFields,
                companyId: agent.companyId,
                agentId,
                source,
                triggerDetail,
                reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                payload: {
                  ...(payload ?? {}),
                  issueId,
                  heartbeatSkip: {
                    code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                    reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                    remediation:
                      WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  },
                },
                status: "skipped",
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: now,
              });
              await logActivity(tx as unknown as Db, {
                companyId: issue.companyId,
                actorType: "system",
                actorId: "system",
                agentId,
                runId: null,
                action: "issue.workspace_preflight_blocked",
                entityType: "issue",
                entityId: issue.id,
                details: {
                  code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
                  reason: WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
                  remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
                  requestedReason: reason,
                  source,
                  triggerDetail,
                  resolvedMode,
                  resolvedStrategy,
                  hasResolvablePriorSessionWorkspace,
                },
              });
              return { kind: "skipped" as const };
            }
          }

          if (activeExecutionRun) {
            // The resolved action is already a durable retry outbox. Do not merge
            // its fresh-session contract into unrelated work or create a second
            // deferred wake that could later replay the same reconciliation.
            if (reconciledSourceRunId) return { kind: "deferred" as const };

            // Offer the input to the active Dot, but keep a durable queued wake
            // until it reads the comment. A finish racing the event tick must
            // leave unread input available for the next assignment.
            const dotBindingId = readNonEmptyString(parseObject(agent.adapterConfig).dotBindingId);
            const dotFollowUp = agent.adapterType === "paperclip_runner" && parseObject(agent.adapterConfig).provider === "openai_dot"
                && dotBindingId && activeExecutionRun.agentId === agentId && issue.assigneeAgentId === agentId
                && reason === "issue_commented" && wakeCommentId && opts.allowRunCoalescing !== false
                && enrichedContextSnapshot.forceFreshSession !== true && !explicitResumeSession && !opts.manualUserWake
                && !enrichedContextSnapshot.interactionId && !payload?.interactionId && !receiptRequest
                ? await publishActiveDotComment(tx as unknown as Db, { companyId: agent.companyId, agentId,
                  bindingId: dotBindingId, runId: activeExecutionRun.id, issueId: issue.id, commentId: wakeCommentId }) : false;
            if (dotFollowUp) {
              const [pending] = dotFollowUp.consumed ? [] : await tx.select().from(agentWakeupRequests).where(and(
                eq(agentWakeupRequests.companyId, agent.companyId), eq(agentWakeupRequests.agentId, agentId),
                isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`${agentWakeupRequests.payload}->>'dotAssignmentFollowUp' = ${dotFollowUp.assignmentId}`,
                opts.requestedByActorType ? eq(agentWakeupRequests.requestedByActorType, opts.requestedByActorType) : isNull(agentWakeupRequests.requestedByActorType),
                opts.requestedByActorId ? eq(agentWakeupRequests.requestedByActorId, opts.requestedByActorId) : isNull(agentWakeupRequests.requestedByActorId),
              )).for("update").limit(1);
              if (pending) await tx.update(agentWakeupRequests).set({
                payload: withQueuedCommentIdsInWakePayload(pending.payload,
                  [...new Set([...queuedCommentIdsFromWakePayload(pending.payload), wakeCommentId!])]),
                coalescedCount: pending.coalescedCount + 1, updatedAt: new Date(),
              }).where(and(eq(agentWakeupRequests.id, pending.id), eq(agentWakeupRequests.companyId, agent.companyId),
                eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
              else await tx.insert(agentWakeupRequests).values({ companyId: agent.companyId, agentId, source, triggerDetail,
                reason, payload: withQueuedCommentIdsInWakePayload({ ...payload, issueId: issue.id,
                  dotAssignmentFollowUp: dotFollowUp.assignmentId,
                  [DEFERRED_WAKE_CONTEXT_KEY]: enrichedContextSnapshot }, [wakeCommentId!]),
                status: dotFollowUp.consumed ? "coalesced" : "deferred_issue_execution",
                runId: dotFollowUp.consumed ? activeExecutionRun.id : null,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null, idempotencyKey: opts.idempotencyKey ?? null,
                finishedAt: dotFollowUp.consumed ? new Date() : null });
              return { kind: "coalesced" as const, run: activeExecutionRun };
            }

            const admissionScope = wakeQueue.createAdmissionTransactionScope(
              agent.companyId,
              tx as unknown as Db,
            );
            const admission = await wakeQueue.admitWakeBehindIssueExecution(
              admissionScope,
              {
                companyId: agent.companyId,
                issueId: issue.id,
                agentId,
                agentNameKey,
                issueExecutionAgentNameKey: issue.executionAgentNameKey,
                activeExecutionRun: {
                  id: activeExecutionRun.id,
                  agentId: activeExecutionRun.agentId,
                  status: activeExecutionRun.status,
                  contextSnapshot: activeExecutionRun.contextSnapshot,
                  wakeupRequestId: activeExecutionRun.wakeupRequestId,
                },
                allowRunCoalescing: isConversation(issue) ? false : opts.allowRunCoalescing,
                durableReceipt: receiptRequest
                  ? {
                      id: receiptRequest.id,
                      requestedAt: receiptRequest.requestedAt,
                    }
                  : undefined,
                reason,
                liveRunExecutions,
                wakeCommentId,
                forceFreshSession:
                  enrichedContextSnapshot.forceFreshSession === true,
                contextSnapshot: enrichedContextSnapshot,
                source,
                triggerDetail,
                payload,
                requestedByActorType: opts.requestedByActorType ?? null,
                requestedByActorId: opts.requestedByActorId ?? null,
                idempotencyKey: opts.idempotencyKey ?? null,
              },
            );

            if (admission.kind === "coalesced") {
              return {
                kind: "coalesced" as const,
                run: admission.run as typeof heartbeatRuns.$inferSelect,
              };
            }
            if (admission.kind === "deferred") {
              return { kind: "deferred" as const };
            }
            // admission.kind === "proceed": no active run absorbed this wake,
            // so fall through to the ordinary queue path below.
          }

          // PAP-13775: no live run holds the lock, so this wake would start a
          // fresh adapter session. If this agent's recent runs on this issue
          // keep succeeding without any issue-visible progress and the wake
          // carries no new information, hold it back for an escalating cooldown
          // so external pollers/reconcilers can't storm full-price sessions.
          // Server-side recovery retries insert runs directly and never reach
          // this gate.
          if (
            isThrottleCandidateIssueRewake({
              reason,
              wakeCommentId: wakeCommentId ?? null,
              requestedByActorType: opts.requestedByActorType ?? null,
              forceFreshSession:
                enrichedContextSnapshot.forceFreshSession === true,
              hasExplicitResume: Boolean(explicitResumeSession),
            })
          ) {
            const throttleNow = new Date();
            const recentTerminalRuns = await tx
              .select({
                id: heartbeatRuns.id,
                status: heartbeatRuns.status,
                finishedAt: heartbeatRuns.finishedAt,
              })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, agent.companyId),
                  eq(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.finishedAt} is not null`,
                  gte(
                    heartbeatRuns.finishedAt,
                    new Date(throttleNow.getTime() - ISSUE_REWAKE_LOOKBACK_MS),
                  ),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
                ),
              )
              .orderBy(desc(heartbeatRuns.finishedAt))
              .limit(ISSUE_REWAKE_RUN_SAMPLE_LIMIT);

            if (recentTerminalRuns.length > 0) {
              const sampleRunIds = recentTerminalRuns.map(
                (sampleRun) => sampleRun.id,
              );
              const progressRows = await tx
                .select({ runId: activityLog.runId, action: activityLog.action, details: activityLog.details })
                .from(activityLog)
                .where(
                  and(
                    eq(activityLog.companyId, agent.companyId),
                    eq(activityLog.entityType, "issue"),
                    eq(activityLog.entityId, issue.id),
                    inArray(activityLog.runId, sampleRunIds),
                    inArray(
                      activityLog.action,
                      ISSUE_PROGRESS_ACTIVITY_ACTIONS,
                    ),
                  ),
                );
              const lastRunFinishedAt =
                recentTerminalRuns[0]?.finishedAt ?? null;
              const newInputRows = lastRunFinishedAt
                ? await tx
                    .select({ id: activityLog.id })
                    .from(activityLog)
                    .where(
                      and(
                        eq(activityLog.companyId, agent.companyId),
                        eq(activityLog.entityType, "issue"),
                        eq(activityLog.entityId, issue.id),
                        gt(activityLog.createdAt, lastRunFinishedAt),
                        sql`coalesce(${activityLog.details}->>'origin', '') <> 'fast_response'`,
                        inArray(
                          activityLog.action,
                          ISSUE_NEW_INPUT_ACTIVITY_ACTIONS,
                        ),
                        // A run's materialized final answer can arrive after
                        // finishedAt. It is not new issue input by itself.
                        sql`not (${activityLog.action} = 'issue.comment_added' and (
                          coalesce(${activityLog.details} ->> 'completionReply' = 'true', false) or
                          coalesce(${activityLog.details} ->> 'source' = 'run_presentation_resolver', false)
                        ))`,
                        wakeCommentId && opts.requestedByActorType === "agent"
                          ? ne(activityLog.actorType, "agent")
                          : undefined,
                      ),
                    )
                    .limit(1)
                : [];

              const throttleDecision = evaluateIssueRewakeThrottle({
                now: throttleNow,
                recentTerminalRuns,
                runIdsWithIssueProgress: new Set(
                  progressRows
                    .filter((row) => row.action !== "issue.comment_added" || !isRoutineRunCompletionComment(row.details))
                    .map((row) => row.runId)
                    .filter((runId): runId is string => Boolean(runId)),
                ),
                // For an agent comment wake, the query excludes agent-authored
                // activity while preserving genuinely new user/system input.
                // Presentation/author metadata therefore cannot smuggle human
                // wake privilege, nor can it mask an actual human response.
                hasNewIssueInputSinceLastRun: newInputRows.length > 0,
              });

              if (throttleDecision.blocked) {
                await tx.insert(agentWakeupRequests).values({
                  ...durableReceiptFields,
                  companyId: agent.companyId,
                  agentId,
                  source,
                  triggerDetail,
                  reason: "issue_rewake_throttled",
                  payload: {
                    ...(payload ?? {}),
                    issueId,
                    heartbeatSkip: {
                      reason: "issue_rewake_throttled",
                      requestedReason: reason,
                      noProgressStreak: throttleDecision.noProgressStreak,
                      cooldownMs: throttleDecision.cooldownMs,
                      lastRunFinishedAt:
                        throttleDecision.lastRunFinishedAt.toISOString(),
                      nextAllowedAt:
                        throttleDecision.nextAllowedAt.toISOString(),
                    },
                  },
                  status: "skipped",
                  requestedByActorType: opts.requestedByActorType ?? null,
                  requestedByActorId: opts.requestedByActorId ?? null,
                  idempotencyKey: opts.idempotencyKey ?? null,
                  finishedAt: throttleNow,
                });
                return { kind: "skipped" as const };
              }
            }
          }

          const dailyCapBlock = await getHeartbeatDailyCapBlock(
            agent,
            policy,
            {},
            tx,
          );
          if (dailyCapBlock) {
            if (executionWaitRequestId && executionBlocker) {
              continuationWait = { reason: dailyCapBlock.reason,
                message: "The agent has reached its daily limit. Your message is saved until work can resume." };
              return deferBlockedExecution(executionBlocker);
            }
            const now = new Date();
            await tx.insert(agentWakeupRequests).values({
              ...durableReceiptFields,
              companyId: agent.companyId,
              agentId,
              source,
              triggerDetail,
              reason: dailyCapBlock.reason,
              payload: {
                ...(payload ?? {}),
                heartbeatSkip: {
                  reason:
                    "Per-agent heartbeat daily cap reached before adapter invocation.",
                  observed: dailyCapBlock.observed,
                  limit: dailyCapBlock.limit,
                },
              },
              status: "skipped",
              requestedByActorType: opts.requestedByActorType ?? null,
              requestedByActorId: opts.requestedByActorId ?? null,
              idempotencyKey: opts.idempotencyKey ?? null,
              finishedAt: now,
            });
            if (source === "timer") {
              await tx
                .update(agents)
                .set({
                  lastHeartbeatAt: now,
                  updatedAt: now,
                })
                .where(eq(agents.id, agentId));
            }
            return { kind: "skipped" as const };
          }

          const explicitContinuation = await admitExplicitNativeContinuation({
            db: tx as unknown as Db, companyId: issue.companyId, issueId: issue.id,
            agentId, actorType: opts.requestedByActorType, actorId: opts.requestedByActorId,
            reason: durableRequest && !failedChatRetry ? "issue_commented" : reason,
            commentId: wakeCommentId ?? null, failedRunId: opts.failedRunId, successorRunId: explicitContinuationRunId,
            queuedCommentInterruptId: opts.queuedCommentInterruptId,
            queuedCommentRequestId: opts.queuedCommentRequestId,
          });
          if (!explicitContinuation && executionBlocker) return deferBlockedExecution(executionBlocker);
          if (explicitContinuation) {
            enrichedContextSnapshot.forceFreshSession = true;
            enrichedContextSnapshot.previousRunId = explicitContinuation.previousRunId;
            enrichedContextSnapshot.explicitUserContinuation = explicitContinuation;
          }

          const wakeupRequest = await tx
            .insert(agentWakeupRequests)
            .values({
              ...durableReceiptFields,
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

          // A handoff changes the executor, not the owner of saved user input.
          // Validate its exact stopped source while the issue row is locked;
          // unrelated agents and dedicated continuations keep their own wakes.
          const interruptedRunId = readNonEmptyString(enrichedContextSnapshot.interruptedRunId);
          const handoffSource = source === "assignment" && reason === "issue_assigned" &&
            issue.assigneeAgentId === agentId && interruptedRunId && isUuidLike(interruptedRunId)
              ? await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
                  eq(heartbeatRuns.id, interruptedRunId), eq(heartbeatRuns.companyId, issue.companyId),
                  eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.errorCode, "issue_reassigned"),
                  ne(heartbeatRuns.agentId, agentId),
                  sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`,
                  or(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.nativeIssueId, issue.id)),
                )).then(rows => rows[0] ?? null)
              : null;
          const canCoalesceComments = !isConversation(issue) && opts.allowRunCoalescing !== false;
          // A resumed receipt already passed admission under this issue lock.
          // Consume it with its successor even when chat keeps other messages
          // in separate turns, or finalization will deliver it a second time.
          const pendingComments =
            (executionWaitRequestId || canCoalesceComments) &&
            !(await getExecutionBlocker(tx as unknown as Db, issue.companyId, issue.id))
              ? await tx
                  .select()
                  .from(agentWakeupRequests)
                  .where(
                    and(
                      eq(agentWakeupRequests.companyId, issue.companyId),
                      inArray(agentWakeupRequests.agentId, handoffSource ? [agentId, handoffSource.agentId] : [agentId]),
                      eq(agentWakeupRequests.status, "deferred_issue_execution"),
                      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
                      canCoalesceComments ? undefined : eq(agentWakeupRequests.id, executionWaitRequestId!),
                    ),
                  )
                  .orderBy(asc(agentWakeupRequests.requestedAt))
              : [];
          const adoptedComments = pendingComments.filter((wake) => {
            if (wake.id === executionWaitRequestId) return true;
            if (wake.id === opts.queuedCommentInterruptId || wake.id === opts.queuedCommentRequestId) return true;
            const deferredPayload = parseObject(wake.payload);
            const deferredContext = parseObject(
              deferredPayload[DEFERRED_WAKE_CONTEXT_KEY],
            );
            // Dedicated interaction wakes carry their own source and session
            // contract. ID-only adoption must not erase that continuation.
            return (
              // Durable chat work must keep its receipt, actor, source, and
              // session contract through normal promotion and authorization.
              !wake.idempotencyKey?.startsWith("chat-inbound:") &&
              !isInteractionResolutionWakePayload(deferredPayload) &&
              !hasInteractionContinuationWakeContext(deferredContext) &&
              ["issue_commented", "issue_reopened_via_comment"].includes(String(deferredContext.wakeReason ?? wake.reason)) &&
              queuedCommentIdsFromWakePayload(wake.payload).length > 0
            );
          });
          let adoptedCommentIds = [
            ...new Set([
              ...adoptedComments.flatMap((wake) =>
                queuedCommentIdsFromWakePayload(wake.payload),
              ),
              ...queuedCommentIdsFromRunContext(enrichedContextSnapshot),
            ]),
          ];
          if (opts.queuedCommentRequestId || handoffSource) {
            adoptedCommentIds = await undeliveredLegacyUserCommentIds(tx as unknown as Db,
              agent.companyId, issueId, agentId, adoptedCommentIds);
          }
          const newRun = await tx
            .insert(heartbeatRuns)
            .values({
              ...(explicitContinuation ? { id: explicitContinuationRunId } : {}),
              companyId: agent.companyId,
              agentId,
            scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
            issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
              invocationSource: source,
              triggerDetail,
              status: "queued",
              responsibleUserId: await resolveQueuedResponsibleUserId(),
              wakeupRequestId: wakeupRequest.id,
              retryOfRunId: failedChatRetry
                ? durableRequest!.failedRunRetry!.failedRunId
                : opts.failedRunId ?? automaticParentRunId,
              contextSnapshot: adoptedComments.length
                ? withQueuedCommentIdsInRunContext(
                    enrichedContextSnapshot,
                    adoptedCommentIds,
                  )
                : enrichedContextSnapshot,
              sessionIdBefore: explicitContinuation ? null : sessionBefore,
              continuationAttempt,
              ...(reconciledSourceRunId
                ? { retryOfRunId: reconciledSourceRunId }
                : {}),
              ...(reconciledRestoreRetryCount !== null ? {
                scheduledRetryAttempt: reconciledRestoreRetryCount,
                scheduledRetryReason: "transient_failure",
              } : {}),
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

          if (adoptedComments.length) {
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "coalesced",
                runId: newRun.id,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                inArray(
                  agentWakeupRequests.id,
                  adoptedComments.map((wake) => wake.id),
                ),
              );
            await tx
              .update(agentWakeupRequests)
              .set({
                payload: withQueuedCommentIdsInWakePayload(payload, adoptedCommentIds),
              })
              .where(eq(agentWakeupRequests.id, wakeupRequest.id));
          }

          // executionRunId is NOT stamped here (enqueueWakeup queues the run but
          // doesn't start it). It will be stamped in claimQueuedRun() once the run
          // transitions to "running" — Fix A (lazy locking).

          return { kind: "queued" as const, run: newRun };
        })
        .catch((error) => {
          if (isExternalChatWaitAuthorizationContention(error))
            return { kind: "deferred" as const };
          throw error;
        });

      // Telemetry for the cancelled runs is best-effort background work.
      // Fire it here and never await it: none of the lifecycle work below,
      // nor this function's return, depends on it, so a slow telemetry
      // lookup must not delay them.
      for (const cancelledRun of cancelledRunsToEmit) {
        void emitAgentTaskRun(db, cancelledRun);
      }

      if (outcome.kind === "durable") {
        return outcome.receipt.runId ? getRun(outcome.receipt.runId) : null;
      }
      if (outcome.kind === "deferred" || outcome.kind === "skipped") {
        return null;
      }
      if (outcome.kind === "coalesced") {
        await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }
      if (outcome.kind === "replayed") {
        if (outcome.run.status === "queued")
          await startNextQueuedRunForAgent(agent.id);
        return outcome.run;
      }

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

    if (durableRequest) throw new Error("chat_inbound_wakeup_binding_denied");

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, [
            ...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES,
          ]),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    const sameScopeQueuedRun = activeRuns.find(
      (candidate) =>
        candidate.status === "queued" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeScheduledRetryRun = activeRuns.find(
      (candidate) =>
        candidate.status === "scheduled_retry" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const sameScopeRunningRun = activeRuns.find(
      (candidate) =>
        candidate.status === "running" &&
        isSameTaskScope(runTaskKey(candidate), taskKey),
    );
    const shouldQueueFollowupForRunningWake =
      Boolean(sameScopeRunningRun) &&
      !sameScopeQueuedRun &&
      shouldQueueFollowupForRunningIssueWake({
        contextSnapshot: enrichedContextSnapshot,
        wakeCommentId,
      });
    // Unscoped manual wakes need their own receipt and execution identity too.
    const rawCoalescedTarget =
      opts.allowRunCoalescing === false || opts.manualUserWake
        ? null
        : (sameScopeQueuedRun ??
          sameScopeScheduledRetryRun ??
          (shouldQueueFollowupForRunningWake
            ? null
            : (sameScopeRunningRun ?? null)));

    const coalescedTargetRun = filterZombieCoalesceTarget(
      rawCoalescedTarget,
      liveRunExecutions,
    );

    if (coalescedTargetRun) {
      const mergedContextSnapshot = mergeCoalescedContextSnapshot(
        coalescedTargetRun.contextSnapshot,
        enrichedContextSnapshot,
        {
          preserveExistingInteractionContinuation:
            coalescedTargetRun.status === "queued" ||
            coalescedTargetRun.status === "scheduled_retry",
        },
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
        ...durableReceiptFields,
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

    const queueOutcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from agents where id = ${agentId} and company_id = ${agent.companyId} for update`,
      );

      const dailyCapBlock = await getHeartbeatDailyCapBlock(
        agent,
        policy,
        {},
        tx,
      );
      if (dailyCapBlock) {
        const now = new Date();
        await tx.insert(agentWakeupRequests).values({
          ...durableReceiptFields,
          companyId: agent.companyId,
          agentId,
          source,
          triggerDetail,
          reason: dailyCapBlock.reason,
          payload: {
            ...(payload ?? {}),
            heartbeatSkip: {
              reason:
                "Per-agent heartbeat daily cap reached before adapter invocation.",
              observed: dailyCapBlock.observed,
              limit: dailyCapBlock.limit,
            },
          },
          status: "skipped",
          requestedByActorType: opts.requestedByActorType ?? null,
          requestedByActorId: opts.requestedByActorId ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
          finishedAt: now,
        });
        if (source === "timer") {
          await tx
            .update(agents)
            .set({
              lastHeartbeatAt: now,
              updatedAt: now,
            })
            .where(eq(agents.id, agentId));
        }
        return { kind: "skipped" as const };
      }

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          ...durableReceiptFields,
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
          scopeKind: readNonEmptyString(enrichedContextSnapshot.issueId) ? "issue" : "company",
          issueId: readNonEmptyString(enrichedContextSnapshot.issueId),
          invocationSource: source,
          triggerDetail,
          status: "queued",
          responsibleUserId: await resolveQueuedResponsibleUserId(),
          wakeupRequestId: wakeupRequest.id,
          contextSnapshot: enrichedContextSnapshot,
          sessionIdBefore: sessionBefore,
          continuationAttempt,
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

      return { kind: "queued" as const, run: newRun };
    });

    if (queueOutcome.kind === "skipped") return null;
    const newRun = queueOutcome.run;

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

  /**
   * Native status commitment deliberately persists dependency/parent wake
   * intents in the same transaction as the authoritative status projection.
   * Those rows are not runnable until the heartbeat scheduler has applied its
   * normal policy, workspace, concurrency, and responsible-user checks. Bridge
   * the durable intent into that scheduler here instead of treating a bare
   * `agent_wakeup_requests` row as if it were already a queued heartbeat run.
   *
   * The intent is claimed before dispatch. A deterministic dispatcher actor id
   * lets a later sweep recover the narrow process-crash window after the real
   * wake was inserted but before the intent was linked to it. Dispatch failure
   * only requeues the intent; it never changes the provider run outcome.
   */
  async function dispatchPendingNativeStatusWakeups(
    input: {
      companyId?: string;
      limit?: number;
      staleClaimMs?: number;
    } = {},
  ) {
    const now = new Date();
    const staleClaimMs = Math.max(1_000, input.staleClaimMs ?? 60_000);
    const candidates = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          input.companyId
            ? eq(agentWakeupRequests.companyId, input.companyId)
            : undefined,
          eq(agentWakeupRequests.requestedByActorType, "system"),
          eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
          inArray(agentWakeupRequests.status, ["queued", "claimed"]),
          isNull(agentWakeupRequests.runId),
        ),
      )
      .orderBy(asc(agentWakeupRequests.requestedAt))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

    let dispatched = 0;
    let recovered = 0;
    let deferred = 0;
    const deliveredByIssueScope = new Map<
      string,
      { runId: string | null; status: string }
    >();

    for (const candidate of candidates) {
      const dispatchActorId = `native-status-wake-dispatch:${candidate.id}`;
      const existingDispatch = await db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, candidate.companyId),
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existingDispatch) {
        const recoveredStatus = existingDispatch.runId
          ? "coalesced"
          : existingDispatch.status === "deferred_issue_execution"
            ? "coalesced"
            : existingDispatch.status;
        await db
          .update(agentWakeupRequests)
          .set({
            status: recoveredStatus,
            runId: existingDispatch.runId,
            finishedAt:
              (existingDispatch.runId ?? existingDispatch.finishedAt)
                ? (existingDispatch.finishedAt ?? now)
                : null,
            error: existingDispatch.error,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              isNull(agentWakeupRequests.runId),
            ),
          );
        recovered += 1;
        continue;
      }

      if (
        candidate.status === "claimed" &&
        candidate.claimedAt &&
        now.getTime() - candidate.claimedAt.getTime() < staleClaimMs
      ) {
        deferred += 1;
        continue;
      }

      const claimed = await db
        .update(agentWakeupRequests)
        .set({
          status: "claimed",
          claimedAt: now,
          error: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, candidate.id),
            isNull(agentWakeupRequests.runId),
            candidate.status === "claimed"
              ? eq(agentWakeupRequests.status, "claimed")
              : eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .returning({ id: agentWakeupRequests.id });
      if (claimed.length === 0) continue;

      const payload = parseObject(candidate.payload);
      const wakeContext = parseObject(payload._paperclipWakeContext);
      const issueId =
        readNonEmptyString(payload.issueId) ??
        readNonEmptyString(payload.taskId) ??
        readNonEmptyString(wakeContext.issueId) ??
        null;
      const scopeKey = issueId
        ? `${candidate.companyId}:${candidate.agentId}:${issueId}:${readNativeReviewAssignmentContext(wakeContext)?.nativeReviewInteractionId ?? ""}`
        : null;
      const priorDelivery = scopeKey
        ? deliveredByIssueScope.get(scopeKey)
        : null;
      if (priorDelivery) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "coalesced",
            runId: priorDelivery.runId,
            finishedAt: new Date(),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));
        recovered += 1;
        continue;
      }

      let completedOnboardingGuard: WakeupOptions["issueStateGuard"];
      if (issueId) {
        const targetIssue = await db
          .select({
            status: issues.status,
            statusVersion: issues.statusVersion,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(
            and(
              eq(issues.id, issueId),
              eq(issues.companyId, candidate.companyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const nativeReview = candidate.reason === "native_completion_review"
          ? await getNativeReviewAssignment(db, {
              companyId: candidate.companyId, issueId, agentId: candidate.agentId,
              contextSnapshot: wakeContext,
            })
          : null;
        const onboardingResultReport = targetIssue?.status === "done" && await isCompletedOnboardingHandoffWake(db, {
          companyId: candidate.companyId, issueId, agentId: candidate.agentId,
          reason: candidate.reason, contextSnapshot: wakeContext,
        });
        if (onboardingResultReport) completedOnboardingGuard = { assigneeAgentId: candidate.agentId, statuses: ["done"], statusVersion: targetIssue!.statusVersion };
        if (
          !targetIssue ||
          (["done", "cancelled"].includes(targetIssue.status) && !onboardingResultReport) ||
          (targetIssue.assigneeAgentId !== candidate.agentId && !nativeReview) ||
          (candidate.reason === "native_completion_review" && !nativeReview)
        ) {
          await db
            .update(agentWakeupRequests)
            .set({
              status: "skipped",
              finishedAt: new Date(),
              error: !targetIssue
                ? "Native status wake target no longer exists"
                : ["done", "cancelled"].includes(targetIssue.status)
                  ? `Native status wake target is already ${targetIssue.status}`
                  : "Native status wake target has a different assignee",
              updatedAt: new Date(),
            })
            .where(eq(agentWakeupRequests.id, candidate.id));
          recovered += 1;
          continue;
        }
      }

      try {
        const wakeRun = await enqueueWakeup(candidate.agentId, {
          source: candidate.source as WakeupOptions["source"],
          triggerDetail: (candidate.triggerDetail ??
            "system") as WakeupOptions["triggerDetail"],
          reason: candidate.reason,
          payload,
          idempotencyKey: candidate.idempotencyKey,
          requestedByActorType: "system",
          requestedByActorId: dispatchActorId,
          ...(completedOnboardingGuard ? { issueStateGuard: completedOnboardingGuard } : {}),
          contextSnapshot: {
            ...wakeContext,
            ...(issueId ? { issueId, taskId: issueId } : {}),
            wakeReason: candidate.reason,
            source: "native_status_decision",
            statusDecisionSource: "native_status_decision",
            nativeStatusWakeIntentId: candidate.id,
          },
        });

        const delivered = await db
          .select()
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, candidate.companyId),
              eq(agentWakeupRequests.requestedByActorType, "system"),
              eq(agentWakeupRequests.requestedByActorId, dispatchActorId),
            ),
          )
          .orderBy(desc(agentWakeupRequests.requestedAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);

        // The committer intent is the durable outbox entry. When admission is
        // blocked, enqueueWakeup creates a separate deferred dispatch receipt;
        // leave the original intent coalesced so the release drain cannot
        // promote both rows (the original has no nativeStatusWakeIntentId
        // provenance and would otherwise run once before the dispatch receipt).
        const deliveredStatus = delivered?.status ?? "queued";
        await db
          .update(agentWakeupRequests)
          .set({
            status: wakeRun || deliveredStatus === "deferred_issue_execution"
              ? "coalesced"
              : deliveredStatus,
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            finishedAt:
              wakeRun || delivered?.finishedAt
                ? (delivered?.finishedAt ?? new Date())
                : null,
            error: delivered?.error ?? null,
            updatedAt: new Date(),
          })
          .where(eq(agentWakeupRequests.id, candidate.id));

        if (scopeKey) {
          deliveredByIssueScope.set(scopeKey, {
            runId: wakeRun?.id ?? delivered?.runId ?? null,
            status: wakeRun ? "coalesced" : (delivered?.status ?? "queued"),
          });
        }

        if (wakeRun) dispatched += 1;
        else deferred += 1;
      } catch (error) {
        await db
          .update(agentWakeupRequests)
          .set({
            status: "queued",
            claimedAt: null,
            error:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : String(error).slice(0, 1_000),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentWakeupRequests.id, candidate.id),
              eq(agentWakeupRequests.status, "claimed"),
              isNull(agentWakeupRequests.runId),
            ),
          );
        logger.warn(
          {
            err: error,
            wakeupRequestId: candidate.id,
            agentId: candidate.agentId,
          },
          "failed to dispatch persisted native status wake intent",
        );
        deferred += 1;
      }
    }

    return { scanned: candidates.length, dispatched, recovered, deferred };
  }

  return {
    enqueueWakeup,
    dispatchPendingNativeStatusWakeups,
    startNextQueuedRunForAgent,
    countRunningRunsForAgent,
    releaseRunClaimedJustBeforeSuppression,
    claimQueuedRun,
    withChatControlRecoveryGate,
    trackWakeup,
    resumeQueuedRuns,
    parseHeartbeatPolicy,
    claimDueTimerHeartbeat,
  };
}
