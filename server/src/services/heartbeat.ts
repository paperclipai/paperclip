import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { buildAgentMentionHref, type BillingType, type ExecutionWorkspace, type ExecutionWorkspaceConfig } from "@paperclipai/shared";
import {
  agents,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  companies,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { HttpError, conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";
import { getRunLogStore, type RunLogHandle } from "./run-log-store.js";
import { getServerAdapter, runningProcesses } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterInvocationMeta, AdapterSessionCodec, UsageSummary } from "../adapters/index.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { parseObject, asBoolean, asNumber, appendWithCap, MAX_EXCERPT_BYTES } from "../adapters/utils.js";
import { costService } from "./costs.js";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { companySkillService } from "./company-skills.js";
import { budgetService, type BudgetEnforcementScope } from "./budgets.js";
import { secretService } from "./secrets.js";
import { resolveDefaultAgentWorkspaceDir, resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { buildHeartbeatRunIssueComment, summarizeHeartbeatRunResultJson } from "./heartbeat-run-summary.js";
import {
  buildWorkspaceReadyComment,
  cleanupExecutionWorkspaceArtifacts,
  ensureRuntimeServicesForRun,
  persistAdapterManagedRuntimeServices,
  realizeExecutionWorkspace,
  releaseRuntimeServicesForRun,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
  sanitizeRuntimeServiceBaseEnv,
} from "./workspace-runtime.js";
import { issueService } from "./issues.js";
import { executionWorkspaceService, mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
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
import { redactCurrentUserText, redactCurrentUserValue } from "../log-redaction.js";
import {
  isOrchestratorOnlyAgent,
  hasSessionCompactionThresholds,
  resolveSessionCompactionPolicy,
  type SessionCompactionPolicy,
} from "@paperclipai/adapter-utils";

const MAX_LIVE_LOG_CHUNK_BYTES = 8 * 1024;
const HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT = 1;
const HEARTBEAT_MAX_CONCURRENT_RUNS_MAX = 10;
const HEARTBEAT_MAX_LIVE_RUNS_DEFAULT = 5;
const HEARTBEAT_MAX_LIVE_RUNS_MAX = 100;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const WAKE_COMMENT_IDS_KEY = "wakeCommentIds";
const PAPERCLIP_WAKE_PAYLOAD_KEY = "paperclipWake";
const DETACHED_PROCESS_ERROR_CODE = "process_detached";
const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"] as const;
const ACTIVE_ASSIGNEE_HEARTBEAT_RUN_STATUSES = ["running"] as const;
const HEARTBEAT_QUEUE_START_LOCK_WATCHDOG_MS = 30 * 1000;
const WATCHDOG_RECOVERY_COOLDOWN_HOURS = 12;
const WATCHDOG_RECOVERY_REPEAT_THRESHOLD = 1;
const OPEN_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const READY_UNASSIGNED_STATUSES = ["backlog", "todo"] as const;
const OPERATIONS_IDLE_WAKE_MARKER = "[operations-heartbeat-wakeup]";
const OPERATIONS_RECOVERY_WAKE_MARKER = "[operations-heartbeat-recovery]";
const OPERATIONS_REQUEUE_MARKER = "[operations-heartbeat-requeue]";
const OPERATIONS_ASSIGNMENT_MARKER = "[operations-heartbeat-assignment]";
const WATCHDOG_ISSUE_PATTERN = /watchdog|queue\s*lock|lock\s*repair|orphan(ed)?\s*run|heartbeat\s*recovery/i;
const ENGINEERING_ASSIGNMENT_REBALANCE_PATTERN =
  /\bcart|checkout|frontend|backend|api|component|typescript|react|db|database|migration|refactor|bug|fix|code\b/i;
const OPERATIONS_IDLE_WAKE_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const OPERATIONS_RECOVERY_REWAKE_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_OPERATIONS_RECOVERY_TARGETS_PER_SWEEP = 48;
const startLocksByAgent = new Map<string, Promise<void>>();
const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";
const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INLINE_WAKE_COMMENTS = 8;
const MAX_INLINE_WAKE_COMMENT_BODY_CHARS = 4_000;
const MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS = 12_000;
const execFile = promisify(execFileCallback);

const POSTGRES_TEXT_NULL_BYTE = /\u0000/g;

export function mapHermesCommandForRuntimeConfig(
  adapterType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (adapterType !== "hermes_local") return config;

  const newConfig = { ...config };
  if (newConfig.timeoutSec == null || newConfig.timeoutSec === 0) {
    // Hermes currently treats `0` as falsy and falls back to its internal
    // 300-second default. Pass `-1` at runtime so Paperclip's "no timeout"
    // intent survives until the adapter package is fixed upstream.
    newConfig.timeoutSec = -1;
  }
  const effectiveCommand = config.hermesCommand ?? config.command;
  if (!effectiveCommand) {
    return newConfig;
  }

  newConfig.command = effectiveCommand;
  newConfig.hermesCommand = effectiveCommand;
  return newConfig;
}

function stripPostgresTextNullBytes(value: string): string {
  if (!value.includes("\u0000")) return value;
  return value.replace(POSTGRES_TEXT_NULL_BYTE, "");
}

function sanitizePostgresTextValue<T>(value: T): T {
  if (typeof value === "string") {
    return stripPostgresTextNullBytes(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizePostgresTextValue(entry)) as T;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const prototype = Object.getPrototypeOf(toAny(value));
    if (prototype === Object.prototype || prototype === null) {
      const entries = Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        sanitizePostgresTextValue(entry),
      ]);
      return Object.fromEntries(entries) as T;
    }
  }
  return value;
}

function toAny(v: any): any { return v; }

function normalizePriorityRank(priority: string | null | undefined) {
  switch ((priority ?? "").toLowerCase()) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

function isOperationsAutomationCommentBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return (
    body.includes(OPERATIONS_IDLE_WAKE_MARKER)
    || body.includes(OPERATIONS_RECOVERY_WAKE_MARKER)
    || body.includes(OPERATIONS_REQUEUE_MARKER)
    || body.includes(OPERATIONS_ASSIGNMENT_MARKER)
  );
}

export function resolveOperationsTruthComment<T extends { body: string | null | undefined }>(input: {
  latestComment: T | null | undefined;
  latestNonOperationsComment: T | null | undefined;
}): T | null {
  const latestComment = input.latestComment ?? null;
  const latestNonOperationsComment = input.latestNonOperationsComment ?? null;
  if (!latestComment) return latestNonOperationsComment;
  if (isOperationsAutomationCommentBody(latestComment.body) && latestNonOperationsComment) {
    return latestNonOperationsComment;
  }
  return latestComment;
}

export function classifyIssueTruthFromCommentBody(body: string | null | undefined): "completion" | "blocker" | "handoff" | null {
  if (!body) return null;
  const text = body.toLowerCase();

  const completionSignals = [
    /\b(status|outcome)\s*:\s*(done|completed|resolved)\b/,
    /\bissue\s+resolved\b/,
    /(^|\n)\s*done\s*:/,
    /(^|\n)\s*completed\s*:/,
    /(^|\n)\s*resolved\s*:/,
  ];
  const blockerSignals = [
    /\b(status|outcome)\s*:\s*(blocked|needs[_ -]?help|blocked_on_external)\b/,
    /(^|\n)\s*blocked\s*:/,
    /(^|\n)\s*blocker\s*:/,
    /(^|\n)\s*waiting on\s*:/,
    /(^|\n)\s*#{1,6}\s*blocked\b/,
  ];
  const handoffSignals = [
    /\b(status|outcome)\s*:\s*(handoff|needs_review|needs_handoff)\b/,
    /(^|\n)\s*handoff\s*:/,
    /(^|\n)\s*needs review\s*:/,
    /\bready for review\b/,
    /(^|\n)\s*#{1,6}\s*reassigned\b/,
    /\breassign(?:ed|ing)\s+to\b/,
  ];

  if (completionSignals.some((rx) => rx.test(text))) return "completion";
  if (blockerSignals.some((rx) => rx.test(text))) return "blocker";
  if (handoffSignals.some((rx) => rx.test(text))) return "handoff";
  return null;
}

export function shouldSuppressOperationsRecoveryTarget(input: {
  status: string;
  latestCommentBody: string | null | undefined;
  latestCommentAgeHours: number;
  hasBlockers: boolean;
}): boolean {
  const truthType = classifyIssueTruthFromCommentBody(input.latestCommentBody);
  const hasFreshTruth = (truthType === "blocker" || truthType === "handoff") && input.latestCommentAgeHours < 6;
  if (!hasFreshTruth) return false;
  if (truthType === "handoff") return true;
  return input.status === "blocked" && input.hasBlockers;
}

function hasWaitStateTruthFromCommentBody(body: string | null | undefined): boolean {
  if (!body) return false;
  const text = body.toLowerCase();
  const waitSignals = [
    /\b(status|outcome)\s*:\s*(waiting|wait|standby|paused|blocked_on_external|waiting_on)\b/,
    /(^|\n)\s*waiting\s*:/,
    /(^|\n)\s*standby\s*:/,
    /(^|\n)\s*paused\s*:/,
  ];
  return waitSignals.some((rx) => rx.test(text));
}

function isWatchdogIssueLabel(label: string | null | undefined): boolean {
  return WATCHDOG_ISSUE_PATTERN.test((label ?? "").toLowerCase());
}

function buildOperationsIdleWakeComment(input: {
  assigneeAgentId: string;
  assigneeName: string | null;
}) {
  const mentionLabel = `@${(input.assigneeName ?? "assigned-agent").trim() || "assigned-agent"}`;
  const mention = `[${mentionLabel}](${buildAgentMentionHref(input.assigneeAgentId)})`;
  return [
    OPERATIONS_IDLE_WAKE_MARKER,
    `${mention} this assigned issue appears idle with no blocker, handoff, completion, or wait-state truth.`,
    "Please resume work now, or leave issue-level truth (status/outcome with blocker, handoff, completion, or wait-state).",
  ].join("\n");
}

function buildOperationsRecoveryWakeComment(input: {
  assigneeAgentId: string;
  assigneeName: string | null;
  reason: string;
}) {
  const mentionLabel = `@${(input.assigneeName ?? "assigned-agent").trim() || "assigned-agent"}`;
  const mention = `[${mentionLabel}](${buildAgentMentionHref(input.assigneeAgentId)})`;
  return [
    OPERATIONS_RECOVERY_WAKE_MARKER,
    `${mention} operations heartbeat detected assigned work that needs issue-level recovery.`,
    `Detected signal: ${input.reason}.`,
    "Please resume work now, or leave issue-level truth (status/outcome with blocker, handoff, completion, or wait-state).",
  ].join("\n");
}

function buildOperationsRequeueComment(input: { reason: string }) {
  return [
    OPERATIONS_REQUEUE_MARKER,
    "Operations heartbeat detected specialist work assigned to an orchestrator-only agent.",
    `Detected signal: ${input.reason}.`,
    "Returning this issue to the unassigned queue for specialist reassignment.",
  ].join("\n");
}

function buildOperationsAssignmentComment(input: {
  assigneeAgentId: string;
  assigneeName: string | null;
  reason: string;
}) {
  const mentionLabel = `@${(input.assigneeName ?? "assigned-agent").trim() || "assigned-agent"}`;
  const mention = `[${mentionLabel}](${buildAgentMentionHref(input.assigneeAgentId)})`;
  return [
    OPERATIONS_ASSIGNMENT_MARKER,
    `${mention} operations heartbeat assigned this issue for active work.`,
    `Reason: ${input.reason}.`,
    "Please resume work now, or leave issue-level truth (status/outcome with blocker, handoff, completion, or wait-state).",
  ].join("\n");
}

export function isOperationsOrchestratorAgent(agent: {
  role?: string | null;
  name?: string | null;
  title?: string | null;
  capabilities?: string | null;
  runtimeConfig?: Record<string, unknown> | null;
}) {
  return isOrchestratorOnlyAgent({
    role: agent.role ?? "",
    name: agent.name ?? "",
    title: agent.title ?? "",
    capabilities: agent.capabilities ?? "",
    runtimeConfig: agent.runtimeConfig ?? null,
  });
}

export async function resolveOperationsHeartbeatTarget(
  db: Db,
  input: { companyId: string; operationsAgentId: string },
): Promise<OperationsHeartbeatTarget | null> {
  const [first] = await resolveOperationsHeartbeatTargets(db, input);
  return first ?? null;
}

async function resolveOperationsHeartbeatTargets(
  db: Db,
  input: { companyId: string; operationsAgentId: string },
): Promise<OperationsHeartbeatTarget[]> {
  const now = Date.now();

  let openAssignedIssues = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      priority: issues.priority,
      updatedAt: issues.updatedAt,
      executionRunId: issues.executionRunId,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
        sql`${issues.hiddenAt} is null`,
        sql`${issues.assigneeAgentId} is not null`,
      ),
    );

  if (openAssignedIssues.length > 0) {
    const recoveredSourceRows = await db
      .select({ issueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.type, "recovered_by"),
          inArray(issueRelations.issueId, openAssignedIssues.map((row) => row.id)),
        ),
      );

    if (recoveredSourceRows.length > 0) {
      const recoveredSourceIssueIds = new Set(recoveredSourceRows.map((row) => row.issueId));
      openAssignedIssues = openAssignedIssues.filter((row) => !recoveredSourceIssueIds.has(row.id));
    }
  }

  if (openAssignedIssues.length > 0) {
    const runIds = Array.from(
      new Set(openAssignedIssues.map((row) => row.executionRunId).filter((id): id is string => Boolean(id))),
    );
    const runRows =
      runIds.length > 0
        ? await db
            .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
            .from(heartbeatRuns)
            .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, runIds)))
        : [];
    const runById = new Map(runRows.map((row) => [row.id, row]));

    const issueIds = openAssignedIssues.map((row) => row.id);
    const latestCommentRows =
      issueIds.length > 0
        ? await db
            .selectDistinctOn([issueComments.issueId], {
              issueId: issueComments.issueId,
              createdAt: issueComments.createdAt,
              authorAgentId: issueComments.authorAgentId,
              body: issueComments.body,
            })
            .from(issueComments)
            .where(and(eq(issueComments.companyId, input.companyId), inArray(issueComments.issueId, issueIds)))
            .orderBy(issueComments.issueId, desc(issueComments.createdAt))
        : [];
    const latestNonOperationsCommentRows =
      issueIds.length > 0
        ? await db
            .selectDistinctOn([issueComments.issueId], {
              issueId: issueComments.issueId,
              createdAt: issueComments.createdAt,
              authorAgentId: issueComments.authorAgentId,
              body: issueComments.body,
            })
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, input.companyId),
                inArray(issueComments.issueId, issueIds),
                sql`${issueComments.body} not like ${`${OPERATIONS_IDLE_WAKE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_RECOVERY_WAKE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_REQUEUE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_ASSIGNMENT_MARKER}%`}`,
              ),
            )
            .orderBy(issueComments.issueId, desc(issueComments.createdAt))
        : [];
    const latestCommentByIssueId = new Map(latestCommentRows.map((row) => [row.issueId, row]));
    const latestNonOperationsCommentByIssueId = new Map(
      latestNonOperationsCommentRows.map((row) => [row.issueId, row]),
    );
    const effectiveLatestCommentByIssueId = new Map(
      issueIds.map((issueId) => [
        issueId,
        resolveOperationsTruthComment({
          latestComment: latestCommentByIssueId.get(issueId),
          latestNonOperationsComment: latestNonOperationsCommentByIssueId.get(issueId),
        }),
      ]),
    );
    const blockerRows =
      issueIds.length > 0
        ? await db
            .select({ issueId: issueRelations.relatedIssueId })
            .from(issueRelations)
            .where(
              and(
                eq(issueRelations.companyId, input.companyId),
                eq(issueRelations.type, "blocks"),
                inArray(issueRelations.relatedIssueId, issueIds),
              ),
            )
        : [];
    const issuesWithBlockers = new Set(blockerRows.map((row) => row.issueId));

    const watchdogIssueIds = openAssignedIssues
      .filter((issue) => {
        const watchdogLabel = `${issue.identifier ?? ""} ${issue.title}`.toLowerCase();
        return isWatchdogIssueLabel(watchdogLabel);
      })
      .map((issue) => issue.id);

    const watchdogCooldownCutoff = new Date(now - WATCHDOG_RECOVERY_COOLDOWN_HOURS * 60 * 60 * 1000);
    const recentWatchdogSuccessCount =
      watchdogIssueIds.length > 0
        ? await db
            .select({
              id: heartbeatRuns.id,
              finishedAt: heartbeatRuns.finishedAt,
              contextIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
            })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, input.companyId),
                eq(heartbeatRuns.agentId, input.operationsAgentId),
                inArray(heartbeatRuns.status, ["succeeded", "completed"]),
                sql`${heartbeatRuns.finishedAt} is not null`,
              ),
            )
            .then((rows) => rows.filter((row) => {
              if (!row.contextIssueId || !watchdogIssueIds.includes(row.contextIssueId) || !row.finishedAt) {
                return false;
              }
              return new Date(row.finishedAt).getTime() >= watchdogCooldownCutoff.getTime();
            }).length)
        : 0;

    const watchdogCooldownActive = recentWatchdogSuccessCount > WATCHDOG_RECOVERY_REPEAT_THRESHOLD;

    const ranked = openAssignedIssues
      .map((issue) => {
        const run = issue.executionRunId ? runById.get(issue.executionRunId) : undefined;
        const latestComment = effectiveLatestCommentByIssueId.get(issue.id);
        const issueAgeHours = Math.floor((now - issue.updatedAt.getTime()) / (60 * 60 * 1000));
        const latestCommentAgeHours = latestComment
          ? Math.floor((now - latestComment.createdAt.getTime()) / (60 * 60 * 1000))
          : Number.POSITIVE_INFINITY;
        const truthType = classifyIssueTruthFromCommentBody(latestComment?.body);
        const hasBlockers = issuesWithBlockers.has(issue.id);
        const isOperationsOwned = issue.assigneeAgentId === input.operationsAgentId;
        const watchdogLabel = `${issue.identifier ?? ""} ${issue.title}`.toLowerCase();
        const isWatchdogIssue = isWatchdogIssueLabel(watchdogLabel);

        let score = 0;
        const reasons: string[] = [];

        const hasFreshBlockerOrHandoffTruth =
          (truthType === "blocker" || truthType === "handoff") && latestCommentAgeHours < 6;
        const hasStuckAssignedSignals =
          (issue.status === "in_progress" && !issue.executionRunId)
          || issue.status === "blocked"
          || Boolean(run && (run.status === "failed" || run.status === "cancelled"));
        const hasFalseCompleteSignals = Boolean(
          run
          && run.status === "completed"
          && truthType !== "completion"
          && truthType !== "blocker"
          && truthType !== "handoff",
        );
        const hasContradictoryTruthSignals =
          (truthType === "completion" && issue.status !== "in_review")
          || ((truthType === "blocker" || truthType === "handoff") && issue.status === "backlog");
        const suppressRecovery = shouldSuppressOperationsRecoveryTarget({
          status: issue.status,
          latestCommentBody: latestComment?.body,
          latestCommentAgeHours,
          hasBlockers,
        });

        if (suppressRecovery) {
          return {
            issue,
            score: -200,
            reasons: ["fresh blocker/handoff truth already covers the current wait state"],
            issueAgeHours,
            isOperationsOwned,
            isWatchdogIssue,
            hasStuckAssignedSignals: false,
            hasFalseCompleteSignals,
            hasContradictoryTruthSignals,
          };
        }

        if (issue.status === "in_progress" && !issue.executionRunId) {
          score += 180;
          reasons.push("stale or blocked assigned work: in_progress with no execution run");
        }
        if (issue.status === "blocked") {
          score += 170;
          reasons.push("stale or blocked assigned work: status is blocked");
        }
        if (run && (run.status === "failed" || run.status === "cancelled")) {
          score += 180;
          reasons.push(`stale assigned work: latest run ended ${run.status}`);
        }

        if (hasFalseCompleteSignals) {
          score += 280;
          reasons.push("incomplete/false-complete assigned work: run completed without completion/blocker/handoff truth");
        }

        if (truthType === "completion" && issue.status !== "in_review") {
          score += 240;
          reasons.push("contradictory issue truth: completion truth on non-completed status");
        }
        if ((truthType === "blocker" || truthType === "handoff") && issue.status === "backlog") {
          score += 200;
          reasons.push(`contradictory issue truth: ${truthType} truth while status is backlog`);
        }

        if (!latestComment) {
          score += 90;
          reasons.push("no issue comments found");
        }
        if (latestComment && !truthType && latestCommentAgeHours >= 12) {
          score += 100;
          reasons.push(`stale comment without explicit truth (${latestCommentAgeHours}h)`);
        }
        if (issueAgeHours >= 24) {
          score += 100;
          reasons.push(`stale issue updates (${issueAgeHours}h)`);
        }

        if (isWatchdogIssue) {
          score += 40;
          reasons.push("queue-lock/watchdog issue");
          if (hasStuckAssignedSignals || hasFalseCompleteSignals || hasContradictoryTruthSignals) {
            score += 80;
            reasons.push("watchdog issue has active recovery signals");
          }
          if (
            watchdogCooldownActive
            && !hasFalseCompleteSignals
            && !hasStuckAssignedSignals
            && !hasContradictoryTruthSignals
          ) {
            score -= 260;
            reasons.push("watchdog cooldown active after recent successful verification runs");
          }
        }

        score += normalizePriorityRank(issue.priority) * 18;
        if (hasFreshBlockerOrHandoffTruth) {
          score -= 120;
          reasons.push(`fresh ${truthType} truth already present`);
        }
        if (truthType === "completion" && run?.status === "completed" && issue.status === "in_review") {
          score -= 160;
          reasons.push("completion truth aligns with current state");
        }

        return {
          issue,
          score,
          reasons,
          issueAgeHours,
          isOperationsOwned,
          isWatchdogIssue,
          hasStuckAssignedSignals,
          hasFalseCompleteSignals,
          hasContradictoryTruthSignals,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.issueAgeHours - a.issueAgeHours);

    if (ranked.length > 0) {
      return ranked
        .slice(0, MAX_OPERATIONS_RECOVERY_TARGETS_PER_SWEEP)
        .map((entry) => ({
          issueId: entry.issue.id,
          mode: entry.isOperationsOwned ? "ops_active" : "cross_agent_recovery",
          reason: entry.reasons.join("; "),
          autoReissueEligible:
            !entry.isOperationsOwned
            && !entry.isWatchdogIssue
            && (
              entry.hasStuckAssignedSignals
              || entry.hasFalseCompleteSignals
              || entry.hasContradictoryTruthSignals
            ),
        }));
    }
  }

  const readyUnassigned = await db
    .select({
      id: issues.id,
      priority: issues.priority,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, input.companyId),
        inArray(issues.status, READY_UNASSIGNED_STATUSES as unknown as string[]),
        sql`${issues.hiddenAt} is null`,
        sql`${issues.assigneeAgentId} is null`,
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .then((rows) => rows[0] ?? null);

  if (readyUnassigned) {
    return [{
      issueId: readyUnassigned.id,
      mode: "ready_unassigned",
      reason: "no recovery target found; selected ready unassigned issue",
      autoReissueEligible: false,
    }];
  }

  return [];
}
type OperationsHeartbeatTarget = {
  issueId: string;
  mode: "ops_active" | "cross_agent_recovery" | "ready_unassigned";
  reason: string;
  autoReissueEligible: boolean;
};
type DbExecutor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

type RuntimeConfigSecretResolver = Pick<
  ReturnType<typeof secretService>,
  "resolveAdapterConfigForRuntime" | "resolveEnvBindings"
>;

export async function resolveExecutionRunAdapterConfig(input: {
  companyId: string;
  executionRunConfig: Record<string, unknown>;
  projectEnv: unknown;
  secretsSvc: RuntimeConfigSecretResolver;
}) {
  const { config: resolvedConfig, secretKeys } = await input.secretsSvc.resolveAdapterConfigForRuntime(
    input.companyId,
    input.executionRunConfig,
  );
  const projectEnvResolution = input.projectEnv
    ? await input.secretsSvc.resolveEnvBindings(input.companyId, input.projectEnv)
    : { env: {}, secretKeys: new Set<string>() };
  if (Object.keys(projectEnvResolution.env).length > 0) {
    resolvedConfig.env = {
      ...parseObject(resolvedConfig.env),
      ...projectEnvResolution.env,
    };
    for (const key of projectEnvResolution.secretKeys) {
      secretKeys.add(key);
    }
  }
  return { resolvedConfig, secretKeys };
}

export function applyPersistedExecutionWorkspaceConfig(input: {
  config: Record<string, unknown>;
  workspaceConfig: ExecutionWorkspaceConfig | null;
  mode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const nextConfig = { ...input.config };

  if (input.mode !== "agent_default") {
    if (input.workspaceConfig?.workspaceRuntime === null) {
      delete nextConfig.workspaceRuntime;
    } else if (input.workspaceConfig?.workspaceRuntime) {
      nextConfig.workspaceRuntime = { ...input.workspaceConfig.workspaceRuntime };
    }
  }

  if (input.workspaceConfig && input.mode === "isolated_workspace") {
    const nextStrategy = parseObject(nextConfig.workspaceStrategy);
    if (input.workspaceConfig.provisionCommand === null) delete nextStrategy.provisionCommand;
    else nextStrategy.provisionCommand = input.workspaceConfig.provisionCommand;
    if (input.workspaceConfig.teardownCommand === null) delete nextStrategy.teardownCommand;
    else nextStrategy.teardownCommand = input.workspaceConfig.teardownCommand;
    nextConfig.workspaceStrategy = nextStrategy;
  }

  return nextConfig;
}

export function stripWorkspaceRuntimeFromExecutionRunConfig(config: Record<string, unknown>) {
  const nextConfig = { ...config };
  delete nextConfig.workspaceRuntime;
  return nextConfig;
}

export function buildRealizedExecutionWorkspaceFromPersisted(input: {
  base: ExecutionWorkspaceInput;
  workspace: ExecutionWorkspace;
}): RealizedExecutionWorkspace | null {
  const cwd = readNonEmptyString(input.workspace.cwd) ?? readNonEmptyString(input.workspace.providerRef);
  if (!cwd) {
    return null;
  }

  const strategy = input.workspace.strategyType === "git_worktree" ? "git_worktree" : "project_primary";
  return {
    baseCwd: input.base.baseCwd,
    source: input.workspace.mode === "shared_workspace" ? "project_primary" : "task_session",
    projectId: input.workspace.projectId ?? input.base.projectId,
    workspaceId: input.workspace.projectWorkspaceId ?? input.base.workspaceId,
    repoUrl: input.workspace.repoUrl ?? input.base.repoUrl,
    repoRef: input.workspace.baseRef ?? input.base.repoRef,
    strategy,
    cwd,
    branchName: input.workspace.branchName ?? null,
    worktreePath: strategy === "git_worktree" ? (readNonEmptyString(input.workspace.providerRef) ?? cwd) : null,
    warnings: [],
    created: false,
  };
}

function buildExecutionWorkspaceConfigSnapshot(config: Record<string, unknown>): Partial<ExecutionWorkspaceConfig> | null {
  const strategy = parseObject(config.workspaceStrategy);
  const snapshot: Partial<ExecutionWorkspaceConfig> = {};

  if ("workspaceStrategy" in config) {
    snapshot.provisionCommand = typeof strategy.provisionCommand === "string" ? strategy.provisionCommand : null;
    snapshot.teardownCommand = typeof strategy.teardownCommand === "string" ? strategy.teardownCommand : null;
  }

  if ("workspaceRuntime" in config) {
    const workspaceRuntime = parseObject(config.workspaceRuntime);
    snapshot.workspaceRuntime = Object.keys(workspaceRuntime).length > 0 ? workspaceRuntime : null;
  }

  const hasSnapshot = Object.values(snapshot).some((value) => {
    if (value === null) return false;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
  return hasSnapshot ? snapshot : null;
}

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

function appendExcerpt(prev: string, chunk: string) {
  return appendWithCap(prev, chunk, MAX_EXCERPT_BYTES);
}

function normalizeMaxConcurrentRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT;
  return Math.max(HEARTBEAT_MAX_CONCURRENT_RUNS_DEFAULT, Math.min(HEARTBEAT_MAX_CONCURRENT_RUNS_MAX, parsed));
}

function normalizeMaxLiveRuns(value: unknown) {
  const parsed = Math.floor(asNumber(value, HEARTBEAT_MAX_LIVE_RUNS_DEFAULT));
  if (!Number.isFinite(parsed)) return HEARTBEAT_MAX_LIVE_RUNS_DEFAULT;
  return Math.max(1, Math.min(HEARTBEAT_MAX_LIVE_RUNS_MAX, parsed));
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

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

type SessionCompactionDecision = {
  rotate: boolean;
  reason: string | null;
  handoffMarkdown: string | null;
  previousRunId: string | null;
};

interface ParsedIssueAssigneeAdapterOverrides {
  adapterConfig: Record<string, unknown> | null;
  useProjectWorkspace: boolean | null;
}

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

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<T extends ProjectWorkspaceCandidate>(
  rows: T[],
  preferredWorkspaceId: string | null | undefined,
): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex((row) => row.id === preferredWorkspaceId);
  if (preferredIndex <= 0) return rows;
  return [rows[preferredIndex]!, ...rows.slice(0, preferredIndex), ...rows.slice(preferredIndex + 1)];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = readNonEmptyString(value);
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

function resolveLedgerBiller(result: AdapterExecutionResult): string {
  return readNonEmptyString(result.biller) ?? readNonEmptyString(result.provider) ?? "unknown";
}

function normalizeBilledCostCents(costUsd: number | null | undefined, billingType: BillingType): number {
  if (billingType === "subscription_included") return 0;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd)) return 0;
  return Math.max(0, Math.round(costUsd * 100));
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

type ResumeSessionRow = {
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
};

function isSuspiciousRuntimeSessionId(value: string | null | undefined) {
  const normalized = readNonEmptyString(value)?.toLowerCase() ?? null;
  return normalized === "from" || normalized === "a" || normalized === "an" || normalized === "the";
}

function sanitizeRuntimeSessionDisplayId(value: string | null | undefined) {
  const normalized = truncateDisplayId(value);
  return isSuspiciousRuntimeSessionId(normalized) ? null : normalized;
}

function sanitizeRuntimeSessionParams(params: Record<string, unknown> | null | undefined) {
  const normalized = normalizeSessionParams(params ?? null);
  if (!normalized) return null;
  const sessionId = readNonEmptyString(normalized.sessionId);
  if (!sessionId || !isSuspiciousRuntimeSessionId(sessionId)) return normalized;
  const next = { ...normalized };
  delete next.sessionId;
  return Object.keys(next).length > 0 ? next : null;
}

function hasMissingSessionAdapterFailure(adapterResult: AdapterExecutionResult) {
  const resultRecord = parseObject(adapterResult.resultJson);
  const messages = [
    adapterResult.errorMessage,
    readNonEmptyString(resultRecord.result),
    readNonEmptyString(resultRecord.stderr),
    readNonEmptyString(resultRecord.stdout),
    readNonEmptyString(resultRecord.message),
  ].filter((value): value is string => Boolean(value));
  return messages.some((value) => /session not found|use a session id from a previous cli run|unknown session|failed to resume/i.test(value));
}

function hasContextOverflowAdapterFailure(adapterResult: AdapterExecutionResult) {
  const resultRecord = parseObject(adapterResult.resultJson);
  const messages = [
    adapterResult.errorMessage,
    readNonEmptyString(resultRecord.result),
    readNonEmptyString(resultRecord.stderr),
    readNonEmptyString(resultRecord.stdout),
    readNonEmptyString(resultRecord.message),
  ].filter((value): value is string => Boolean(value));

  return messages.some((value) =>
    /maximum context length|prompt contains at least .* input tokens|context too large|context length exceeded|max compression attempts|input_tokens/i.test(
      value,
    ),
  );
}

export function buildExplicitResumeSessionOverride(input: {
  resumeFromRunId: string;
  resumeRunSessionIdBefore: string | null;
  resumeRunSessionIdAfter: string | null;
  taskSession: ResumeSessionRow | null;
  sessionCodec: AdapterSessionCodec;
}) {
  const desiredDisplayId = sanitizeRuntimeSessionDisplayId(
    input.resumeRunSessionIdAfter ?? input.resumeRunSessionIdBefore,
  );
  const taskSessionParams = sanitizeRuntimeSessionParams(
    input.sessionCodec.deserialize(input.taskSession?.sessionParamsJson ?? null),
  );
  const taskSessionDisplayId = sanitizeRuntimeSessionDisplayId(
    input.taskSession?.sessionDisplayId ??
      (input.sessionCodec.getDisplayId ? input.sessionCodec.getDisplayId(taskSessionParams) : null) ??
      readNonEmptyString(taskSessionParams?.sessionId),
  );
  const canReuseTaskSessionParams =
    input.taskSession != null &&
    (
      input.taskSession.lastRunId === input.resumeFromRunId ||
      (!!desiredDisplayId && taskSessionDisplayId === desiredDisplayId)
    );
  const sessionParams =
    canReuseTaskSessionParams
      ? taskSessionParams
      : desiredDisplayId
        ? { sessionId: desiredDisplayId }
        : null;
  const sessionDisplayId = desiredDisplayId ?? (canReuseTaskSessionParams ? taskSessionDisplayId : null);

  if (!sessionDisplayId && !sessionParams) return null;
  return {
    sessionDisplayId,
    sessionParams,
  };
}

function normalizeUsageTotals(usage: UsageSummary | null | undefined): UsageTotals | null {
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Math.floor(asNumber(usage.inputTokens, 0))),
    cachedInputTokens: Math.max(0, Math.floor(asNumber(usage.cachedInputTokens, 0))),
    outputTokens: Math.max(0, Math.floor(asNumber(usage.outputTokens, 0))),
  };
}

function readRawUsageTotals(usageJson: unknown): UsageTotals | null {
  const parsed = parseObject(usageJson);
  if (Object.keys(parsed).length === 0) return null;

  const inputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawInputTokens, asNumber(parsed.inputTokens, 0))),
  );
  const cachedInputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawCachedInputTokens, asNumber(parsed.cachedInputTokens, 0))),
  );
  const outputTokens = Math.max(
    0,
    Math.floor(asNumber(parsed.rawOutputTokens, asNumber(parsed.outputTokens, 0))),
  );

  if (inputTokens <= 0 && cachedInputTokens <= 0 && outputTokens <= 0) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
  };
}

function deriveNormalizedUsageDelta(current: UsageTotals | null, previous: UsageTotals | null): UsageTotals | null {
  if (!current) return null;
  if (!previous) return { ...current };

  const inputTokens = current.inputTokens >= previous.inputTokens
    ? current.inputTokens - previous.inputTokens
    : current.inputTokens;
  const cachedInputTokens = current.cachedInputTokens >= previous.cachedInputTokens
    ? current.cachedInputTokens - previous.cachedInputTokens
    : current.cachedInputTokens;
  const outputTokens = current.outputTokens >= previous.outputTokens
    ? current.outputTokens - previous.outputTokens
    : current.outputTokens;

  return {
    inputTokens: Math.max(0, inputTokens),
    cachedInputTokens: Math.max(0, cachedInputTokens),
    outputTokens: Math.max(0, outputTokens),
  };
}

function formatCount(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
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

/**
 * Extended task key derivation for wakeup context.
 * If no explicit task/issue key exists in context/payload, the result is null
 * to avoid session reuse across unrelated non-ticket work.
 */
export function deriveTaskKeyWithHeartbeatFallback(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const explicit = deriveTaskKey(contextSnapshot, payload);
  if (explicit) return explicit;

  return null;
}

export function shouldResetTaskSessionForWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return true;

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return true;
  return false;
}

export function formatRuntimeWorkspaceWarningLog(warning: string) {
  return {
    stream: "stdout" as const,
    chunk: `[paperclip] ${warning}\n`,
  };
}

function describeSessionResetReason(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  if (contextSnapshot?.forceFreshSession === true) return "forceFreshSession was requested";

  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (wakeReason === "issue_assigned") return "wake reason is issue_assigned";
  return null;
}

function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function extractWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const raw = contextSnapshot?.[WAKE_COMMENT_IDS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = readNonEmptyString(entry);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

function mergeWakeCommentIds(...values: Array<unknown>): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const entry of value) append(entry);
      continue;
    }
    if (typeof value === "object" && value !== null) {
      const candidate = value as Record<string, unknown>;
      const batched = extractWakeCommentIds(candidate);
      if (batched.length > 0) {
        for (const entry of batched) append(entry);
        continue;
      }
      append(candidate.wakeCommentId);
      append(candidate.commentId);
      continue;
    }
    append(value);
  }

  return merged;
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
  const wakeCommentIds = mergeWakeCommentIds(contextSnapshot, commentIdFromPayload);

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
  if (wakeCommentIds.length > 0) {
    const latestCommentId = wakeCommentIds[wakeCommentIds.length - 1];
    contextSnapshot[WAKE_COMMENT_IDS_KEY] = wakeCommentIds;
    contextSnapshot.commentId = latestCommentId;
    contextSnapshot.wakeCommentId = latestCommentId;
    // Once comment ids are normalized into the snapshot, rebuild the structured
    // wake payload from those ids later instead of carrying forward stale data.
    delete contextSnapshot[PAPERCLIP_WAKE_PAYLOAD_KEY];
  } else if (!readNonEmptyString(contextSnapshot["wakeCommentId"]) && wakeCommentId) {
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

export function mergeCoalescedContextSnapshot(
  existingRaw: unknown,
  incoming: Record<string, unknown>,
) {
  const existing = parseObject(existingRaw);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };
  const mergedCommentIds = mergeWakeCommentIds(existing, incoming);
  if (mergedCommentIds.length > 0) {
    const latestCommentId = mergedCommentIds[mergedCommentIds.length - 1];
    merged[WAKE_COMMENT_IDS_KEY] = mergedCommentIds;
    merged.commentId = latestCommentId;
    merged.wakeCommentId = latestCommentId;
    // The merged context should carry canonical comment ids; the next wake will
    // regenerate any structured payload from those ids.
    delete merged[PAPERCLIP_WAKE_PAYLOAD_KEY];
  }
  return merged;
}

async function buildPaperclipWakePayload(input: {
  db: Db;
  companyId: string;
  contextSnapshot: Record<string, unknown>;
  issueSummary?:
    | {
        id: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
      }
    | null;
}) {
  const commentIds = extractWakeCommentIds(input.contextSnapshot);
  if (commentIds.length === 0) return null;

  const issueId = readNonEmptyString(input.contextSnapshot.issueId);
  const issueSummary =
    input.issueSummary ??
    (issueId
      ? await input.db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null);

  const commentRows = await input.db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      body: issueComments.body,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        inArray(issueComments.id, commentIds),
      ),
    );

  const commentsById = new Map(commentRows.map((comment) => [comment.id, comment]));
  const comments: Array<Record<string, unknown>> = [];
  let remainingBodyChars = MAX_INLINE_WAKE_COMMENT_BODY_TOTAL_CHARS;
  let truncated = false;
  let missingCommentCount = 0;

  for (const commentId of commentIds) {
    const row = commentsById.get(commentId);
    if (!row) {
      truncated = true;
      missingCommentCount += 1;
      continue;
    }
    if (comments.length >= MAX_INLINE_WAKE_COMMENTS) {
      truncated = true;
      break;
    }

    const fullBody = row.body;
    const allowedBodyChars = Math.min(MAX_INLINE_WAKE_COMMENT_BODY_CHARS, remainingBodyChars);
    if (allowedBodyChars <= 0) {
      truncated = true;
      break;
    }

    const body = fullBody.length > allowedBodyChars ? fullBody.slice(0, allowedBodyChars) : fullBody;
    const bodyTruncated = body.length < fullBody.length;
    if (bodyTruncated) truncated = true;
    remainingBodyChars -= body.length;

    comments.push({
      id: row.id,
      issueId: row.issueId,
      body,
      bodyTruncated,
      createdAt: row.createdAt.toISOString(),
      author: row.authorAgentId
        ? { type: "agent", id: row.authorAgentId }
        : row.authorUserId
          ? { type: "user", id: row.authorUserId }
          : { type: "system", id: null },
    });
  }

  return {
    reason: readNonEmptyString(input.contextSnapshot.wakeReason),
    issue: issueSummary
      ? {
          id: issueSummary.id,
          identifier: issueSummary.identifier,
          title: issueSummary.title,
          status: issueSummary.status,
          priority: issueSummary.priority,
        }
      : null,
    commentIds,
    latestCommentId: commentIds[commentIds.length - 1] ?? null,
    comments,
    commentWindow: {
      requestedCount: commentIds.length,
      includedCount: comments.length,
      missingCount: missingCommentCount,
    },
    truncated,
    fallbackFetchNeeded: truncated || missingCommentCount > 0,
  };
}

function runTaskKey(run: typeof heartbeatRuns.$inferSelect) {
  return deriveTaskKey(run.contextSnapshot as Record<string, unknown> | null, null);
}

function isSameTaskScope(left: string | null, right: string | null) {
  if (!left || !right) return false;
  return left === right;
}

function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
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

function isAgentInvokableStatus(status: string | null | undefined) {
  return status !== "paused" && status !== "terminated" && status !== "pending_approval";
}

function isAgentNotInvokableConflict(error: unknown) {
  return error instanceof HttpError && error.status === 409 && error.message === "Agent is not invokable in its current state";
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

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = sanitizeRuntimeSessionDisplayId(readNonEmptyString(adapterResult.sessionId));
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = sanitizeRuntimeSessionDisplayId(readNonEmptyString(adapterResult.sessionDisplayId));
  const shouldClearMissingSession =
    hasMissingSessionAdapterFailure(adapterResult) &&
    !sanitizeRuntimeSessionParams(hasExplicitParams ? explicitParams ?? null : null) &&
    !explicitSessionId &&
    !explicitDisplayId;
  const shouldClearContextOverflowSession =
    hasContextOverflowAdapterFailure(adapterResult) &&
    !sanitizeRuntimeSessionParams(hasExplicitParams ? explicitParams ?? null : null) &&
    !explicitSessionId &&
    !explicitDisplayId;

  if (adapterResult.clearSession || shouldClearMissingSession || shouldClearContextOverflowSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? sanitizeRuntimeSessionParams(explicitParams ?? null)
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : sanitizeRuntimeSessionParams(previousParams);

  const serialized = sanitizeRuntimeSessionParams(codec.serialize(sanitizeRuntimeSessionParams(candidateParams) ?? null));
  const deserialized = sanitizeRuntimeSessionParams(codec.deserialize(serialized));

  const displayId = sanitizeRuntimeSessionDisplayId(
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
    (shouldUsePrevious ? sanitizeRuntimeSessionDisplayId(previousLegacySessionId) : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
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

  async function getCompanyStatus(companyId: string) {
    return db
      .select({ status: companies.status })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.status ?? null);
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
      "Paperclip session handoff:",
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

    return null;
  }

  async function resolveExplicitResumeSessionOverride(
    agent: typeof agents.$inferSelect,
    payload: Record<string, unknown> | null,
    taskKey: string | null,
  ) {
    const resumeFromRunId = readNonEmptyString(payload?.resumeFromRunId);
    if (!resumeFromRunId) return null;

    const resumeRun = await db
      .select({
        id: heartbeatRuns.id,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, resumeFromRunId),
          eq(heartbeatRuns.companyId, agent.companyId),
          eq(heartbeatRuns.agentId, agent.id),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!resumeRun) return null;

    const resumeContext = parseObject(resumeRun.contextSnapshot);
    const resumeTaskKey = deriveTaskKey(resumeContext, null) ?? taskKey;
    const resumeTaskSession = resumeTaskKey
      ? await getTaskSession(agent.companyId, agent.id, agent.adapterType, resumeTaskKey)
      : null;
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const sessionOverride = buildExplicitResumeSessionOverride({
      resumeFromRunId,
      resumeRunSessionIdBefore: resumeRun.sessionIdBefore,
      resumeRunSessionIdAfter: resumeRun.sessionIdAfter,
      taskSession: resumeTaskSession,
      sessionCodec,
    });
    if (!sessionOverride) return null;

    return {
      resumeFromRunId,
      taskKey: resumeTaskKey,
      issueId: readNonEmptyString(resumeContext.issueId),
      taskId: readNonEmptyString(resumeContext.taskId) ?? readNonEmptyString(resumeContext.issueId),
      sessionDisplayId: sessionOverride.sessionDisplayId,
      sessionParams: sessionOverride.sessionParams,
    };
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
    const sanitizedPatch = patch ? sanitizePostgresTextValue(patch) : patch;
    const updated = await db
      .update(heartbeatRuns)
      .set({ status, ...sanitizedPatch, updatedAt: new Date() })
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
    const sanitizedPatch = patch ? sanitizePostgresTextValue(patch) : patch;
    await db
      .update(agentWakeupRequests)
      .set({ status, ...sanitizedPatch, updatedAt: new Date() })
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
      ? stripPostgresTextNullBytes(redactCurrentUserText(event.message, currentUserRedactionOptions))
      : event.message;
    const sanitizedPayload = event.payload
      ? sanitizePostgresTextValue(redactCurrentUserValue(event.payload, currentUserRedactionOptions))
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

  async function patchRunIssueCommentStatus(
    runId: string,
    patch: Partial<Pick<typeof heartbeatRuns.$inferInsert, "issueCommentStatus" | "issueCommentSatisfiedByCommentId" | "issueCommentRetryQueuedAt">>,
  ) {
    return db
      .update(heartbeatRuns)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function findRunIssueComment(runId: string, companyId: string, issueId: string) {
    return db
      .select({
        id: issueComments.id,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, runId),
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function enqueueMissingIssueCommentRetry(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
    issueId: string,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const taskKey = deriveTaskKeyWithHeartbeatFallback(contextSnapshot, null);
    const sessionBefore = await resolveSessionBeforeForWakeup(agent, taskKey);
    const retryContextSnapshot = {
      ...contextSnapshot,
      retryOfRunId: run.id,
      wakeReason: "missing_issue_comment",
      retryReason: "missing_issue_comment",
      missingIssueCommentForRunId: run.id,
    };
    const now = new Date();

    const retryRun = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from issues where company_id = ${run.companyId} and execution_run_id = ${run.id} for update`,
      );

      const issue = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, run.companyId), eq(issues.executionRunId, run.id)))
        .then((rows) => rows[0] ?? null);
      if (!issue) return null;

      const wakeupRequest = await tx
        .insert(agentWakeupRequests)
        .values({
          companyId: run.companyId,
          agentId: run.agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "missing_issue_comment",
          payload: {
            issueId,
            retryOfRunId: run.id,
            retryReason: "missing_issue_comment",
          },
          status: "queued",
          requestedByActorType: "system",
          requestedByActorId: null,
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      const queuedRun = await tx
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
          issueCommentStatus: "not_applicable",
          updatedAt: now,
        })
        .returning()
        .then((rows) => rows[0]);

      await tx
        .update(agentWakeupRequests)
        .set({
          runId: queuedRun.id,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequest.id));

      await tx
        .update(issues)
        .set({
          executionRunId: queuedRun.id,
          executionAgentNameKey: normalizeAgentNameKey(agent.name),
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(eq(issues.id, issue.id));

      await tx
        .update(heartbeatRuns)
        .set({
          issueCommentStatus: "retry_queued",
          issueCommentRetryQueuedAt: now,
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, run.id));

      return queuedRun;
    });

    if (!retryRun) return null;

    publishLiveEvent({
      companyId: retryRun.companyId,
      type: "heartbeat.run.queued",
      payload: {
        runId: retryRun.id,
        agentId: retryRun.agentId,
        invocationSource: retryRun.invocationSource,
        triggerDetail: retryRun.triggerDetail,
        wakeupRequestId: retryRun.wakeupRequestId,
      },
    });

    return retryRun;
  }

  async function finalizeIssueCommentPolicy(
    run: typeof heartbeatRuns.$inferSelect,
    agent: typeof agents.$inferSelect,
  ) {
    const contextSnapshot = parseObject(run.contextSnapshot);
    const issueId = readNonEmptyString(contextSnapshot.issueId);
    if (!issueId) {
      if (run.issueCommentStatus !== "not_applicable") {
        await patchRunIssueCommentStatus(run.id, {
          issueCommentStatus: "not_applicable",
          issueCommentSatisfiedByCommentId: null,
          issueCommentRetryQueuedAt: null,
        });
      }
      return { outcome: "not_applicable" as const, queuedRun: null };
    }

    const postedComment = await findRunIssueComment(run.id, run.companyId, issueId);
    if (postedComment) {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "satisfied",
        issueCommentSatisfiedByCommentId: postedComment.id,
        issueCommentRetryQueuedAt: null,
      });
      return { outcome: "satisfied" as const, queuedRun: null };
    }

    if (readNonEmptyString(contextSnapshot.retryReason) === "missing_issue_comment") {
      await patchRunIssueCommentStatus(run.id, {
        issueCommentStatus: "retry_exhausted",
        issueCommentSatisfiedByCommentId: null,
      });
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run ended without an issue comment after one retry; no further comment wake will be queued",
      });
      return { outcome: "retry_exhausted" as const, queuedRun: null };
    }

    const queuedRun = await enqueueMissingIssueCommentRetry(run, agent, issueId);
    if (queuedRun) {
      await appendRunEvent(run, await nextRunEventSeq(run.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "Run ended without an issue comment; queued one follow-up wake to require a comment",
      });
      return { outcome: "retry_queued" as const, queuedRun };
    }

    await patchRunIssueCommentStatus(run.id, {
      issueCommentStatus: "retry_exhausted",
      issueCommentSatisfiedByCommentId: null,
    });
    return { outcome: "retry_exhausted" as const, queuedRun: null };
  }

  async function repairIssueExecutionLock(
    tx: DbExecutor,
    issue: {
      id: string;
      companyId: string;
      executionRunId: string | null;
      executionAgentNameKey: string | null;
    },
    now = new Date(),
  ) {
    let activeExecutionRun = issue.executionRunId
      ? await tx
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, issue.executionRunId))
          .then((rows) => rows[0] ?? null)
      : null;

    if (activeExecutionRun && !LIVE_HEARTBEAT_RUN_STATUSES.includes(activeExecutionRun.status as "queued" | "running")) {
      activeExecutionRun = null;
    }

    if (!activeExecutionRun && issue.executionRunId) {
      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(eq(issues.id, issue.id));
    }

    if (activeExecutionRun) return activeExecutionRun;

    const legacyRun = await tx
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
        asc(heartbeatRuns.createdAt),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!legacyRun) return null;

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
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issue.id));

    return legacyRun;
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

  function parseHeartbeatPolicy(agent: typeof agents.$inferSelect) {
    const runtimeConfig = parseObject(agent.runtimeConfig);
    const heartbeat = parseObject(runtimeConfig.heartbeat);

    return {
      enabled: asBoolean(heartbeat.enabled, true),
      intervalSec: Math.max(0, asNumber(heartbeat.intervalSec, 0)),
      wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? heartbeat.wakeOnAssignment ?? heartbeat.wakeOnOnDemand ?? heartbeat.wakeOnAutomation, true),
      maxConcurrentRuns: normalizeMaxConcurrentRuns(heartbeat.maxConcurrentRuns),
      maxLiveRuns: normalizeMaxLiveRuns(heartbeat.maxLiveRuns ?? heartbeat.maxQueuedRuns),
    };
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
    const agent = await getAgent(run.agentId);
    if (!agent) {
      await cancelRunInternal(run.id, "Cancelled because the agent no longer exists");
      return null;
    }
    if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
      await cancelRunInternal(run.id, "Cancelled because the agent is not invokable");
      return null;
    }

    const companyStatus = await getCompanyStatus(run.companyId);
    if (!companyStatus) {
      await cancelRunInternal(run.id, "Cancelled because the company no longer exists");
      return null;
    }
    if (companyStatus === "paused") {
      // Company-level pause keeps queued work in place until resume.
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

    // Fix A (lazy locking): stamp executionRunId now that the run is actually running,
    // not at queue time. Guard is idempotent — safe if called more than once.
    const claimedIssueId = readNonEmptyString(parseObject(claimed.contextSnapshot).issueId);
    if (claimedIssueId) {
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
            or(isNull(issues.executionRunId), eq(issues.executionRunId, claimed.id)),
          ),
        );
    }

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

    const isFirstHeartbeat = !existing.lastHeartbeatAt;

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

    if (isFirstHeartbeat && updated) {
      const tc = getTelemetryClient();
      if (tc) trackAgentFirstHeartbeat(tc, { agentRole: updated.role });
    }

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

    // Find all runs stuck in "running" state (queued runs are legitimately waiting; resumeQueuedRuns handles them)
    const activeRuns = await db
      .select({
        run: heartbeatRuns,
        adapterType: agents.adapterType,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.status, "running"));

    const reaped: string[] = [];

    for (const { run, adapterType } of activeRuns) {
      if (runningProcesses.has(run.id) || activeRunExecutions.has(run.id)) continue;

      // Apply staleness threshold to avoid false positives
      if (staleThresholdMs > 0) {
        const refTime = run.updatedAt ? new Date(run.updatedAt).getTime() : 0;
        if (now.getTime() - refTime < staleThresholdMs) continue;
      }

      const tracksLocalChild = isTrackedLocalChildProcessAdapter(adapterType);
      if (tracksLocalChild && run.processPid && isProcessAlive(run.processPid)) {
        if (run.errorCode !== DETACHED_PROCESS_ERROR_CODE) {
          const detachedMessage = `Lost in-memory process handle, but child pid ${run.processPid} is still alive`;
          const detachedRun = await setRunStatus(run.id, "running", {
            error: detachedMessage,
            errorCode: DETACHED_PROCESS_ERROR_CODE,
          });
          if (detachedRun) {
            await appendRunEvent(detachedRun, await nextRunEventSeq(detachedRun.id), {
              eventType: "lifecycle",
              stream: "system",
              level: "warn",
              message: detachedMessage,
              payload: {
                processPid: run.processPid,
              },
            });
          }
        }
        continue;
      }

      const shouldRetry = tracksLocalChild && (run.processLossRetryCount ?? 0) < 1;
      const baseMessage = run.processPid
        ? `Process lost -- child pid ${run.processPid} is no longer running`
        : "Process lost -- server may have restarted";

      let finalizedRun = await setRunStatus(run.id, "failed", {
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
        errorCode: "process_lost",
        finishedAt: now,
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: now,
        error: shouldRetry ? `${baseMessage}; retrying once` : baseMessage,
      });
      if (!finalizedRun) finalizedRun = await getRun(run.id);
      if (!finalizedRun) continue;

      let retriedRun: typeof heartbeatRuns.$inferSelect | null = null;
      if (shouldRetry) {
        const agent = await getAgent(run.agentId);
        if (agent) {
          retriedRun = await enqueueProcessLossRetry(finalizedRun, agent, now);
        }
      } else {
        await releaseIssueExecutionAndPromote(finalizedRun);
      }

      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "error",
        message: shouldRetry
          ? `${baseMessage}; queued retry ${retriedRun?.id ?? ""}`.trim()
          : baseMessage,
        payload: {
          ...(run.processPid ? { processPid: run.processPid } : {}),
          ...(retriedRun ? { retryRunId: retriedRun.id } : {}),
        },
      });

      await finalizeAgentStatus(run.agentId, "failed");
      await startNextQueuedRunForAgent(run.agentId);
      runningProcesses.delete(run.id);
      reaped.push(run.id);
    }

    if (reaped.length > 0) {
      logger.warn({ reapedCount: reaped.length, runIds: reaped }, "reaped orphaned heartbeat runs");
    }

    const repairedIssueIds: string[] = [];
    const staleIssueLocks = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
      })
      .from(issues)
      .leftJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
      .where(
        and(
          sql`${issues.executionRunId} is not null`,
          sql`(${heartbeatRuns.id} is null or ${heartbeatRuns.status} not in ('queued', 'running'))`,
        ),
      );

    for (const staleIssue of staleIssueLocks) {
      const repaired = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select id from issues where id = ${staleIssue.id} and company_id = ${staleIssue.companyId} for update`,
        );

        const current = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            executionRunId: issues.executionRunId,
            executionAgentNameKey: issues.executionAgentNameKey,
          })
          .from(issues)
          .where(and(eq(issues.id, staleIssue.id), eq(issues.companyId, staleIssue.companyId)))
          .then((rows) => rows[0] ?? null);

        if (!current?.executionRunId) return false;

        const repairedRun = await repairIssueExecutionLock(tx, current, now);
        return repairedRun == null || repairedRun.id !== current.executionRunId;
      });

      if (repaired) repairedIssueIds.push(staleIssue.id);
    }

    if (repairedIssueIds.length > 0) {
      logger.warn(
        { repairedCount: repairedIssueIds.length, issueIds: repairedIssueIds },
        "repaired stale issue execution locks",
      );
    }

    return { reaped: reaped.length, runIds: reaped };
  }

  async function resumeQueuedRuns() {
    const queuedRuns = await db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));

    const agentIds = [...new Set(queuedRuns.map((r) => r.agentId))];
    for (const agentId of agentIds) {
      await startNextQueuedRunForAgent(agentId);
    }
  }

  async function updateRuntimeState(
    agent: typeof agents.$inferSelect,
    run: typeof heartbeatRuns.$inferSelect,
    result: AdapterExecutionResult,
    session: { legacySessionId: string | null },
    normalizedUsage?: UsageTotals | null,
  ) {
    await ensureRuntimeState(agent);
    const usage = normalizedUsage ?? normalizeUsageTotals(result.usage);
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const billingType = normalizeLedgerBillingType(result.billingType);
    const additionalCostCents = normalizeBilledCostCents(result.costUsd, billingType);
    const hasTokenUsage = inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0;
    const provider = result.provider ?? "unknown";
    const biller = resolveLedgerBiller(result);
    const ledgerScope = await resolveLedgerScopeForRun(db, agent.companyId, run);

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
      const costs = costService(db, budgetHooks);
      await costs.createEvent(agent.companyId, {
        heartbeatRunId: run.id,
        agentId: agent.id,
        issueId: ledgerScope.issueId,
        projectId: ledgerScope.projectId,
        provider,
        biller,
        billingType,
        model: result.model ?? "unknown",
        inputTokens,
        cachedInputTokens,
        outputTokens,
        costCents: additionalCostCents,
        occurredAt: new Date(),
      });
    }
  }

  async function startNextQueuedRunForAgent(agentId: string) {
    return withAgentStartLock(agentId, async () => {
      const agent = await getAgent(agentId);
      if (!agent) return [];
      if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
        return [];
      }
      const companyStatus = await getCompanyStatus(agent.companyId);
      if (companyStatus !== "active") return [];
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

  async function runOperationsHeartbeatSweep(input: {
    agent: typeof agents.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    const companyId = input.agent.companyId;
    const nowMs = Date.now();

    const [targets, boardRows, rawOpenAssignedIssues, rawOpenUnassignedIssues] = await Promise.all([
      resolveOperationsHeartbeatTargets(db, {
        companyId,
        operationsAgentId: input.agent.id,
      }),
      db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.companyId, companyId)),
      db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
          identifier: issues.identifier,
          title: issues.title,
          projectId: issues.projectId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeName: agents.name,
          assigneeRole: agents.role,
          assigneeStatus: agents.status,
        })
        .from(issues)
        .leftJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, issues.companyId)))
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
            sql`${issues.hiddenAt} is null`,
            sql`${issues.assigneeAgentId} is not null`,
          ),
        ),
      db
        .select({
          id: issues.id,
          status: issues.status,
          priority: issues.priority,
          identifier: issues.identifier,
          title: issues.title,
          projectId: issues.projectId,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.status, OPEN_ISSUE_STATUSES as unknown as string[]),
            sql`${issues.hiddenAt} is null`,
            sql`${issues.assigneeAgentId} is null`,
          ),
        )
        .orderBy(desc(issues.updatedAt)),
    ]);

    let openAssignedIssues = rawOpenAssignedIssues;
    let openUnassignedIssues = rawOpenUnassignedIssues;
    const recoveryCandidateIssueIds = Array.from(
      new Set([
        ...openAssignedIssues.map((issue) => issue.id),
        ...openUnassignedIssues.map((issue) => issue.id),
      ]),
    );
    if (recoveryCandidateIssueIds.length > 0) {
      const recoveredSourceRows = await db
        .select({ issueId: issueRelations.issueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "recovered_by"),
            inArray(issueRelations.issueId, recoveryCandidateIssueIds),
          ),
        );
      if (recoveredSourceRows.length > 0) {
        const recoveredSourceIssueIds = new Set(recoveredSourceRows.map((row) => row.issueId));
        openAssignedIssues = openAssignedIssues.filter((issue) => !recoveredSourceIssueIds.has(issue.id));
        openUnassignedIssues = openUnassignedIssues.filter((issue) => !recoveredSourceIssueIds.has(issue.id));
      }
    }
    const issueIds = openAssignedIssues.map((issue) => issue.id);
    const assigneeAgentIds = Array.from(
      new Set(openAssignedIssues.map((issue) => issue.assigneeAgentId).filter((id): id is string => Boolean(id))),
    );

    const [liveRunRows, latestAssigneeRunRows, latestCommentRows, latestNonOperationsCommentRows, latestOpsCommentRows] = await Promise.all([
      assigneeAgentIds.length > 0
        ? db
            .select({ agentId: heartbeatRuns.agentId })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                inArray(heartbeatRuns.agentId, assigneeAgentIds),
                // Queued runs have not resumed work yet and should not suppress idle wake-ups.
                inArray(
                  heartbeatRuns.status,
                  ACTIVE_ASSIGNEE_HEARTBEAT_RUN_STATUSES as unknown as string[],
                ),
              ),
            )
        : Promise.resolve([]),
      assigneeAgentIds.length > 0
        ? db
            .selectDistinctOn([heartbeatRuns.agentId], {
              agentId: heartbeatRuns.agentId,
              status: heartbeatRuns.status,
              finishedAt: heartbeatRuns.finishedAt,
              createdAt: heartbeatRuns.createdAt,
            })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                inArray(heartbeatRuns.agentId, assigneeAgentIds),
              ),
            )
            .orderBy(heartbeatRuns.agentId, desc(heartbeatRuns.createdAt))
        : Promise.resolve([]),
      issueIds.length > 0
        ? db
            .selectDistinctOn([issueComments.issueId], {
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(and(eq(issueComments.companyId, companyId), inArray(issueComments.issueId, issueIds)))
            .orderBy(issueComments.issueId, desc(issueComments.createdAt))
        : Promise.resolve([]),
      issueIds.length > 0
        ? db
            .selectDistinctOn([issueComments.issueId], {
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, companyId),
                inArray(issueComments.issueId, issueIds),
                sql`${issueComments.body} not like ${`${OPERATIONS_IDLE_WAKE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_RECOVERY_WAKE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_REQUEUE_MARKER}%`}`,
                sql`${issueComments.body} not like ${`${OPERATIONS_ASSIGNMENT_MARKER}%`}`,
              ),
            )
            .orderBy(issueComments.issueId, desc(issueComments.createdAt))
        : Promise.resolve([]),
      issueIds.length > 0
        ? db
            .selectDistinctOn([issueComments.issueId], {
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(
              and(
                eq(issueComments.companyId, companyId),
                eq(issueComments.authorAgentId, input.agent.id),
                inArray(issueComments.issueId, issueIds),
              ),
            )
            .orderBy(issueComments.issueId, desc(issueComments.createdAt))
        : Promise.resolve([]),
    ]);

    const activeAssigneeIds = new Set(liveRunRows.map((row) => row.agentId));
    const latestRunByAssigneeId = new Map(latestAssigneeRunRows.map((row) => [row.agentId, row]));
    const latestCommentByIssueId = new Map(latestCommentRows.map((row) => [row.issueId, row]));
    const latestNonOperationsCommentByIssueId = new Map(
      latestNonOperationsCommentRows.map((row) => [row.issueId, row]),
    );
    const effectiveLatestCommentByIssueId = new Map(
      issueIds.map((issueId) => [
        issueId,
        resolveOperationsTruthComment({
          latestComment: latestCommentByIssueId.get(issueId),
          latestNonOperationsComment: latestNonOperationsCommentByIssueId.get(issueId),
        }),
      ]),
    );
    const latestOpsCommentByIssueId = new Map(latestOpsCommentRows.map((row) => [row.issueId, row]));
    const autoReissueTargetIssueIds = new Set(
      targets
        .filter((target) => target.mode === "cross_agent_recovery" && target.autoReissueEligible)
        .map((target) => target.issueId),
    );

    const idleOwnedIssues = openAssignedIssues.filter((issue) => {
      if (autoReissueTargetIssueIds.has(issue.id)) return false;
      const assigneeAgentId = issue.assigneeAgentId;
      if (!assigneeAgentId) return false;
      if (assigneeAgentId === input.agent.id) return false;

      const assigneeUnavailable =
        issue.assigneeStatus === "paused" ||
        issue.assigneeStatus === "terminated" ||
        issue.assigneeStatus === "pending_approval";
      if (assigneeUnavailable) return false;
      if (activeAssigneeIds.has(assigneeAgentId)) return false;

      const latestComment = effectiveLatestCommentByIssueId.get(issue.id);
      const hasTruth =
        classifyIssueTruthFromCommentBody(latestComment?.body) !== null ||
        hasWaitStateTruthFromCommentBody(latestComment?.body);
      if (hasTruth) return false;

      const latestOpsComment = latestOpsCommentByIssueId.get(issue.id);
      if (!latestOpsComment?.body.includes(OPERATIONS_IDLE_WAKE_MARKER)) return true;
      const latestAssigneeRun = latestRunByAssigneeId.get(assigneeAgentId);
      const latestOpsWakeAtMs = latestOpsComment.createdAt.getTime();
      const assigneeFailedSinceLastWake = Boolean(
        latestAssigneeRun &&
        ["failed", "timed_out", "cancelled"].includes(latestAssigneeRun.status) &&
        (latestAssigneeRun.finishedAt?.getTime() ?? latestAssigneeRun.createdAt.getTime()) >= latestOpsWakeAtMs
      );
      const wakeCooldownMs =
        issue.assigneeStatus === "error" || assigneeFailedSinceLastWake
          ? OPERATIONS_RECOVERY_REWAKE_COOLDOWN_MS
          : OPERATIONS_IDLE_WAKE_COOLDOWN_MS;
      return nowMs - latestOpsComment.createdAt.getTime() >= wakeCooldownMs;
    });

    let wakeCommentCount = 0;
    let wakeupCount = 0;
    for (const issue of idleOwnedIssues) {
      const assigneeAgentId = issue.assigneeAgentId;
      if (!assigneeAgentId) continue;

      try {
        await issuesSvc.addComment(
          issue.id,
          buildOperationsIdleWakeComment({
            assigneeAgentId,
            assigneeName: issue.assigneeName,
          }),
          { agentId: input.agent.id, runId: input.run.id },
        );
        wakeCommentCount += 1;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, assigneeAgentId },
          "operations heartbeat failed to post idle wake comment",
        );
      }

      try {
        await enqueueWakeup(assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "operations_idle_assignment_wakeup",
          payload: {
            issueId: issue.id,
            mutation: "operations_idle_assignment_wakeup",
            sourceRunId: input.run.id,
          },
          requestedByActorType: "agent",
          requestedByActorId: input.agent.id,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            source: "operations.heartbeat",
            wakeReason: "operations_idle_assignment_wakeup",
          },
        });
        wakeupCount += 1;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, assigneeAgentId },
          "operations heartbeat failed to enqueue idle assignee wakeup",
        );
      }
    }

    let recoveryCommentCount = 0;
    let recoveryWakeupCount = 0;
    let recoveryReissueCount = 0;
    let recoveryReissueWakeupCount = 0;
    let requeuedOperationsIssueCount = 0;
    let assignedIssueCount = 0;
    let assignmentCommentCount = 0;
    let assignmentWakeupCount = 0;
    const recoveryReissueTargets: Array<{
      issue: (typeof openAssignedIssues)[number];
      reason: string;
    }> = [];
    const idleHandledIssueIds = new Set(idleOwnedIssues.map((issue) => issue.id));
    const openAssignedIssueById = new Map(openAssignedIssues.map((issue) => [issue.id, issue]));
    const targetReasonByIssueId = new Map<string, string>();
    const opsActiveTargetIssueIdsForAssignment = new Set<string>();

    const requestCrossAgentRecoveryWake = async (targetIssue: (typeof openAssignedIssues)[number], reason: string) => {
      if (!targetIssue.assigneeAgentId) return;
      if (!isAgentInvokableStatus(targetIssue.assigneeStatus)) return;

      try {
        await issuesSvc.addComment(
          targetIssue.id,
          buildOperationsRecoveryWakeComment({
            assigneeAgentId: targetIssue.assigneeAgentId,
            assigneeName: targetIssue.assigneeName,
            reason,
          }),
          { agentId: input.agent.id, runId: input.run.id },
        );
        recoveryCommentCount += 1;
      } catch (err) {
        logger.warn(
          { err, issueId: targetIssue.id, assigneeAgentId: targetIssue.assigneeAgentId },
          "operations heartbeat failed to post recovery wake comment",
        );
      }

      try {
        await enqueueWakeup(targetIssue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "operations_cross_agent_recovery",
          payload: {
            issueId: targetIssue.id,
            mutation: "operations_cross_agent_recovery",
            sourceRunId: input.run.id,
          },
          requestedByActorType: "agent",
          requestedByActorId: input.agent.id,
          contextSnapshot: {
            issueId: targetIssue.id,
            taskId: targetIssue.id,
            source: "operations.heartbeat",
            wakeReason: "operations_cross_agent_recovery",
          },
        });
        recoveryWakeupCount += 1;
      } catch (err) {
        if (isAgentNotInvokableConflict(err)) return;
        logger.warn(
          { err, issueId: targetIssue.id, assigneeAgentId: targetIssue.assigneeAgentId },
          "operations heartbeat failed to enqueue cross-agent recovery wakeup",
        );
      }
    };
    for (const target of targets) {
      if (!targetReasonByIssueId.has(target.issueId)) {
        targetReasonByIssueId.set(target.issueId, target.reason);
      }
      if (target.mode !== "ops_active") continue;
      const targetIssue = openAssignedIssueById.get(target.issueId);
      if (!targetIssue) continue;
      if (targetIssue.assigneeAgentId !== input.agent.id) continue;
      if (isWatchdogIssueLabel(`${targetIssue.identifier ?? ""} ${targetIssue.title}`)) continue;
      opsActiveTargetIssueIdsForAssignment.add(targetIssue.id);
    }

    const handledTargetIssueIds = new Set<string>();
    for (const target of targets) {
      if (handledTargetIssueIds.has(target.issueId)) continue;
      const targetIssue = openAssignedIssueById.get(target.issueId) ?? null;
      if (!targetIssue) continue;
      if (idleHandledIssueIds.has(targetIssue.id)) {
        handledTargetIssueIds.add(targetIssue.id);
        continue;
      }
      const latestOpsTargetComment = latestOpsCommentByIssueId.get(targetIssue.id);
      const assigneeUnavailableForRecovery =
        targetIssue.assigneeStatus === "error" ||
        targetIssue.assigneeStatus === "paused" ||
        targetIssue.assigneeStatus === "terminated" ||
        targetIssue.assigneeStatus === "pending_approval";
      const shouldAutoReissueTarget =
        target.mode === "cross_agent_recovery" &&
        Boolean(targetIssue.assigneeAgentId) &&
        (target.autoReissueEligible || assigneeUnavailableForRecovery);
      const targetRecoveryCooldownActive =
        !shouldAutoReissueTarget &&
        Boolean(
          latestOpsTargetComment?.body
          && (
          latestOpsTargetComment.body.includes(OPERATIONS_RECOVERY_WAKE_MARKER)
          || latestOpsTargetComment.body.includes(OPERATIONS_REQUEUE_MARKER)
          ) &&
          nowMs - latestOpsTargetComment.createdAt.getTime() < OPERATIONS_IDLE_WAKE_COOLDOWN_MS,
        );
      if (targetRecoveryCooldownActive) {
        handledTargetIssueIds.add(targetIssue.id);
        continue;
      }
      handledTargetIssueIds.add(targetIssue.id);

      if (target.mode === "cross_agent_recovery" && targetIssue.assigneeAgentId) {
        if (shouldAutoReissueTarget) {
          recoveryReissueTargets.push({
            issue: targetIssue,
            reason: target.reason,
          });
          continue;
        }
        await requestCrossAgentRecoveryWake(targetIssue, target.reason);
      }

      if (
        target.mode === "ops_active"
        && targetIssue.assigneeAgentId === input.agent.id
        && !isWatchdogIssueLabel(`${targetIssue.identifier ?? ""} ${targetIssue.title}`)
      ) {
        try {
          await issuesSvc.addComment(
            targetIssue.id,
            buildOperationsRequeueComment({ reason: target.reason }),
            { agentId: input.agent.id, runId: input.run.id },
          );
        } catch (err) {
          logger.warn({ err, issueId: targetIssue.id }, "operations heartbeat failed to post requeue comment");
        }

        try {
          await issuesSvc.update(targetIssue.id, {
            assigneeAgentId: null,
            ...(targetIssue.status === "in_progress" ? { status: "todo" } : {}),
            actorAgentId: input.agent.id,
          });
          requeuedOperationsIssueCount += 1;
        } catch (err) {
          logger.warn({ err, issueId: targetIssue.id }, "operations heartbeat failed to requeue ops-owned issue");
        }
      }
    }

    const misassignedEngineeringIssues = openAssignedIssues.filter((issue) => {
      if (!issue.assigneeAgentId) return false;
      if (issue.assigneeAgentId === input.agent.id) return false;
      if (isWatchdogIssueLabel(`${issue.identifier ?? ""} ${issue.title}`)) return false;
      if (!ENGINEERING_ASSIGNMENT_REBALANCE_PATTERN.test(`${issue.identifier ?? ""} ${issue.title}`)) return false;
      return issue.assigneeRole !== "engineer";
    });
    for (const issue of misassignedEngineeringIssues) {
      try {
        await issuesSvc.addComment(
          issue.id,
          buildOperationsRequeueComment({
            reason: "engineering task was assigned to non-engineering role; requeueing for engineer assignment",
          }),
          { agentId: input.agent.id, runId: input.run.id },
        );
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "operations heartbeat failed to post misassignment requeue comment");
      }

      try {
        await issuesSvc.update(issue.id, {
          assigneeAgentId: null,
          ...(issue.status === "in_progress" ? { status: "todo" } : {}),
          actorAgentId: input.agent.id,
        });
        requeuedOperationsIssueCount += 1;
        opsActiveTargetIssueIdsForAssignment.add(issue.id);
      } catch (err) {
        logger.warn({ err, issueId: issue.id }, "operations heartbeat failed to requeue misassigned engineering issue");
      }
    }

    const availableAssignmentCandidates = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        capabilities: agents.capabilities,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => (
        row.id !== input.agent.id &&
        row.status !== "paused" &&
        row.status !== "terminated" &&
        row.status !== "pending_approval" &&
        !isOrchestratorOnlyAgent(row)
      )));
    const pausedFallbackAssignmentCandidates = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        capabilities: agents.capabilities,
        status: agents.status,
        runtimeConfig: agents.runtimeConfig,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .then((rows) => rows.filter((row) => (
        row.id !== input.agent.id &&
        row.status !== "terminated" &&
        row.status !== "pending_approval" &&
        !isOrchestratorOnlyAgent(row)
      )));

    function pickAssignmentCandidate(issue: {
      id: string;
      identifier: string | null;
      title: string;
      projectId: string | null;
    }, opts?: { excludeAgentId?: string | null; allowPausedFallback?: boolean }) {
      const sameProjectCounts = new Map<string, number>();
      for (const candidateIssue of openAssignedIssues) {
        if (!candidateIssue.assigneeAgentId) continue;
        if (candidateIssue.projectId !== issue.projectId) continue;
        sameProjectCounts.set(
          candidateIssue.assigneeAgentId,
          (sameProjectCounts.get(candidateIssue.assigneeAgentId) ?? 0) + 1,
        );
      }

      const issueText = `${issue.identifier ?? ""} ${issue.title}`.toLowerCase();
      const isQaLikeIssue = /\bqa|release|audit|verify|test\b/.test(issueText);
      const isLeadLikeIssue = /\blead|restaurant|prospect|sheet\b/.test(issueText);
      const isOnboardingLikeIssue = /\bonboard|onboarding|go[- ]?live|activation|rollout|intake|implementation\b/.test(issueText);
      const isEngineeringIssue = ENGINEERING_ASSIGNMENT_REBALANCE_PATTERN.test(issueText);
      const isAppLikeEngineeringIssue = /\bcart|checkout|client|frontend|ui|app|mobile|react|screen|component\b/.test(issueText);
      const isWebLikeEngineeringIssue = /\bweb|browser|page|route|view\b/.test(issueText);
      const isPlatformLikeEngineeringIssue = /\bplatform|infra|runtime|pipeline|orchestr|migration|database|server|backend|auth|api\b/.test(issueText);
      const profileText = (candidate: {
        name: string;
        title: string | null;
        capabilities: string | null;
      }) => `${candidate.name ?? ""} ${candidate.title ?? ""} ${candidate.capabilities ?? ""}`.toLowerCase();
      const healthyCandidates = availableAssignmentCandidates.filter((candidate) => candidate.status !== "error");
      let baseCandidatePool = healthyCandidates.length > 0 ? healthyCandidates : availableAssignmentCandidates;
      if (baseCandidatePool.length === 0 && opts?.allowPausedFallback) {
        const pausedFallbackHealthyCandidates = pausedFallbackAssignmentCandidates.filter((candidate) => candidate.status !== "error");
        baseCandidatePool =
          pausedFallbackHealthyCandidates.length > 0
            ? pausedFallbackHealthyCandidates
            : pausedFallbackAssignmentCandidates;
      }
      const isReadyCandidate = (candidate: { status: string | null }) => (
        candidate.status !== "error" &&
        candidate.status !== "paused" &&
        candidate.status !== "terminated" &&
        candidate.status !== "pending_approval"
      );
      const specializationSourcePool = opts?.allowPausedFallback
        ? pausedFallbackAssignmentCandidates
        : availableAssignmentCandidates;
      if (isEngineeringIssue) {
        const engineerCandidates = specializationSourcePool.filter((candidate) => candidate.role === "engineer");
        if (engineerCandidates.length === 0) return null;

        const readyEngineers = engineerCandidates.filter(isReadyCandidate);
        if (readyEngineers.length === 0) return null;
        const appEngineerCandidates = engineerCandidates.filter((candidate) => (
          /\bproduct engineer - app\b|\bapp\b|frontend|react|mobile|ios|android|client/.test(profileText(candidate))
        ));
        const webEngineerCandidates = engineerCandidates.filter((candidate) => (
          /\bproduct engineer - web\b|\bweb\b|frontend|react|browser|ui/.test(profileText(candidate))
        ));
        const platformEngineerCandidates = engineerCandidates.filter((candidate) => (
          /\bplatform\b|infra|backend|server|runtime|devops|database/.test(profileText(candidate))
        ));

        const preferReadySpecialists = (specialists: typeof engineerCandidates) => {
          const readySpecialists = specialists.filter(isReadyCandidate);
          return readySpecialists.length > 0 ? readySpecialists : readyEngineers;
        };

        if (isAppLikeEngineeringIssue) {
          baseCandidatePool = preferReadySpecialists(appEngineerCandidates);
        } else if (isWebLikeEngineeringIssue) {
          baseCandidatePool = preferReadySpecialists(webEngineerCandidates);
        } else if (isPlatformLikeEngineeringIssue) {
          baseCandidatePool = preferReadySpecialists(platformEngineerCandidates);
        } else {
          baseCandidatePool = readyEngineers;
        }
      }
      const preferredCandidatePool = opts?.excludeAgentId
        ? baseCandidatePool.filter((candidate) => candidate.id !== opts.excludeAgentId)
        : baseCandidatePool;
      const candidatePool = preferredCandidatePool.length > 0 ? preferredCandidatePool : baseCandidatePool;

      const ranked = candidatePool
        .map((candidate) => {
          const sameProjectLoad = sameProjectCounts.get(candidate.id) ?? 0;
          let score = Math.min(sameProjectLoad, 2) * 20;
          const candidateText = profileText(candidate);

          if (candidate.status === "idle") score += 25;
          else if (candidate.status === "running") score += 10;
          else if (candidate.status === "error") score -= 200;

          if (isQaLikeIssue) {
            if (candidate.role === "qa" || /\bqa|release\b/.test(candidateText)) score += 120;
          } else if (isLeadLikeIssue) {
            if (candidate.role === "researcher" || /lead generation|sales/.test(candidateText)) score += 120;
          } else if (isOnboardingLikeIssue) {
            if (candidate.role === "pm" || /\bonboarding|implementation|project manager\b/.test(candidateText)) score += 120;
          } else if (candidate.role === "engineer" || /\bengineer|app|web|platform|frontend|backend\b/.test(candidateText)) {
            score += 140;
          } else {
            score -= 80;
          }

          return { candidate, score };
        })
        .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name));

      return ranked[0]?.candidate ?? null;
    }

    for (const reissueTarget of recoveryReissueTargets) {
      const sourceIssue = await issuesSvc.getById(reissueTarget.issue.id);
      if (!sourceIssue) continue;
      const candidate = pickAssignmentCandidate(
        {
          id: sourceIssue.id,
          identifier: sourceIssue.identifier,
          title: sourceIssue.title,
          projectId: sourceIssue.projectId,
        },
        { excludeAgentId: reissueTarget.issue.assigneeAgentId, allowPausedFallback: true },
      );
      if (!candidate || !isAgentInvokableStatus(candidate.status)) {
        await requestCrossAgentRecoveryWake(reissueTarget.issue, reissueTarget.reason);
        continue;
      }

      try {
        const continuation = await issuesSvc.create(companyId, {
          projectId: sourceIssue.projectId ?? undefined,
          projectWorkspaceId: sourceIssue.projectWorkspaceId ?? undefined,
          goalId: sourceIssue.goalId ?? undefined,
          parentId: sourceIssue.parentId ?? undefined,
          inheritExecutionWorkspaceFromIssueId: sourceIssue.id,
          title: sourceIssue.title,
          description: sourceIssue.description ?? undefined,
          status: "todo",
          priority: sourceIssue.priority,
          assigneeAgentId: candidate.id,
          assigneeUserId: null,
          ...(Array.isArray(sourceIssue.labelIds) ? { labelIds: sourceIssue.labelIds } : {}),
          recoveryFromIssueId: sourceIssue.id,
          recoveryDisposition: "superseded",
          createdByAgentId: input.agent.id,
        });
        recoveryReissueCount += 1;

        try {
          await issuesSvc.addComment(
            continuation.id,
            buildOperationsAssignmentComment({
              assigneeAgentId: candidate.id,
              assigneeName: candidate.name,
              reason: `recovery reissue from ${sourceIssue.identifier ?? sourceIssue.id}: ${reissueTarget.reason}`,
            }),
            { agentId: input.agent.id, runId: input.run.id },
          );
          assignmentCommentCount += 1;
        } catch (err) {
          logger.warn(
            { err, issueId: continuation.id, assigneeAgentId: candidate.id },
            "operations heartbeat failed to post recovery reissue assignment comment",
          );
        }

        try {
          await enqueueWakeup(candidate.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "operations_recovery_reissue",
            payload: {
              issueId: continuation.id,
              sourceIssueId: sourceIssue.id,
              mutation: "operations_recovery_reissue",
              sourceRunId: input.run.id,
            },
            requestedByActorType: "agent",
            requestedByActorId: input.agent.id,
            contextSnapshot: {
              issueId: continuation.id,
              sourceIssueId: sourceIssue.id,
              taskId: continuation.id,
              source: "operations.heartbeat",
              wakeReason: "operations_recovery_reissue",
            },
          });
          recoveryReissueWakeupCount += 1;
        } catch (err) {
          if (isAgentNotInvokableConflict(err)) continue;
          logger.warn(
            { err, issueId: continuation.id, assigneeAgentId: candidate.id },
            "operations heartbeat failed to enqueue recovery reissue wakeup",
          );
        }
      } catch (err) {
        logger.warn(
          { err, issueId: sourceIssue.id, assigneeAgentId: candidate.id },
          "operations heartbeat failed to create recovery continuation issue",
        );
        await requestCrossAgentRecoveryWake(reissueTarget.issue, reissueTarget.reason);
      }
    }

    const issuesNeedingAssignment = [
      ...openUnassignedIssues,
      ...Array.from(opsActiveTargetIssueIdsForAssignment).flatMap((issueId) => {
        const issue = openAssignedIssueById.get(issueId);
        if (!issue) return [];
        return [{
          id: issue.id,
          status: issue.status,
          identifier: issue.identifier,
          title: issue.title,
          projectId: issue.projectId,
        }];
      }),
    ];
    const assignedIssueIds = new Set<string>();

    for (const issue of issuesNeedingAssignment) {
      if (assignedIssueIds.has(issue.id)) continue;
      const candidate = pickAssignmentCandidate(issue);
      if (!candidate) continue;

      try {
        await issuesSvc.update(issue.id, {
          assigneeAgentId: candidate.id,
          ...(issue.status === "backlog" ? { status: "todo" } : {}),
          actorAgentId: input.agent.id,
        });
        assignedIssueCount += 1;
        assignedIssueIds.add(issue.id);
      } catch (err) {
        logger.warn({ err, issueId: issue.id, assigneeAgentId: candidate.id }, "operations heartbeat failed to assign issue");
        continue;
      }

      try {
        await issuesSvc.addComment(
          issue.id,
          buildOperationsAssignmentComment({
            assigneeAgentId: candidate.id,
            assigneeName: candidate.name,
            reason: targetReasonByIssueId.get(issue.id) ?? "ready unassigned work requires ownership",
          }),
          { agentId: input.agent.id, runId: input.run.id },
        );
        assignmentCommentCount += 1;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, assigneeAgentId: candidate.id },
          "operations heartbeat failed to post assignment comment",
        );
      }

      try {
        await enqueueWakeup(candidate.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "operations_assignment",
          payload: {
            issueId: issue.id,
            mutation: "operations_assignment",
            sourceRunId: input.run.id,
          },
          requestedByActorType: "agent",
          requestedByActorId: input.agent.id,
          contextSnapshot: {
            issueId: issue.id,
            taskId: issue.id,
            source: "operations.heartbeat",
            wakeReason: "operations_assignment",
          },
        });
        assignmentWakeupCount += 1;
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, assigneeAgentId: candidate.id },
          "operations heartbeat failed to enqueue assignment wakeup",
        );
      }
    }

    const primaryTarget = targets[0] ?? null;

    return {
      target: primaryTarget,
      sweep: {
        boardCount: boardRows.length,
        assignedOpenCount: openAssignedIssues.length,
        unassignedOpenCount: openUnassignedIssues.length,
        idleOwnedAssignedCount: idleOwnedIssues.length,
        wakeCommentCount,
        wakeupCount,
        recoveryCommentCount,
        recoveryWakeupCount,
        recoveryReissueCount,
        recoveryReissueWakeupCount,
        requeuedOperationsIssueCount,
        assignedIssueCount,
        assignmentCommentCount,
        assignmentWakeupCount,
      },
    };
  }

  async function finalizeOperationsOrchestratorRun(input: {
    agent: typeof agents.$inferSelect;
    run: typeof heartbeatRuns.$inferSelect;
    context: Record<string, unknown>;
    issueId: string | null;
  }) {
    const operationsHeartbeatSweep = parseObject(input.context.operationsHeartbeatSweep);
    const blockedTargetIssueId =
      Number(operationsHeartbeatSweep.recoveryCommentCount ?? 0) > 0
      || Number(operationsHeartbeatSweep.recoveryWakeupCount ?? 0) > 0
      || Number(operationsHeartbeatSweep.recoveryReissueCount ?? 0) > 0
      || Number(operationsHeartbeatSweep.recoveryReissueWakeupCount ?? 0) > 0
      || Number(operationsHeartbeatSweep.requeuedOperationsIssueCount ?? 0) > 0
        ? null
        : (readNonEmptyString(operationsHeartbeatSweep.targetIssueId) ?? input.issueId);
    const resultJson = sanitizePostgresTextValue({
      mode: "orchestrator_only",
      specialistExecutionBlocked: true,
      blockedIssueId: blockedTargetIssueId,
      operationsHeartbeatSweep,
    });

    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: sanitizePostgresTextValue(input.context),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, input.run.id));

    const finalizedRun = await setRunStatus(input.run.id, "succeeded", {
      finishedAt: new Date(),
      error: null,
      resultJson,
    });

    await setWakeupStatus(input.run.wakeupRequestId, "completed", {
      finishedAt: new Date(),
      error: null,
    });

    if (finalizedRun) {
      await appendRunEvent(finalizedRun, await nextRunEventSeq(finalizedRun.id), {
        eventType: "lifecycle",
        stream: "system",
        level: "info",
        message:
          blockedTargetIssueId
            ? "operations run completed orchestration-only sweep; specialist issue execution was blocked"
            : "operations run completed orchestration-only sweep",
        payload: {
          blockedIssueId: blockedTargetIssueId,
          operationsHeartbeatSweep,
        },
      });
      await finalizeIssueCommentPolicy(finalizedRun, input.agent);
      await releaseIssueExecutionAndPromote(finalizedRun);
      await updateRuntimeState(
        input.agent,
        finalizedRun,
        {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          resultJson,
          provider: "paperclip",
          biller: "paperclip",
          model: "operations-orchestrator",
          billingType: "fixed",
          costUsd: 0,
          summary: "Operations run completed without adapter execution.",
        },
        { legacySessionId: null },
        null,
      );
    }

    await finalizeAgentStatus(input.agent.id, "succeeded");
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

    if (run.wakeupRequestId) {
      const wakeupRequest = await db
        .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, run.wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      const payload = parseObject(wakeupRequest?.payload);
      const payloadIssueId = readNonEmptyString(payload.issueId);
      if (!readNonEmptyString(context.wakeReason) && wakeupRequest?.reason) {
        context.wakeReason = wakeupRequest.reason;
      }
      if (!readNonEmptyString(context.issueId) && payloadIssueId) {
        context.issueId = payloadIssueId;
      }
      if (!readNonEmptyString(context.taskId) && payloadIssueId) {
        context.taskId = payloadIssueId;
      }
    }

    let issueId = readNonEmptyString(context.issueId);

    if (isOperationsOrchestratorAgent(agent)) {
      const operationsSweep = await runOperationsHeartbeatSweep({ agent, run });
      context.operationsHeartbeatSweep = {
        ...operationsSweep.sweep,
        targetIssueId: operationsSweep.target?.issueId ?? null,
        targetMode: operationsSweep.target?.mode ?? null,
        targetReason: operationsSweep.target?.reason ?? null,
      };
      await finalizeOperationsOrchestratorRun({
        agent,
        run,
        context,
        issueId,
      });
      return;
    }

    const wakeReason = readNonEmptyString(context.wakeReason);

    if (wakeReason === "issue_assigned" && !issueId) {
      const errorMessage = "missing assigned issue context";
      await setRunStatus(runId, "failed", {
        error: errorMessage,
        errorCode: "missing_assigned_issue_context",
        finishedAt: new Date(),
      });
      await setWakeupStatus(run.wakeupRequestId, "failed", {
        finishedAt: new Date(),
        error: errorMessage,
      });
      const failedRun = await getRun(runId);
      if (failedRun) await releaseIssueExecutionAndPromote(failedRun);
      return;
    }

    const taskKey = deriveTaskKeyWithHeartbeatFallback(context, null);
    const sessionCodec = getAdapterSessionCodec(agent.adapterType);
    const issueContext = issueId
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            executionWorkspaceId: issues.executionWorkspaceId,
            executionWorkspacePreference: issues.executionWorkspacePreference,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
            executionWorkspaceSettings: issues.executionWorkspaceSettings,
          })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    if (issueContext?.identifier && !readNonEmptyString(context.issueIdentifier)) {
      context.issueIdentifier = issueContext.identifier;
    }

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
    const projectContext = executionProjectId
      ? await db
          .select({
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
            env: projects.env,
          })
          .from(projects)
          .where(and(eq(projects.id, executionProjectId), eq(projects.companyId, agent.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const projectExecutionWorkspacePolicy = gateProjectExecutionWorkspacePolicy(
      parseProjectExecutionWorkspacePolicy(projectContext?.executionWorkspacePolicy),
      isolatedWorkspacesEnabled,
    );
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
    const mappedAgentAdapterConfig = mapHermesCommandForRuntimeConfig(agent.adapterType, config);
    const requestedExecutionWorkspaceMode = resolveExecutionWorkspaceMode({
      projectPolicy: projectExecutionWorkspacePolicy,
      issueSettings: issueExecutionWorkspaceSettings,
      legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
    });
    const resolvedWorkspace = await resolveWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      { useProjectWorkspace: requestedExecutionWorkspaceMode !== "agent_default" },
    );
    const issueRef = issueContext
      ? {
          id: issueContext.id,
          identifier: issueContext.identifier,
          title: issueContext.title,
          status: issueContext.status,
          priority: issueContext.priority,
          projectId: issueContext.projectId,
          projectWorkspaceId: issueContext.projectWorkspaceId,
          executionWorkspaceId: issueContext.executionWorkspaceId,
          executionWorkspacePreference: issueContext.executionWorkspacePreference,
        }
      : null;
    const paperclipWakePayload = await buildPaperclipWakePayload({
      db,
      companyId: agent.companyId,
      contextSnapshot: context,
      issueSummary: issueRef
        ? {
            id: issueRef.id,
            identifier: issueRef.identifier,
            title: issueRef.title,
            status: issueRef.status,
            priority: issueRef.priority,
          }
        : null,
    });
    if (paperclipWakePayload) {
      context[PAPERCLIP_WAKE_PAYLOAD_KEY] = paperclipWakePayload;
    } else {
      delete context[PAPERCLIP_WAKE_PAYLOAD_KEY];
    }
    const existingExecutionWorkspace =
      issueRef?.executionWorkspaceId ? await executionWorkspacesSvc.getById(issueRef.executionWorkspaceId) : null;
    const shouldReuseExisting =
      issueRef?.executionWorkspacePreference === "reuse_existing" &&
      existingExecutionWorkspace &&
      existingExecutionWorkspace.status !== "archived";
    const persistedExecutionWorkspaceMode = shouldReuseExisting && existingExecutionWorkspace
      ? issueExecutionWorkspaceModeForPersistedWorkspace(existingExecutionWorkspace.mode)
      : null;
    const effectiveExecutionWorkspaceMode: ReturnType<typeof resolveExecutionWorkspaceMode> =
      persistedExecutionWorkspaceMode === "isolated_workspace" ||
      persistedExecutionWorkspaceMode === "operator_branch" ||
      persistedExecutionWorkspaceMode === "agent_default"
        ? persistedExecutionWorkspaceMode
        : requestedExecutionWorkspaceMode;
    const workspaceManagedConfig = shouldReuseExisting
      ? { ...mappedAgentAdapterConfig }
      : buildExecutionWorkspaceAdapterConfig({
          agentConfig: mappedAgentAdapterConfig,
          projectPolicy: projectExecutionWorkspacePolicy,
          issueSettings: issueExecutionWorkspaceSettings,
          mode: requestedExecutionWorkspaceMode,
          legacyUseProjectWorkspace: issueAssigneeOverrides?.useProjectWorkspace ?? null,
        });
    const persistedWorkspaceManagedConfig = applyPersistedExecutionWorkspaceConfig({
      config: workspaceManagedConfig,
      workspaceConfig: existingExecutionWorkspace?.config ?? null,
      mode: effectiveExecutionWorkspaceMode,
    });
    const mergedConfig = issueAssigneeOverrides?.adapterConfig
      ? { ...persistedWorkspaceManagedConfig, ...issueAssigneeOverrides.adapterConfig }
      : persistedWorkspaceManagedConfig;
    const configSnapshot = buildExecutionWorkspaceConfigSnapshot(mergedConfig);
    const executionRunConfig = stripWorkspaceRuntimeFromExecutionRunConfig(mergedConfig);
    const { resolvedConfig, secretKeys } = await resolveExecutionRunAdapterConfig({
      companyId: agent.companyId,
      executionRunConfig,
      projectEnv: projectContext?.env ?? null,
      secretsSvc,
    });
    const runtimeSkillEntries = await companySkills.listRuntimeSkillEntries(agent.companyId);
    const runtimeConfig = mapHermesCommandForRuntimeConfig(
      agent.adapterType,
      {
        ...resolvedConfig,
        paperclipRuntimeSkills: runtimeSkillEntries,
      },
    );
    const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
      companyId: agent.companyId,
      heartbeatRunId: run.id,
      executionWorkspaceId: existingExecutionWorkspace?.id ?? null,
    });
    const executionWorkspaceBase = {
      baseCwd: resolvedWorkspace.cwd,
      source: resolvedWorkspace.source,
      projectId: resolvedWorkspace.projectId,
      workspaceId: resolvedWorkspace.workspaceId,
      repoUrl: resolvedWorkspace.repoUrl,
      repoRef: resolvedWorkspace.repoRef,
    } satisfies ExecutionWorkspaceInput;
    const reusedExecutionWorkspace = shouldReuseExisting && existingExecutionWorkspace
      ? buildRealizedExecutionWorkspaceFromPersisted({
          base: executionWorkspaceBase,
          workspace: existingExecutionWorkspace,
        })
      : null;
    const executionWorkspace = reusedExecutionWorkspace ?? await realizeExecutionWorkspace({
          base: executionWorkspaceBase,
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
    let persistedExecutionWorkspace = null;
    const nextExecutionWorkspaceMetadataBase = {
      ...(existingExecutionWorkspace?.metadata ?? {}),
      source: executionWorkspace.source,
      createdByRuntime: executionWorkspace.created,
    } as Record<string, unknown>;
    const nextExecutionWorkspaceMetadata = shouldReuseExisting
      ? nextExecutionWorkspaceMetadataBase
      : configSnapshot
        ? mergeExecutionWorkspaceConfig(nextExecutionWorkspaceMetadataBase, configSnapshot)
        : nextExecutionWorkspaceMetadataBase;
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
            metadata: nextExecutionWorkspaceMetadata,
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                requestedExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : requestedExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : requestedExecutionWorkspaceMode === "agent_default"
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
              metadata: nextExecutionWorkspaceMetadata,
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
            cleanupCommand: configSnapshot?.cleanupCommand ?? null,
            teardownCommand: configSnapshot?.teardownCommand ?? projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ?? null,
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
        requestedExecutionWorkspaceMode === "isolated_workspace" ||
        requestedExecutionWorkspaceMode === "operator_branch";
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
    const runtimeSessionParams = sanitizeRuntimeSessionParams(runtimeSessionResolution.sessionParams);
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
    context.paperclipWorkspace = {
      cwd: executionWorkspace.cwd,
      source: executionWorkspace.source,
      mode: effectiveExecutionWorkspaceMode,
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
    context.paperclipWorkspaces = resolvedWorkspace.workspaceHints;
    const runtimeServiceIntents = (() => {
      const runtimeConfig = parseObject(resolvedConfig.workspaceRuntime);
      return Array.isArray(runtimeConfig.services)
        ? runtimeConfig.services.filter(
            (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
          )
        : [];
    })();
    if (runtimeServiceIntents.length > 0) {
      context.paperclipRuntimeServiceIntents = runtimeServiceIntents;
    } else {
      delete context.paperclipRuntimeServiceIntents;
    }
    if (executionWorkspace.projectId && !readNonEmptyString(context.projectId)) {
      context.projectId = executionWorkspace.projectId;
    }
    const runtimeSessionFallback = null;
    let previousSessionDisplayId = sanitizeRuntimeSessionDisplayId(
      explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId ? sessionCodec.getDisplayId(runtimeSessionParams) : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback,
    );
    let runtimeSessionIdForAdapter =
      sanitizeRuntimeSessionDisplayId(readNonEmptyString(runtimeSessionParams?.sessionId) ?? runtimeSessionFallback);
    let runtimeSessionParamsForAdapter = runtimeSessionParams;

    const sessionCompaction = await evaluateSessionCompaction({
      agent,
      sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
      issueId,
    });
    if (sessionCompaction.rotate) {
      context.paperclipSessionHandoffMarkdown = sessionCompaction.handoffMarkdown;
      context.paperclipSessionRotationReason = sessionCompaction.reason;
      context.paperclipPreviousSessionId = previousSessionDisplayId ?? runtimeSessionIdForAdapter;
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      if (sessionCompaction.reason) {
        runtimeWorkspaceWarnings.push(
          `Starting a fresh session because ${sessionCompaction.reason}.`,
        );
      }
    } else {
      delete context.paperclipSessionHandoffMarkdown;
      delete context.paperclipSessionRotationReason;
      delete context.paperclipPreviousSessionId;
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
          contextSnapshot: sanitizePostgresTextValue(context),
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

      const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
      const onLog = async (stream: "stdout" | "stderr", chunk: string) => {
        const sanitizedChunk = stripPostgresTextNullBytes(
          redactCurrentUserText(chunk, currentUserRedactionOptions),
        );
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
      await onLog("stdout", `[context] wake_reason=${wakeReason ?? ""}\n`);
      if (issueId) {
        await onLog("stdout", `[context] issue_id=${issueId}\n`);
      }

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
        context.paperclipRuntimeServices = runtimeServices;
        context.paperclipRuntimePrimaryUrl =
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
            { agentId: agent.id, runId: run.id },
          );
        } catch (err) {
          await onLog(
            "stderr",
            `[paperclip] Failed to post workspace-ready comment: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
      const onAdapterMeta = async (meta: AdapterInvocationMeta) => {
        if (meta.env && secretKeys.size > 0) {
          for (const key of secretKeys) {
            if (key in meta.env) meta.env[key] = "***REDACTED***";
          }
        }
        await appendRunEvent(currentRun, seq++, {
          eventType: "adapter.invoke",
          stream: "system",
          level: "info",
          message: "adapter invocation",
          payload: meta as unknown as Record<string, unknown>,
        });
      };

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
          "local agent jwt secret missing or invalid; running without injected PAPERCLIP_API_KEY",
        );
      }
      const adapterResult = await adapter.execute({
        runId: run.id,
        agent: {
          ...agent,
          adapterConfig: mappedAgentAdapterConfig,
        },
        runtime: runtimeForAdapter,
        config: runtimeConfig,
        context,
        onLog,
        onMeta: onAdapterMeta,
        onSpawn: async (meta) => {
          await persistRunProcessMetadata(run.id, meta);
        },
        authToken: authToken ?? undefined,
      });
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
        context.paperclipRuntimeServices = combinedRuntimeServices;
        context.paperclipRuntimePrimaryUrl =
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
              { agentId: agent.id, runId: run.id },
            );
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post adapter-managed runtime comment: ${err instanceof Error ? err.message : String(err)}\n`,
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
        if (issueId && outcome === "succeeded") {
          try {
            const issueComment = buildHeartbeatRunIssueComment(adapterResult.resultJson ?? null);
            if (issueComment) {
              await issuesSvc.addComment(issueId, issueComment, { agentId: agent.id, runId: finalizedRun.id });
            }
          } catch (err) {
            await onLog(
              "stderr",
              `[paperclip] Failed to post run summary comment: ${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }
        await finalizeIssueCommentPolicy(finalizedRun, agent);
        await releaseIssueExecutionAndPromote(finalizedRun);
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
        await finalizeIssueCommentPolicy(failedRun, agent);
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
            const failedAgent = await getAgent(run.agentId).catch(() => null);
            if (failedAgent) {
              await finalizeIssueCommentPolicy(failedRun, failedAgent).catch(() => undefined);
            }
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

        const sessionBefore =
          readNonEmptyString(promotedContextSnapshot.resumeSessionDisplayId) ??
          await resolveSessionBeforeForWakeup(deferredAgent, promotedTaskKey);
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
    let issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueIdFromPayload;

    const agent = await getAgent(agentId);
    if (!agent) throw notFound("Agent not found");
    const explicitResumeSession = await resolveExplicitResumeSessionOverride(agent, payload, taskKey);
    if (explicitResumeSession) {
      enrichedContextSnapshot.resumeFromRunId = explicitResumeSession.resumeFromRunId;
      enrichedContextSnapshot.resumeSessionDisplayId = explicitResumeSession.sessionDisplayId;
      enrichedContextSnapshot.resumeSessionParams = explicitResumeSession.sessionParams;
      if (!readNonEmptyString(enrichedContextSnapshot.issueId) && explicitResumeSession.issueId) {
        enrichedContextSnapshot.issueId = explicitResumeSession.issueId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskId) && explicitResumeSession.taskId) {
        enrichedContextSnapshot.taskId = explicitResumeSession.taskId;
      }
      if (!readNonEmptyString(enrichedContextSnapshot.taskKey) && explicitResumeSession.taskKey) {
        enrichedContextSnapshot.taskKey = explicitResumeSession.taskKey;
      }
      issueId = readNonEmptyString(enrichedContextSnapshot.issueId) ?? issueId;
    }
    const effectiveTaskKey = readNonEmptyString(enrichedContextSnapshot.taskKey) ?? taskKey;
    const sessionBefore =
      explicitResumeSession?.sessionDisplayId ??
      await resolveSessionBeforeForWakeup(agent, effectiveTaskKey);

    const writeSkippedRequest = async (skipReason: string) => {
      await db.insert(agentWakeupRequests).values({
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
      });
    };

    let projectId = readNonEmptyString(enrichedContextSnapshot.projectId);
    if (!projectId && issueId) {
      projectId = await db
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)))
        .then((rows) => rows[0]?.projectId ?? null);
    }

    const budgetBlock = await budgets.getInvocationBlock(agent.companyId, agentId, {
      issueId,
      projectId,
    });
    if (budgetBlock) {
      await writeSkippedRequest("budget.blocked");
      throw conflict(budgetBlock.reason, {
        scopeType: budgetBlock.scopeType,
        scopeId: budgetBlock.scopeId,
      });
    }

    if (
      agent.status === "paused" ||
      agent.status === "terminated" ||
      agent.status === "pending_approval"
    ) {
      throw conflict("Agent is not invokable in its current state", { status: agent.status });
    }

    const policy = parseHeartbeatPolicy(agent);

    if (source === "timer" && !policy.enabled) {
      await writeSkippedRequest("heartbeat.disabled");
      return null;
    }
    if (source !== "timer" && !policy.wakeOnDemand) {
      await writeSkippedRequest("heartbeat.wakeOnDemand.disabled");
      return null;
    }

    const bypassIssueExecutionLock =
      reason === "issue_comment_mentioned" ||
      readNonEmptyString(enrichedContextSnapshot.wakeReason) === "issue_comment_mentioned";

    if (issueId && !bypassIssueExecutionLock) {
      const agentNameKey = normalizeAgentNameKey(agent.name);

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

        const activeExecutionRun = await repairIssueExecutionLock(tx, issue);

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

        const [{ liveRunCount }] = await tx
          .select({ liveRunCount: sql<number>`count(*)` })
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, agentId), inArray(heartbeatRuns.status, ["queued", "running"])));

        if (Number(liveRunCount ?? 0) >= policy.maxLiveRuns) {
          await tx.insert(agentWakeupRequests).values({
            companyId: agent.companyId,
            agentId,
            source,
            triggerDetail,
            reason: "heartbeat.live_run_limit_reached",
            payload,
            status: "skipped",
            requestedByActorType: opts.requestedByActorType ?? null,
            requestedByActorId: opts.requestedByActorId ?? null,
            idempotencyKey: opts.idempotencyKey ?? null,
            finishedAt: new Date(),
          });
          return {
            kind: "live_run_limit_reached" as const,
            liveRunCount: Number(liveRunCount ?? 0),
          };
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

        // executionRunId is NOT stamped here (enqueueWakeup queues the run but
        // doesn't start it). It will be stamped in claimQueuedRun() once the run
        // transitions to "running" — Fix A (lazy locking).

        return { kind: "queued" as const, run: newRun };
      });

      if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;
      if (outcome.kind === "live_run_limit_reached") {
        logger.warn(
          {
            agentId,
            companyId: agent.companyId,
            source,
            triggerDetail,
            liveRunCount: outcome.liveRunCount,
            liveRunLimit: policy.maxLiveRuns,
          },
          "heartbeat wakeup skipped due to live run limit",
        );
        return null;
      }
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

    if (activeRuns.length >= policy.maxLiveRuns) {
      await db.insert(agentWakeupRequests).values({
        companyId: agent.companyId,
        agentId,
        source,
        triggerDetail,
        reason: "heartbeat.live_run_limit_reached",
        payload,
        status: "skipped",
        requestedByActorType: opts.requestedByActorType ?? null,
        requestedByActorId: opts.requestedByActorId ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
        finishedAt: new Date(),
      });

      logger.warn(
        {
          agentId,
          companyId: agent.companyId,
          source,
          triggerDetail,
          liveRunCount: activeRuns.length,
          liveRunLimit: policy.maxLiveRuns,
        },
        "heartbeat wakeup skipped due to live run limit",
      );
      return null;
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

  async function listProjectScopedRunIds(companyId: string, projectId: string) {
    const runIssueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([heartbeatRuns.id], { id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${runIssueId}`,
        ),
      )
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, ["queued", "running"]),
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function listProjectScopedWakeupIds(companyId: string, projectId: string) {
    const wakeIssueId = sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`;
    const effectiveProjectId = sql<string | null>`coalesce(${agentWakeupRequests.payload} ->> 'projectId', ${issues.projectId}::text)`;

    const rows = await db
      .selectDistinctOn([agentWakeupRequests.id], { id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .leftJoin(
        issues,
        and(
          eq(issues.companyId, companyId),
          sql`${issues.id}::text = ${wakeIssueId}`,
        ),
      )
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          sql`${agentWakeupRequests.runId} is null`,
          sql`${effectiveProjectId} = ${projectId}`,
        ),
      );

    return rows.map((row) => row.id);
  }

  async function cancelPendingWakeupsForBudgetScope(scope: BudgetEnforcementScope) {
    const now = new Date();
    let wakeupIds: string[] = [];

    if (scope.scopeType === "company") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else if (scope.scopeType === "agent") {
      wakeupIds = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, scope.companyId),
            eq(agentWakeupRequests.agentId, scope.scopeId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.runId} is null`,
          ),
        )
        .then((rows) => rows.map((row) => row.id));
    } else {
      wakeupIds = await listProjectScopedWakeupIds(scope.companyId, scope.scopeId);
    }

    if (wakeupIds.length === 0) return 0;

    await db
      .update(agentWakeupRequests)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: "Cancelled due to budget pause",
        updatedAt: now,
      })
      .where(inArray(agentWakeupRequests.id, wakeupIds));

    return wakeupIds.length;
  }

  async function cancelRunInternal(runId: string, reason = "Cancelled by control plane") {
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

    const cancelled = await setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: reason,
      errorCode: "cancelled",
    });

    await setWakeupStatus(run.wakeupRequestId, "cancelled", {
      finishedAt: new Date(),
      error: reason,
    });

    if (cancelled) {
      await appendRunEvent(cancelled, 1, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: "run cancelled",
      });
      await releaseIssueExecutionAndPromote(cancelled);
    }

    runningProcesses.delete(run.id);
    await finalizeAgentStatus(run.agentId, "cancelled");
    await startNextQueuedRunForAgent(run.agentId);
    return cancelled;
  }

  async function cancelActiveForAgentInternal(agentId: string, reason = "Cancelled due to agent pause") {
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

  async function cancelActiveForCompanyInternal(companyId: string, reason = "Cancelled due to company pause") {
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));

    for (const run of runs) {
      await cancelRunInternal(run.id, reason);
    }

    return runs.length;
  }

  async function stopRunningForCompanyInternal(companyId: string, reason = "Stopped due to company pause") {
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));

    for (const run of runs) {
      await cancelRunInternal(run.id, reason);
    }

    return runs.length;
  }

  async function cancelBudgetScopeWork(scope: BudgetEnforcementScope) {
    if (scope.scopeType === "agent") {
      await cancelActiveForAgentInternal(scope.scopeId, "Cancelled due to budget pause");
      await cancelPendingWakeupsForBudgetScope(scope);
      return;
    }

    const runIds =
      scope.scopeType === "company"
        ? await db
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, scope.companyId),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .then((rows) => rows.map((row) => row.id))
        : await listProjectScopedRunIds(scope.companyId, scope.scopeId);

    for (const runId of runIds) {
      await cancelRunInternal(runId, "Cancelled due to budget pause");
    }

    await cancelPendingWakeupsForBudgetScope(scope);
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

    tickTimers: async (now = new Date()) => {
      const allAgents = await db.select().from(agents);
      let checked = 0;
      let enqueued = 0;
      let skipped = 0;

      for (const agent of allAgents) {
        if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") continue;
        const policy = parseHeartbeatPolicy(agent);
        if (!policy.enabled || policy.intervalSec <= 0) continue;

        checked += 1;
        const baseline = new Date(agent.lastHeartbeatAt ?? agent.createdAt).getTime();
        const elapsedMs = now.getTime() - baseline;
        if (elapsedMs < policy.intervalSec * 1000) continue;

        let run = null;
        try {
          run = await enqueueWakeup(agent.id, {
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
        } catch (error) {
          // Timer ticks should continue scanning other agents when a specific
          // invocation is blocked by runtime policy (for example paused company/agent
          // or budget hard-stop). enqueueWakeup already persisted the skipped request.
          if (error instanceof HttpError && error.status === 409) {
            skipped += 1;
            continue;
          }
          throw error;
        }
        if (run) enqueued += 1;
        else skipped += 1;
      }

      return { checked, enqueued, skipped };
    },

    cancelRun: (runId: string) => cancelRunInternal(runId),

    cancelActiveForAgent: (agentId: string) => cancelActiveForAgentInternal(agentId),

    cancelActiveForCompany: (companyId: string, reason?: string) =>
      cancelActiveForCompanyInternal(companyId, reason),

    stopRunningForCompany: (companyId: string, reason?: string) =>
      stopRunningForCompanyInternal(companyId, reason),

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
