import { and, asc, desc, eq, gt, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
} from "@paperclipai/shared";
import {
  agents,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueComments,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../local-service-supervisor.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES, issueService } from "../issues.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { isZeroTokenStartupFailureRun } from "./zero-token-startup-failure.js";

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  "id" | "agentId" | "status" | "error" | "errorCode" | "contextSnapshot" | "livenessState" | "resultJson" | "usageJson" | "createdAt"
> | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause =
  | "stranded_assigned_issue"
  | "workspace_validation_failed"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

// `extractAgentMcpKeys` reads the adapter_config.mcpServers map (set by
// adapter-specific configs like claude_k8s) and returns the sorted list of
// MCP names. Used in the recovery prompt so the recovery agent can see at
// a glance what tools the original assignee had vs candidate replacements
// (e.g. UXDesigner → [figma, webflow], CTO → []). The schema doesn't
// enforce the shape, so this is best-effort: missing or malformed
// `mcpServers` returns []. Skill names (paperclipSkillSync.desiredSkills)
// are intentionally NOT surfaced here — they're long lists with a lot of
// shared baseline that would obscure the meaningful MCP-coverage signal.
function extractAgentMcpKeys(agent: typeof agents.$inferSelect | null | undefined): string[] {
  if (!agent) return [];
  const adapterConfig = parseObject(agent.adapterConfig);
  const mcpServers = adapterConfig.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return [];
  return Object.keys(mcpServers).sort();
}

function summarizeAgentCapabilities(agent: typeof agents.$inferSelect | null | undefined): string {
  if (!agent) return "";
  const cap = readNonEmptyString(agent.capabilities);
  if (!cap) return "";
  // Single-line summary; long capability blurbs would dominate the prompt.
  const trimmed = cap.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

// PR #4600 redacted this to a "details withheld from the issue thread"
// sentinel because raw adapter error blobs can carry secrets (API keys,
// JWTs, internal hostnames). That left the recovery agent flying blind:
// with no visible signal of WHY the original assignee failed, the only
// reasonable action was to grab ownership of the parent issue and try
// itself. Observed BLO-3182 (2026-05-04 → 2026-05-06): UXDesigner failed
// once, recovery escalated to CTO with no diagnostic, CTO reassigned the
// parent to itself, then looped for 4 days posting empty "No response
// requested." runs because CTO doesn't have the Webflow MCP the issue
// actually needs.
//
// Restore a structured summary (errorCode + first line of the error
// message, capped) but pass it through `redactSensitiveText` first so any
// secrets in the raw error blob get scrubbed. errorCode is a stable
// classifier (e.g. `rate_limit_exhausted`, `silent_failure`) and is never
// itself sensitive — surface it always.
function summarizeRunFailureForIssueComment(run: LatestIssueRun) {
  if (!run) return null;

  const errorCode = readNonEmptyString(run.errorCode)?.trim() ?? null;
  const rawError = readNonEmptyString(run.error)?.trim() ?? null;

  // Prefer the JSON `"message": "..."` field if the error body is a JSON
  // blob (matches the heartbeat-side summarizer); otherwise take the first
  // non-empty line. Cap to 240 chars before redaction.
  const apiMessageMatch = rawError?.match(/"message"\s*:\s*"([^"]+)"/);
  const firstLine = rawError
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
  const summarySource = apiMessageMatch?.[1] ?? firstLine;
  const truncated =
    summarySource && summarySource.length > 240
      ? `${summarySource.slice(0, 237)}...`
      : summarySource;
  const summary = truncated ? redactSensitiveText(truncated) : null;

  if (errorCode && summary) return ` Latest retry failure: \`${errorCode}\` — ${summary}.`;
  if (errorCode) return ` Latest retry failure: \`${errorCode}\`.`;
  if (summary) return ` Latest retry failure: ${summary}.`;
  return null;
}

// Run failures that the recovery sweep must NOT retry. These are environment
// preconditions that no amount of re-dispatch will resolve — the next run will
// fail in the same way until a human (or the workspace owner) intervenes. We
// escalate to `blocked` on the first occurrence rather than burning a recovery
// cycle and producing another `Latest retry failure withheld` comment. See
// BLO-1498 (recovery loop spun 5+ cycles on a single tar conflict).
const NON_RETRYABLE_RUN_ERROR_CODES = new Set<string>([
  "workspace_import_conflict",
  "workspace_repo_mismatch",
]);

function isNonRetryableTerminalRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  if (
    !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  ) {
    return false;
  }
  const errorCode = readNonEmptyString(latestRun.errorCode);
  return Boolean(errorCode && NON_RETRYABLE_RUN_ERROR_CODES.has(errorCode));
}

function buildNonRetryableEscalationComment(input: {
  status: "todo" | "in_progress";
  latestRun: LatestIssueRun;
}) {
  const errorCode = readNonEmptyString(input.latestRun?.errorCode) ?? "non_retryable_failure";
  const verb = input.status === "todo" ? "dispatch" : "continuation";
  return (
    `Paperclip skipped automatic ${verb} recovery for this assigned \`${input.status}\` issue because the last run ` +
    `failed with a non-retryable code \`${errorCode}\`. ` +
    "Retrying would re-hit the same environment precondition. " +
    "Moving it to `blocked` so the recovery owner can clear the precondition before resuming."
  );
}

function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed",
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

const QUOTA_EXHAUSTED_RUN_ERROR_CODES = new Set<string>([
  "provider_quota_exhausted",
]);

function isQuotaExhaustedTerminalRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  if (
    !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  ) {
    return false;
  }
  const errorCode = readNonEmptyString(latestRun.errorCode);
  return Boolean(errorCode && QUOTA_EXHAUSTED_RUN_ERROR_CODES.has(errorCode));
}

const TRANSIENT_INFRA_CONTINUATION_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "codex_transient_upstream",
  "claude_transient_upstream",
  "timeout",
]);

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
]);

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;

type ContinuationRetryClassification = {
  kind: "transient_infra" | "non_retryable" | "default";
  maxAttempts: number;
  baseBackoffMs: number;
  errorCode: string | null;
};

function classifyContinuationFailure(latestRun: LatestIssueRun): ContinuationRetryClassification {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (errorCode && NON_RETRYABLE_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };
  }
  if (errorCode && TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return {
      kind: "transient_infra",
      maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  return {
    kind: "default",
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: 0,
    errorCode,
  };
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function unwrapDatabaseConflictError(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };

  if (
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
  ) {
    return candidate;
  }

  const cause = candidate.cause;
  if (!cause || typeof cause !== "object") return candidate;

  return cause as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  if (latestRun?.status !== "succeeded") return false;
  const livenessLooksProductive =
    latestRun.livenessState === "advanced" ||
    latestRun.livenessState === "completed" ||
    latestRun.livenessState === "blocked" ||
    latestRun.livenessState === "needs_followup";
  if (!livenessLooksProductive) return false;
  // 2026-05-06 BLO-3182 RCA: liveness can be fooled by trivial activity
  // (one inbox-fetch tool call gets classified as "advanced") even when
  // the agent's own result summary admits no work was done. Treat
  // explicit no-op summaries as non-productive regardless of liveness.
  return !runResultLooksLikeNoChangeExit(latestRun.resultJson);
}

const NO_CHANGE_EXIT_SUMMARY_PATTERNS = [
  /^\s*no\s+change\b/i,
  /^\s*same\s+sweep\s+wake\b/i,
  /^\s*exiting\.?\s*$/i,
  /^\s*nothing\s+to\s+do\b/i,
  /^\s*no\s+new\s+context\b/i,
  /^\s*no\s+actionable\b/i,
  /\bno\s+response\s+requested\b/i,
];

function runResultLooksLikeNoChangeExit(resultJson: unknown) {
  if (!resultJson || typeof resultJson !== "object") return false;
  const raw = resultJson as Record<string, unknown>;
  const summaryFields = [raw.summary, raw.result, raw.message];
  for (const value of summaryFields) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (NO_CHANGE_EXIT_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  }
  return false;
}

// After this many consecutive succeeded-but-non-productive runs on the same
// in_progress issue, escalate to `blocked` instead of waking the agent
// again. The pattern looks like the BLO-3182 cycle: agent runs, exits
// succeeded with livenessState ∈ {plan_only, empty_response, null}, the
// harness posts "No response requested.", the issue stays in_progress,
// next sweep wakes the same agent, repeat. Each iteration burns provider
// quota for zero forward progress. UXDesigner explicitly called out this
// pattern in BLO-3182's 05:10Z comment.
//
// 5 chosen so:
//   - genuine multi-step continuations (an agent that needs 2-3 wakeups to
//     finish a plan-then-execute cycle) aren't escalated prematurely; their
//     intermediate runs typically interleave with at least one productive
//     liveness transition (advanced/needs_followup)
//   - a clear no-op loop is caught well within an hour at the typical
//     5-min heartbeat cadence (~25 min wall clock)
const NON_PRODUCTIVE_RUN_NOOP_THRESHOLD = 5;

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

function isAutomaticContinuationRun(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed";
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue now keeps its existing blockers and is also blocked by the escalation issue so dependency wakeups remain explicit.",
  ].join("\n");
}

export function recoveryService(db: Db, deps: { enqueueWakeup: RecoveryWakeup }) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
    return (await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
  }

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        usageJson: heartbeatRuns.usageJson,
        createdAt: heartbeatRuns.createdAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Count the number of consecutive (most-recent-first) succeeded runs for
  // this issue whose livenessState is non-productive (plan_only,
  // empty_response, failed, or null). Stops counting at the first
  // productive run, the first non-succeeded run, or when the limit is hit.
  // Used by the no-op-loop detector to decide whether to escalate to
  // blocked instead of waking the agent again.
  //
  // 2026-05-25 BLO-7521: scope the lookback to runs created AFTER the
  // most recent `previousStatus=blocked` transition on this issue. A manual
  // operator unblock should give the agent a fresh window to make progress
  // before the no-op-loop detector re-blocks based on pre-unblock history.
  // Without the scope, the streak survives across reopens and re-blocks
  // within seconds of the operator flip — defeating the manual recovery
  // path entirely.
  async function getLatestUnblockedAt(
    companyId: string,
    issueId: string,
  ): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
          sql`${activityLog.details} ->> 'previousStatus' = 'blocked'`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }

  // BLO-8050: shared gate for "operator just unblocked this issue, give the
  // agent a fresh sweep window before re-escalating based on pre-unblock
  // history." Returns true when the latest run predates (or coincides with)
  // the most recent operator unblock — meaning the failure evidence the
  // escalation branches would key off was already known when the operator
  // chose to unblock. Without this gate, `reconcileStrandedAssignedIssues`
  // re-flips the issue back to `blocked` on the next sweep using stale
  // latestRun state, defeating the manual recovery path. BLO-7521 added the
  // first instance of this gate for stranded-recovery-origin issues; BLO-8050
  // generalizes it to all six escalation callsites (todo and in_progress
  // arms × non-retryable / zero-token / recovery-failed predicates).
  async function latestRunPredatesLatestUnblock(
    companyId: string,
    issueId: string,
    latestRun: LatestIssueRun,
  ): Promise<boolean> {
    const unblockedAt = await getLatestUnblockedAt(companyId, issueId);
    const latestRunCreatedAt = latestRun?.createdAt ?? null;
    return Boolean(unblockedAt && latestRunCreatedAt && latestRunCreatedAt <= unblockedAt);
  }

  async function countConsecutiveNonProductiveSuccessfulRuns(
    companyId: string,
    issueId: string,
    limit: number,
  ): Promise<number> {
    const unblockedAt = await getLatestUnblockedAt(companyId, issueId);
    const recent = await db
      .select({
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          unblockedAt ? gt(heartbeatRuns.createdAt, unblockedAt) : undefined,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(Math.max(limit, 1));

    let count = 0;
    for (const run of recent) {
      if (run.status !== "succeeded") break;
      const livenessLooksProductive =
        run.livenessState === "advanced" ||
        run.livenessState === "completed" ||
        run.livenessState === "blocked" ||
        run.livenessState === "needs_followup";
      // 2026-05-06 BLO-3182 RCA: liveness was being marked `advanced` on
      // wake-and-exit runs because the agent fetched the inbox or read
      // a comment ("Run produced concrete action evidence: 1 activity
      // event(s)"). The actual result body said "No change. Exiting."
      // Override liveness as non-productive when the summary itself is
      // explicit about it -- a trivial API call ≠ progress.
      if (livenessLooksProductive && !runResultLooksLikeNoChangeExit(run.resultJson)) break;
      count += 1;
    }
    return count;
  }

  async function summarizeRecentContinuationRetries(
    companyId: string,
    issueId: string,
    errorCodeToMatch: string | null,
  ) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(10);

    let consecutive = 0;
    let latestFinishedAt: Date | null = null;
    for (const row of rows) {
      const ctx = parseObject(row.contextSnapshot);
      const retryReason = readNonEmptyString(ctx.retryReason);
      if (retryReason !== "issue_continuation_needed") break;
      if (
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          row.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
        )
      ) {
        break;
      }

      const rowErrorCode = readNonEmptyString(row.errorCode);
      if (errorCodeToMatch !== rowErrorCode) {
        break;
      }

      consecutive += 1;
      if (latestFinishedAt === null) latestFinishedAt = row.finishedAt ?? null;
    }
    return { consecutive, latestFinishedAt };
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed";
    retryReason: "assignment_recovery" | "issue_continuation_needed";
    source: string;
    retryOfRunId?: string | null;
  }) {
    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      }, "normal_model"),
    });

    if (queued && input.retryOfRunId) {
      return db
        .update(heartbeatRuns)
        .set({
          retryOfRunId: input.retryOfRunId,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, queued.id))
        .returning()
        .then((rows) => rows[0] ?? queued);
    }

    return queued;
  }

  async function enqueueInitialAssignedTodoDispatch(issue: typeof issues.$inferSelect, agentId: string) {
    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }, "normal_model"),
    });
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !(await isAgentInvokable(creatorAgent))) {
        skipped += 1;
        continue;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }, "normal_model"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }, "normal_model"),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function isTerminalIssueStatus(status: string | null | undefined) {
    return status === "done" || status === "cancelled";
  }

  function isRecoveryOriginIssue(issue: typeof issues.$inferSelect) {
    return Object.values(RECOVERY_ORIGIN_KINDS).includes(
      issue.originKind as typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS],
    );
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    return run.lastOutputAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // PCL-2571 (2026-05-25 RCA): when an active run is silent past the
  // suspicion threshold and the detector files a `stale_active_run_evaluation`
  // review, but moments later the heartbeat reaper finalizes the run to
  // `failed`/`cancelled` (process_lost is the dominant case), the silence
  // is fully explained by the termination and no operator review is needed.
  // Without this cleanup hook the review stayed `todo` on the CTO inbox
  // indefinitely — 11 stuck reviews accumulated in 5 days at the time of
  // this writing. Callers in the heartbeat reaper / cancellation paths
  // invoke this AFTER setRunStatus has flipped the run to its terminal
  // state, so a fresh detector sweep on the same run would no longer
  // create a new review either.
  async function dismissStaleEvaluationOnRunTerminated(input: {
    companyId: string;
    runId: string;
    agentId: string | null;
    terminalStatus: "failed" | "cancelled" | "timed_out";
    errorCode: string | null;
    errorMessage: string | null;
  }) {
    const evaluation = await findOpenStaleRunEvaluation(input.companyId, input.runId);
    if (!evaluation) return { kind: "none" as const };
    if (isTerminalIssueStatus(evaluation.status)) return { kind: "none" as const };
    const now = new Date();
    const [cancelledEvaluation] = await db
      .update(issues)
      .set({
        status: "cancelled",
        cancelledAt: now,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, evaluation.id),
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, input.runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .returning({
        id: issues.id,
        identifier: issues.identifier,
      });
    if (!cancelledEvaluation) return { kind: "none" as const };

    const blockedSources = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.issueId, cancelledEvaluation.id),
          eq(issueRelations.type, "blocks"),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let detachedBlockedSources = 0;
    for (const source of blockedSources) {
      const nextBlockerIds = (await existingBlockerIssueIds(source.companyId, source.id))
        .filter((blockerId) => blockerId !== cancelledEvaluation.id);
      await db
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, source.companyId),
            eq(issueRelations.issueId, cancelledEvaluation.id),
            eq(issueRelations.relatedIssueId, source.id),
            eq(issueRelations.type, "blocks"),
          ),
        );
      const { blockerIssueIds: unresolvedAfterDetach } = await unresolvedBlockerHumanDecisionEscalationState(source.companyId, source.id);
      let restoredSourceStatus = false;
      let restoreSkippedReason: string | null = null;
      if (source.status === "blocked" && unresolvedAfterDetach.length === 0) {
        try {
          const restored = await issuesSvc.update(source.id, { status: "todo" });
          restoredSourceStatus = restored?.status === "todo";
        } catch (err) {
          restoreSkippedReason = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, issueId: source.id, companyId: source.companyId, evaluationIssueId: cancelledEvaluation.id },
            "detached stale active run evaluation blocker but could not restore source issue status",
          );
        }
      }
      detachedBlockedSources += 1;
      await logActivity(db, {
        companyId: source.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.agentId,
        runId: input.runId,
        action: "heartbeat.output_stale_blocker_detached_on_termination",
        entityType: "issue",
        entityId: source.id,
        details: {
          source: "recovery.dismiss_on_run_terminated",
          evaluationIssueId: cancelledEvaluation.id,
          evaluationIssueIdentifier: cancelledEvaluation.identifier,
          remainingBlockerCount: nextBlockerIds.length,
          remainingUnresolvedBlockerCount: unresolvedAfterDetach.length,
          restoredSourceStatus,
          restoreSkippedReason,
        },
      });
    }

    const bodyLines = [
      `Auto-cancelled: source run finalized to \`${input.terminalStatus}\`${
        input.errorCode ? ` (errorCode: \`${input.errorCode}\`)` : ""
      }.`,
      "",
      "The output silence that prompted this review was explained by the heartbeat reaper rather than requiring operator intervention.",
    ];
    if (input.errorMessage) {
      bodyLines.push("", `> ${input.errorMessage}`);
    }
    await issuesSvc.addComment(evaluation.id, bodyLines.join("\n"), { runId: input.runId });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "heartbeat.output_stale_auto_dismissed_on_termination",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.dismiss_on_run_terminated",
        terminalStatus: input.terminalStatus,
        errorCode: input.errorCode,
        evaluationIssueIdentifier: cancelledEvaluation.identifier,
        detachedBlockedSources,
      },
    });
    return { kind: "dismissed" as const, evaluationIssueId: cancelledEvaluation.id };
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : quietUntilDecision
        ? "snoozed"
        : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
          ? "critical"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
            ? "suspicious"
            : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    if (!run.logStore || !run.logRef || !run.logBytes) return "";
    try {
      const offset = Math.max(0, run.logBytes - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
      const result = await runLogStore.read(
        { store: run.logStore as "local_file", logRef: run.logRef },
        { offset, limitBytes: ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES },
      );
      return result.content;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      return "";
    }
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), isNull(issues.hiddenAt)))
      .limit(1);
    return issue ?? null;
  }

  async function latestSameRunSourceTerminalEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidenceAfter: Date | null;
  }) {
    if (!isTerminalIssueStatus(input.sourceIssue.status)) return null;
    const after = input.evidenceAfter ?? input.run.startedAt ?? input.run.createdAt ?? null;
    const activityPredicates = [
      eq(activityLog.companyId, input.run.companyId),
      eq(activityLog.runId, input.run.id),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.sourceIssue.id),
      sql`${activityLog.details} ->> 'status' = ${input.sourceIssue.status}`,
    ];
    if (after) {
      activityPredicates.push(gte(activityLog.createdAt, after));
    }

    const activity = await db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(and(...activityPredicates))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (activity) {
      return {
        kind: "activity" as const,
        id: activity.id,
        createdAt: activity.createdAt,
        action: activity.action,
      };
    }
    return null;
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function appendRecoveryRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      level: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq: await nextRunEventSeq(run.id),
      eventType: "lifecycle",
      stream: "system",
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
    });
  }

  async function cleanupSourceResolvedRunProcess(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
  }) {
    if (!SESSIONED_LOCAL_ADAPTERS.has(input.runningAgent.adapterType)) {
      return {
        attempted: false,
        outcome: "skipped_non_local_adapter",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const running = runningProcesses.get(input.run.id);
    const pid = running?.child.pid ?? input.run.processPid ?? null;
    const processGroupId = running?.processGroupId ?? input.run.processGroupId ?? null;
    if (typeof pid !== "number" && typeof processGroupId !== "number") {
      return {
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const wasAlive =
      (typeof pid === "number" && isPidAlive(pid)) ||
      (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
    if (!wasAlive) {
      runningProcesses.delete(input.run.id);
      return {
        attempted: false,
        outcome: "not_running",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    }

    try {
      await terminateLocalService(
        {
          pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0
            ? pid
            : (processGroupId ?? 0),
          processGroupId: typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
            ? processGroupId
            : null,
        },
        running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
      );
      runningProcesses.delete(input.run.id);
      const stillAlive =
        (typeof pid === "number" && isPidAlive(pid)) ||
        (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
      return {
        attempted: true,
        outcome: stillAlive ? "termination_sent_still_running" : "terminated",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    } catch (error) {
      return {
        attempted: true,
        outcome: "failed",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function finalizeAgentAfterSourceResolvedRun(run: typeof heartbeatRuns.$inferSelect, status: "succeeded" | "cancelled") {
    const [runningCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")));
    const runningCount = Number(runningCountRow?.count ?? 0);
    const nextStatus = runningCount > 0 ? "running" : status === "succeeded" || status === "cancelled" ? "idle" : "error";
    await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, run.agentId), notInArray(agents.status, ["paused", "terminated"])));
  }

  async function foldSourceResolvedStaleRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidence: Awaited<ReturnType<typeof latestSameRunSourceTerminalEvidence>>;
    existingEvaluation: Awaited<ReturnType<typeof findOpenStaleRunEvaluation>>;
    silenceStartedAt: Date | null;
    silenceAgeMs: number | null;
    now: Date;
  }) {
    if (!input.evidence) return { kind: "skipped" as const };
    const cleanup = await cleanupSourceResolvedRunProcess({ run: input.run, runningAgent: input.runningAgent });
    const finalRunStatus = input.sourceIssue.status === "cancelled" ? "cancelled" : "succeeded";
    const resultJson = {
      ...parseObject(input.run.resultJson),
      sourceResolvedWatchdogFold: {
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        silenceStartedAt: input.silenceStartedAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        evaluationIssueIdentifier: input.existingEvaluation?.identifier ?? null,
        cleanup,
      },
    };
    const finalizedRun = await db.transaction(async (tx) => {
      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: finalRunStatus,
          finishedAt: input.now,
          error: null,
          errorCode: null,
          resultJson,
          updatedAt: input.now,
        })
        .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId), eq(heartbeatRuns.status, "running")))
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: finalRunStatus === "succeeded" ? "completed" : "cancelled",
            finishedAt: input.now,
            error: null,
            updatedAt: input.now,
          })
          .where(and(eq(agentWakeupRequests.id, input.run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.run.companyId)));
      }

      await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.id, input.sourceIssue.id),
            eq(issues.companyId, input.run.companyId),
            eq(issues.executionRunId, input.run.id),
          ),
        );

      return updatedRun;
    });
    if (!finalizedRun) return { kind: "skipped" as const };

    if (input.existingEvaluation && !isTerminalIssueStatus(input.existingEvaluation.status)) {
      await issuesSvc.update(input.existingEvaluation.id, { status: "done" });
      await issuesSvc.addComment(input.existingEvaluation.id, [
        "Source-resolved watchdog fold.",
        "",
        `- Source issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
        `- Run: \`${input.run.id}\``,
        `- Same-run evidence: \`${input.evidence.kind}:${input.evidence.id}\` at ${input.evidence.createdAt.toISOString()}`,
        "- Outcome: false positive; the source issue already reached a terminal disposition from this run.",
      ].join("\n"), { runId: input.run.id });
    }

    // Only resolve the active recovery action if process cleanup is
    // confirmed terminal. Outcomes `termination_sent_still_running` and
    // `failed` mean we may have a zombie local process: marking the
    // recovery as resolved would hide that from operators. The source
    // issue did reach a terminal disposition, so the run/watchdog
    // finalization above is still correct — but the OS-level cleanup
    // concern must remain operator-visible.
    const cleanupConfirmed =
      !cleanup.attempted ||
      cleanup.outcome === "terminated" ||
      cleanup.outcome === "not_running" ||
      cleanup.outcome === "no_process_metadata" ||
      cleanup.outcome === "skipped_non_local_adapter";
    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(input.run.companyId, input.sourceIssue.id);
    if (activeRecoveryAction?.kind === "active_run_watchdog" && cleanupConfirmed) {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.run.companyId,
        sourceIssueId: input.sourceIssue.id,
        actionId: activeRecoveryAction.id,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "Source issue reached a terminal disposition through durable same-run activity; watchdog folded as source-resolved.",
      });
    }

    const [decision] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: input.run.companyId,
        runId: input.run.id,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        decision: "dismissed_false_positive",
        reason: "Source issue already reached a terminal disposition through durable same-run activity.",
        createdByRunId: input.run.id,
      })
      .returning();

    await appendRecoveryRunEvent(finalizedRun, {
      // Promote to warn whenever process cleanup is unconfirmed (not just on
      // hard `failed`): `termination_sent_still_running` is equally operator-
      // visible because a local process may still be alive.
      level: cleanupConfirmed ? "info" : "warn",
      message: cleanupConfirmed
        ? "Source-resolved watchdog fold finalized stale active run"
        : "Source-resolved watchdog fold finalized stale active run; recovery action kept open due to unconfirmed process cleanup",
      payload: resultJson.sourceResolvedWatchdogFold,
    });
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_source_resolved",
      entityType: "heartbeat_run",
      entityId: input.run.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        watchdogDecisionId: decision.id,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        cleanup,
      },
    });
    await finalizeAgentAfterSourceResolvedRun(finalizedRun, finalRunStatus);
    return { kind: "folded" as const, evaluationIssueId: input.existingEvaluation?.id ?? null };
  }

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    if (input.sourceIssue?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceIssue.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if ((await isAgentInvokable(candidate)) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childIssues, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, input.run.companyId),
              eq(issueRelations.relatedIssueId, input.sourceIssue.id),
              eq(issueRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childIssues,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceIssue = input.sourceIssue
      ? issueUiLink({ identifier: input.sourceIssue.identifier, id: input.sourceIssue.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childIssues = input.evidence.childIssues.length > 0
      ? input.evidence.childIssues.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source issue: ${sourceIssue}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child issues:",
      childIssues,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this issue as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stale_run_evaluation_uq" ||
        maybe.constraint_name === "issues_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stale_run_evaluation_uq")
      );
  }

  function isUniqueStrandedIssueRecoveryConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stranded_issue_recovery_uq" ||
        maybe.constraint_name === "issues_active_stranded_issue_recovery_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stranded_issue_recovery_uq")
      );
  }

  async function ensureSourceIssueBlockedByStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    const blockerIds = await existingBlockerIssueIds(input.sourceIssue.companyId, input.sourceIssue.id);
    if (blockerIds.includes(input.evaluationIssue.id)) return false;
    const nextBlockerIds = [...blockerIds, input.evaluationIssue.id];
    await issuesSvc.update(input.sourceIssue.id, {
      ...(input.sourceIssue.status === "blocked" ? {} : { status: "blocked" }),
      blockedByIssueIds: nextBlockerIds,
    });
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "This blocks the source issue on the explicit review task without cancelling the active process.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.evaluationIssue.id,
        blockerIssueIds: nextBlockerIds,
      },
    });
    return true;
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    if (sourceIssue && sourceIssue.status === "blocked") {
      return { kind: "skipped" as const };
    }
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (sourceIssue && isRecoveryOriginIssue(sourceIssue)) {
      await logActivity(db, {
        companyId: input.run.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.run.agentId,
        runId: input.run.id,
        action: "heartbeat.output_stale_recovery_recursion_refused",
        entityType: "heartbeat_run",
        entityId: input.run.id,
        details: {
          source: "recovery.scan_silent_active_runs",
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier,
          sourceIssueOriginKind: sourceIssue.originKind,
          existingEvaluationIssueId: existing?.id ?? null,
        },
      });
      return { kind: "skipped" as const };
    }
    const silenceStartedAt = silenceStartedAtForRun(input.run);
    if (sourceIssue && isTerminalIssueStatus(sourceIssue.status)) {
      const terminalEvidence = await latestSameRunSourceTerminalEvidence({
        run: input.run,
        sourceIssue,
        evidenceAfter: silenceStartedAt,
      });
      if (terminalEvidence) {
        return foldSourceResolvedStaleRun({
          run: input.run,
          runningAgent,
          sourceIssue,
          evidence: terminalEvidence,
          existingEvaluation: existing,
          silenceStartedAt,
          silenceAgeMs: silenceAgeMsForRun(input.run, input.now),
          now: input.now,
        });
      }
    }
    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await issuesSvc.update(existing.id, {
          priority: "high",
        });
        await issuesSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueBlockedByStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceIssue });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      evaluation = await issuesSvc.create(input.run.companyId, {
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationIssueId: raced.id };
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueBlockedByStaleEvaluation({
        sourceIssue,
        evaluationIssue: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
      });
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    const candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.processStartedAt}, ${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${suspicionBefore.toISOString()}::timestamptz`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      folded: 0,
      snoozed: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
      else if (outcome.kind === "folded") result.folded += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  async function findOpenStrandedIssueRecoveryIssue(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Cooldown after a stranded-recovery issue closes before another can fire
  // for the same source. The active-recovery uniqueness index prevents
  // *concurrent* duplicates but doesn't prevent *sequential* re-firing —
  // BLO-3182 spawned 9 separate recoveries over 4 days, each marked done
  // without changing assignment/status, then re-detected as stranded on the
  // next sweep. The recovery agent's "no-op succeeded" runs aren't enough
  // signal on their own to break the loop. Cooldown gives the operator (or
  // the recovery agent on its next chance) breathing room to take a non-
  // automatic action — a manual reassignment, a hold, or marking blocked —
  // before the sweep papers over the underlying problem with another
  // identical recovery.
  //
  // 6 hours: short enough that genuinely transient stranding (e.g. agent
  // pod crash that the harness recovers from) gets a follow-up recovery
  // within one shift; long enough that a CEO/manual hold has time to
  // propagate before the sweep re-fires.
  const STRANDED_ISSUE_RECOVERY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

  async function findRecentClosedStrandedIssueRecoveryIssue(
    companyId: string,
    sourceIssueId: string,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - STRANDED_ISSUE_RECOVERY_COOLDOWN_MS);
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  async function resolveStrandedIssueRecoveryOwnerAgentId(issue: typeof issues.$inferSelect) {
    const candidateIds: string[] = [];
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if ((await isAgentInvokable(candidate)) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  function buildStrandedIssueRecoveryDescription(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    prefix: string;
    originalAssignee: typeof agents.$inferSelect | null;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    sourceAssignee?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const sourceRunId = input.successfulRunHandoffEvidence?.sourceRunId;
      const sourceRunLink = sourceRunId && input.latestRun
        ? `[\`${sourceRunId}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${sourceRunId})`
        : "unknown";
      const missingDisposition = input.successfulRunHandoffEvidence?.missingDisposition ?? "clear_next_step";
      return [
        "Paperclip exhausted the bounded corrective handoff for a successful run that still has no valid issue disposition.",
        "",
        "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
        "",
        "## Safe Evidence",
        "",
        `- Source issue: ${sourceIssue}`,
        `- Source run: ${sourceRunLink}`,
        `- Corrective handoff run: ${runLink}`,
        `- Source assignee: ${agentUiLink(input.sourceAssignee ?? null, input.prefix)}`,
        `- Latest issue status: \`${input.issue.status}\``,
        `- Latest handoff run status: \`${input.latestRun?.status ?? "unknown"}\``,
        `- Normalized cause: \`${SUCCESSFUL_RUN_MISSING_STATE_REASON}\``,
        `- Missing disposition: \`${missingDisposition}\``,
        "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
        "",
        "## Required Action",
        "",
        "- Inspect the source issue and run metadata, not raw transcript excerpts.",
        "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- When the source issue has a clear owner and disposition, mark this recovery issue done.",
      ].join("\n");
    }

    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    // Surface the original assignee's name + role + MCP keys + capability
    // blurb so the recovery agent can compare to its own (and any candidate
    // replacement's) capabilities BEFORE reassigning. Closes the BLO-3182
    // gap where CTO reassigned UXDesigner → CTO without realizing UXDesigner
    // had webflow + figma MCPs that CTO doesn't.
    const originalMcpKeys = extractAgentMcpKeys(input.originalAssignee);
    const originalCapabilities = summarizeAgentCapabilities(input.originalAssignee);
    const originalAssigneeName = input.originalAssignee?.name ?? "unknown";
    const originalAssigneeRole = input.originalAssignee?.role ?? "unknown";
    const mcpsLine = originalMcpKeys.length > 0
      ? `- Original assignee MCPs: ${originalMcpKeys.map((k) => `\`${k}\``).join(", ")}`
      : "- Original assignee MCPs: none configured";

    return [
      "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`stranded_assigned_issue\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Original Assignee Capabilities",
      "",
      `- Original assignee: ${originalAssigneeName} (role: \`${originalAssigneeRole}\`)`,
      mcpsLine,
      originalCapabilities ? `- Capability blurb: ${originalCapabilities}` : "- Capability blurb: none recorded",
      "- Compare against your own capabilities before considering reassignment. If the original assignee has MCPs you don't, they probably need re-waking, not replacing.",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "- The original assignee is still the right owner for the *source* issue unless they provably can't do the work; this recovery task exists to diagnose, not to take over.",
      "",
      "## Required Action",
      "",
      "1. **Inspect first**: read the latest run linked above. The `Failure:` line above usually tells you the failure family. If it's transient (rate limit, MCP timeout, network), the original assignee just needs another attempt.",
      "2. **Default action — re-wake the original assignee.** Most stranding is transient. Post a comment on the source issue explaining what you found, then leave the source issue's existing assignee unchanged. The next heartbeat will pick it up on a fresh provider account.",
      "3. **Reassign only when the original assignee provably cannot do this work** — i.e. they're missing a required tool/MCP/skill that another agent has. If you reassign, name the missing capability in your comment so future recovery sweeps don't repeat the diagnosis. Do NOT reassign to yourself unless you have the capability the original assignee lacks.",
      "4. **Mark blocked, not reassigned, when the failure is environmental** (workspace/runtime/credential issue requiring a human). A reassign just moves the same failure to a different agent.",
      "5. **When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.**",
    ].join("\n");
  }

  async function ensureStrandedIssueRecoveryIssue(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) return null;

    // Retry loop tolerates two concurrency outcomes when many reconcile
    // sweeps race for the same source issue: (a) the partial unique index
    // catches the duplicate INSERT (23505), and (b) PostgreSQL kills one
    // of the racing transactions with a deadlock (40P01) when
    // index/parent/heap locks acquire in different orders. Either way the
    // caller treats the winner's issue as the canonical recovery.
    const MAX_ATTEMPTS = 5;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
      if (existing) return existing;

      // Cooldown: if a recovery for this source recently closed (done or
      // cancelled), don't fire another one. Returns the closed recovery so
      // the caller treats it as the current artifact and skips work; logs
      // surface that we suppressed instead of creating fresh.
      const now = new Date();
      const recentlyClosed = await findRecentClosedStrandedIssueRecoveryIssue(
        input.issue.companyId,
        input.issue.id,
        now,
      );
      if (recentlyClosed) {
        logger.info(
          {
            companyId: input.issue.companyId,
            sourceIssueId: input.issue.id,
            recentRecoveryId: recentlyClosed.id,
            recentRecoveryClosedAt: recentlyClosed.updatedAt,
            cooldownMs: STRANDED_ISSUE_RECOVERY_COOLDOWN_MS,
          },
          "stranded-recovery suppressed by cooldown after recent close",
        );
        return recentlyClosed;
      }

      const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
      if (!ownerAgentId) return null;

      const prefix = await getCompanyIssuePrefix(input.issue.companyId);
      const sourceAssignee = input.issue.assigneeAgentId
        ? await getAgent(input.issue.assigneeAgentId)
        : null;
      const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
      let recovery: Awaited<ReturnType<typeof issuesSvc.create>>;
      try {
        recovery = await issuesSvc.create(input.issue.companyId, {
          title: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
            ? `Recover missing next step ${input.issue.identifier ?? input.issue.title}`
            : `Recover stalled issue ${input.issue.identifier ?? input.issue.title}`,
          description: buildStrandedIssueRecoveryDescription({
            issue: input.issue,
            latestRun: input.latestRun,
            previousStatus: input.previousStatus,
            prefix,
            originalAssignee: sourceAssignee,
            recoveryCause,
            successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
            sourceAssignee,
          }),
          status: "todo",
          priority: input.issue.priority,
          parentId: input.issue.id,
          projectId: input.issue.projectId,
          goalId: input.issue.goalId,
          assigneeAgentId: ownerAgentId,
          assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
          originKind: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          originId: input.issue.id,
          originRunId: input.latestRun?.id ?? null,
          originFingerprint: [
            STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
            input.issue.companyId,
            input.issue.id,
            recoveryCause,
            input.latestRun?.id ?? "no-run",
          ].join(":"),
          billingCode: input.issue.billingCode,
          inheritExecutionWorkspaceFromIssueId: input.issue.id,
        });
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string })?.code;
        const isRetryable = isUniqueStrandedIssueRecoveryConflict(error) || code === "40P01";
        if (!isRetryable) throw error;
        const raced = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
        if (raced) return raced;
        if (attempt === MAX_ATTEMPTS - 1) break;
        // Jittered backoff so concurrent retriers don't deadlock again on
        // the same lock-acquisition order.
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
        continue;
      }

      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: recovery.id,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: recovery.id,
          taskId: recovery.id,
          wakeReason: "issue_assigned",
          source: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause,
        }, "status_only"),
      });

      return recovery;
    }

    throw lastError ?? new Error("ensureStrandedIssueRecoveryIssue: exhausted retries with no winner");
  }

  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : cause === "workspace_validation_failed"
        ? "workspace_validation" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
  }) {
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
      // Include assignee so a reassignment resets attempt count and re-allows a fresh wake.
      input.issue.assigneeAgentId ?? "unassigned",
    ].join(":");
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause: StrandedRecoveryCause;
    sourceAssignee?: typeof agents.$inferSelect | null;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      latestRunFailureSummary: summarizeRunFailureForIssueComment(input.latestRun),
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      originalAssigneeMcpKeys: extractAgentMcpKeys(input.sourceAssignee),
      originalAssigneeCapabilities: summarizeAgentCapabilities(input.sourceAssignee),
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: "todo" | "in_progress";
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
    const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
    const sourceAssignee = input.issue.assigneeAgentId
      ? await getAgent(input.issue.assigneeAgentId)
      : null;
    const now = new Date();

    // Read existing action before upsert so we can compare lastAttemptAt against
    // issue.lastActivityAt and suppress duplicate non-assignee wakes when nothing changed.
    const existingAction = await recoveryActionsSvc.getActiveForIssue(input.issue.companyId, input.issue.id);
    const previousAttemptAt = existingAction?.lastAttemptAt
      ? new Date(existingAction.lastAttemptAt as Date | string)
      : null;
    const hasNewActivitySinceLastAttempt = !previousAttemptAt
      || input.issue.lastActivityAt > previousAttemptAt;

    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: input.issue.assigneeAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
      }),
      evidence: buildStrandedRecoveryActionEvidence({
        issue: input.issue,
        latestRun: input.latestRun,
        previousStatus: input.previousStatus,
        recoveryCause,
        sourceAssignee,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      }),
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : recoveryCause === "workspace_validation_failed"
          ? "Repair the source issue workspace link, project workspace cwd, or git checkout before resuming adapter execution."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: recoveryCause === "workspace_validation_failed"
        ? {
          type: "manual_repair_required",
          reason: "workspace_validation_failed",
          ownerAgentId,
        }
        : ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
        },
      monitorPolicy: null,
      maxAttempts: null,
      lastAttemptAt: now,
    });

    return { action, hasNewActivitySinceLastAttempt };
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
    hasNewActivitySinceLastAttempt: boolean;
  }) {
    if (input.recoveryCause === "workspace_validation_failed") return;
    if (!input.action.ownerAgentId) return;
    const ownerIsNonAssignee = input.action.ownerAgentId !== input.issue.assigneeAgentId;
    if (!input.hasNewActivitySinceLastAttempt && ownerIsNonAssignee && input.action.attemptCount > 1) {
      const assigneeAgentId = input.issue.assigneeAgentId;
      if (!assigneeAgentId) return;
      await deps.enqueueWakeup(assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "source_scoped_recovery_action",
        idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}:assignee_fallback`,
        payload: withRecoveryModelProfileHint({
          issueId: input.issue.id,
          sourceIssueId: input.issue.id,
          recoveryActionId: input.action.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause: input.recoveryCause,
          suppressedNonAssigneeWake: true,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: input.issue.id,
          taskId: input.issue.id,
          wakeReason: "source_scoped_recovery_action",
          skipIssueComment: true,
          source: "issue_recovery_action",
          recoveryActionId: input.action.id,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause: input.recoveryCause,
          suppressedNonAssigneeWake: true,
        }, "status_only"),
      });
      return;
    }
    await deps.enqueueWakeup(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
    });
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    const updated = await issuesSvc.update(input.issue.id, { status: "blocked" });
    if (!updated) return null;

    const prefix = await getCompanyIssuePrefix(input.issue.companyId);
    await issuesSvc.addComment(
      input.issue.id,
      buildRecoveryIssueInPlaceEscalationComment({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        prefix,
      }),
      {},
    );

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        status: "blocked",
        previousStatus: input.previousStatus,
        source: "recovery.reconcile_stranded_recovery_issue",
        latestRunId: input.latestRun?.id ?? null,
        latestRunStatus: input.latestRun?.status ?? null,
        latestRunErrorCode: input.latestRun?.errorCode ?? null,
        originKind: input.issue.originKind,
        originId: input.issue.originId,
      },
    });

    return updated;
  }

  function isWaitingOnReviewContinuationRun(latestRun: LatestIssueRun) {
    const context = parseObject(latestRun?.contextSnapshot);
    return latestRun?.status === "cancelled" &&
      readNonEmptyString(context.retryReason) === "issue_continuation_needed" &&
      latestRun.errorCode === "issue_continuation_waiting_on_review";
  }

  function hasActiveMonitorPath(issue: typeof issues.$inferSelect) {
    return Boolean(issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now());
  }

  async function parkReviewWaitingContinuationIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "in_progress";
    latestRun: LatestIssueRun;
  }) {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.issue.companyId} || ':' || ${input.issue.id}, 0))`,
      );

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (!fresh || fresh.status !== "in_progress" || !hasActiveMonitorPath(fresh)) return null;

      const updated = await issuesSvc.update(fresh.id, { status: "in_review" }, tx);
      if (!updated) return null;

      const activeRecoveryAction = await recoveryActionsSvc.resolveActiveForIssue({
        companyId: fresh.companyId,
        sourceIssueId: fresh.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote:
          "Continuation retry was intentionally cancelled because the issue is waiting on review/CI, and the source issue has an active monitor path.",
      }, tx);

      await logActivity(db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "in_review",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_review_waiting_continuation",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryActionId: activeRecoveryAction?.id ?? null,
        },
      });

      return updated;
    });
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function unresolvedBlockerHumanDecisionEscalationState(companyId: string, issueId: string) {
    const blockerRows = await db
      .select({
        blockerIssueId: issueRelations.issueId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    const blockerIssueIds = blockerRows.map((row) => row.blockerIssueId);
    const needsHumanDecision = blockerRows.length === 0 || blockerRows.every(
      (row) => row.assigneeAgentId && !row.assigneeUserId,
    );
    return { blockerIssueIds, needsHumanDecision };
  }

  async function emitNeedsHumanDecisionEscalationEvent(input: {
    issue: typeof issues.$inferSelect;
    assigneeAgentName: string | null;
    blockedByIssueIds: string[];
  }) {
    const transitionedAt = new Date().toISOString();
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.escalation.needs_human_decision",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
        assigneeAgentId: input.issue.assigneeAgentId,
        assigneeAgentName: input.assigneeAgentName,
        blockedByIssueIds: input.blockedByIssueIds,
        originSweep: "recovery.reconcile_stranded_assigned_issue",
        transitionedAt,
      },
    });
  }

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    comment?: string;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
      });
    }

    // Serialize escalation per (company, source-issue) so concurrent
    // reconcile sweeps don't fight over the same recovery-action upsert,
    // wakeup, and source-issue UPDATE.
    // The advisory lock is xact-scoped on this tx's connection; once we
    // commit/return, waiting peers wake up and record their next attempt
    // against the same active source-scoped action.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.issue.companyId} || ':' || ${input.issue.id}, 0))`,
      );

      // Re-read source issue under the lock so the recovery action records
      // the latest owner/status evidence and repeated sweeps reuse the same
      // source-scoped action instead of creating issue-backed fallbacks.
      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (!fresh) return null;

      const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
      const { action, hasNewActivitySinceLastAttempt } = await ensureSourceScopedStrandedRecoveryAction({
        issue: fresh,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        recoveryCause,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
      });
      const {
        blockerIssueIds: blockerIds,
        needsHumanDecision,
      } = await unresolvedBlockerHumanDecisionEscalationState(fresh.companyId, fresh.id);

      await enqueueSourceScopedStrandedRecoveryWake({
        action,
        issue: fresh,
        latestRun: input.latestRun,
        recoveryCause,
        hasNewActivitySinceLastAttempt,
      });

      const updated = await issuesSvc.update(input.issue.id, {
        status: "blocked",
        blockedByIssueIds: blockerIds,
      });
      if (!updated) return null;

      const prefix = await getCompanyIssuePrefix(fresh.companyId);
      const recoveryOwner = action.ownerAgentId ? await getAgent(action.ownerAgentId) : null;
      const sourceAssignee = fresh.assigneeAgentId ? await getAgent(fresh.assigneeAgentId) : null;
      let notice: SuccessfulRunHandoffNotice | null = null;
      if (recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
        notice = buildSuccessfulRunHandoffExhaustedNotice({
          issue: fresh,
          sourceRun: input.successfulRunHandoffEvidence.sourceRunId
            ? { id: input.successfulRunHandoffEvidence.sourceRunId, status: "succeeded" }
            : null,
          correctiveRun: input.latestRun ? { id: input.latestRun.id, status: input.latestRun.status } : null,
          sourceAssignee,
          recoveryIssue: null,
          recoveryActionId: action.id,
          recoveryOwner,
          latestIssueStatus: fresh.status,
          latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
          missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
        });
      }
      const recoveryLine = action.ownerAgentId
        ? [
          "",
          `- Recovery action: \`${action.id}\``,
          `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
          "- Next action: the recovery owner should restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
        ].join("\n")
        : [
          "",
          `- Recovery action: \`${action.id}\``,
          "- Recovery owner: board escalation, because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
          "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
        ].join("\n");

      const shouldPostEscalationComment =
        action.attemptCount === 1 || recoveryCause === "workspace_validation_failed";
      if (shouldPostEscalationComment) {
        const escalationCommentMarker = `Recovery action: \`${action.id}\``;
        const hasEscalationComment = await db
          .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, fresh.id), eq(issueComments.authorType, "system")))
          .orderBy(desc(issueComments.createdAt))
          .limit(50)
          .then((rows) =>
            rows.some((row) =>
              (row.body ?? "").includes(escalationCommentMarker) ||
              noticeMetadataReferencesRecoveryAction(row.metadata, action.id),
            ),
          );

        if (!hasEscalationComment) {
          if (notice) {
            await issuesSvc.addComment(fresh.id, notice.body, {}, {
              authorType: "system",
              presentation: notice.presentation,
              metadata: notice.metadata,
            });
          } else {
            await issuesSvc.addComment(
              fresh.id,
              `${input.comment ?? "Automatic stranded-work recovery needs manual attention."}${recoveryLine}`,
              {},
              { authorType: "system" },
            );
          }
        }
      }

      await logActivity(db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? "issue.successful_run_handoff_escalated"
          : "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "blocked",
          previousStatus: input.previousStatus,
          source: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
            ? "recovery.reconcile_successful_run_handoff_missing_state"
            : recoveryCause === "workspace_validation_failed"
              ? "recovery.reconcile_workspace_validation_failed"
              : "recovery.reconcile_stranded_assigned_issue",
          recoveryCause,
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryActionId: action.id,
          recoveryActionAttemptCount: action.attemptCount,
          recoveryOwnerAgentId: action.ownerAgentId,
          previousOwnerAgentId: action.previousOwnerAgentId,
          returnOwnerAgentId: action.returnOwnerAgentId,
          blockerIssueIds: blockerIds,
        },
      });

      if (needsHumanDecision) {
        const assigneeAgent = fresh.assigneeAgentId
          ? await db
            .select({ name: agents.name })
            .from(agents)
            .where(and(eq(agents.companyId, fresh.companyId), eq(agents.id, fresh.assigneeAgentId)))
            .limit(1)
            .then((rows) => rows[0] ?? null)
          : null;
        await emitNeedsHumanDecisionEscalationEvent({
          issue: fresh,
          assigneeAgentName: assigneeAgent?.name ?? null,
          blockedByIssueIds: blockerIds,
        });
      }

      return updated;
    });
  }

  function buildZeroTokenStartupFailureComment(input: {
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    const errorCode = readNonEmptyString(input.latestRun?.errorCode) ?? "context_overflow";
    const verb = input.previousStatus === "todo" ? "dispatch" : "continuation";
    return (
      `Paperclip skipped automatic ${verb} recovery for this assigned \`${input.previousStatus}\` issue ` +
      `because the last run failed with \`${errorCode}\` and burned zero tokens — a structural, pre-model ` +
      "startup wedge (a poisoned/oversized session, or a model-config mismatch), not a transient failure. " +
      "A `stranded_issue_recovery` wrapper would just re-invoke the same wedged session and loop, so none " +
      "was created (see BLO-5681). Moving it to `blocked` so the chain-of-command owner can clear the wedge " +
      "(reset the session, fix the adapter config, or reassign) before work resumes. The invariant will not " +
      "re-fire until the issue leaves `blocked` and a non-zero-token run completes."
    );
  }

  // BLO-5681: when a stranded issue's latest terminal failure is a structural,
  // zero-token pre-model startup wedge (context_overflow / context_length_exceeded
  // / startup_error_pre_model), escalate the source straight to `blocked` WITHOUT
  // a `stranded_issue_recovery` wrapper. A wrapper re-runs the same wedged session
  // and produces another zero-token failed run — the BLO-5378 → BLO-5676 loop
  // (9 zero-token runs in ~1h). Because `reconcileStrandedAssignedIssues` only
  // scans `todo`/`in_progress`, a `blocked` issue is never re-swept, so this
  // escalation fires exactly once until a human moves the issue back; owner
  // attention is then routed through the standard blocked-issue liveness path.
  async function escalateZeroTokenStartupFailureIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    return await db.transaction(async (tx) => {
      // Serialize per (company, source-issue) so racing reconcile sweeps don't
      // double-escalate. Xact-scoped advisory lock, same key shape as
      // escalateStrandedAssignedIssue.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.issue.companyId} || ':' || ${input.issue.id}, 0))`,
      );

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      if (!fresh) return null;
      // Peer sweep already escalated this source under the lock.
      if (fresh.status === "blocked") return fresh;

      const updated = await issuesSvc.update(input.issue.id, { status: "blocked" });
      if (!updated) return null;

      await issuesSvc.addComment(
        input.issue.id,
        buildZeroTokenStartupFailureComment({
          previousStatus: input.previousStatus,
          latestRun: input.latestRun,
        }),
        {},
      );

      await logActivity(db, {
        companyId: input.issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: input.issue.id,
        details: {
          identifier: input.issue.identifier,
          status: "blocked",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_stranded_assigned_issue.zero_token_startup_failure",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryWrapperSuppressed: true,
        },
      });

      return updated;
    });
  }

  async function reconcileStrandedAssignedIssues() {
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
        ),
      );

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      reviewWaitingParked: 0,
      escalated: 0,
      zeroTokenStartupFailureBlocked: 0,
      skipped: 0,
      issueIds: [] as string[],
    };

    for (const issue of candidates) {
      const agentId = issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      const agent = await getAgent(agentId);
      if (!agent || agent.companyId !== issue.companyId || !(await isAgentInvokable(agent))) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const latestRun = await getLatestIssueRun(issue.companyId, issue.id);
      if (isQuotaExhaustedTerminalRun(latestRun)) {
        result.skipped += 1;
        continue;
      }
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        // BLO-7521 (2026-05-25) / BLO-8050 (2026-05-28): if the operator just
        // manually unblocked this recovery-origin issue, give the agent a
        // fresh run window before re-escalating. See
        // `latestRunPredatesLatestUnblock` for the full rationale.
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          result.skipped += 1;
          continue;
        }
        const updated = await escalateStrandedRecoveryIssueInPlace({
          issue,
          previousStatus: issue.status as "todo" | "in_progress",
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueInitialAssignedTodoDispatch(issue, agentId);
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        if (isNonRetryableTerminalRun(latestRun)) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment: buildNonRetryableEscalationComment({ status: "todo", latestRun }),
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (isZeroTokenStartupFailureRun(latestRun)) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const updated = await escalateZeroTokenStartupFailureIssue({
            issue,
            previousStatus: "todo",
            latestRun,
          });
          if (updated) {
            result.escalated += 1;
            result.zeroTokenStartupFailureBlocked += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
              `but it still has no live execution path.${failureSummary ?? ""} ` +
              "Moving it to `blocked` so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          issueId: issue.id,
          agentId,
          reason: "issue_assignment_recovery",
          retryReason: "assignment_recovery",
          source: "issue.assignment_recovery",
          retryOfRunId: latestRun.id,
        });
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (!latestRun && !issue.checkoutRunId && !issue.executionRunId) {
        result.skipped += 1;
        continue;
      }
      if (isWaitingOnReviewContinuationRun(latestRun) && hasActiveMonitorPath(issue)) {
        const updated = await parkReviewWaitingContinuationIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
        });
        if (updated) {
          result.reviewWaitingParked += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        if (isProductiveContinuationRun(latestRun)) {
          if (isRepeatedProductiveContinuationRecovery(latestRun)) {
            result.productiveContinuationObserved += 1;
            result.skipped += 1;
            continue;
          }
          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }
          const queued = await enqueueStrandedIssueRecovery({
            issueId: issue.id,
            agentId,
            reason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.productive_terminal_continuation_recovery",
            retryOfRunId: latestRun.id,
          });
          if (queued) {
            if (isAutomaticContinuationRun(latestRun)) {
              result.productiveContinuationObserved += 1;
            } else {
              result.continuationRequeued += 1;
              result.issueIds.push(issue.id);
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }
        // Non-productive succeeded run: most stranding pattern is the agent
        // exiting cleanly with no actionable output (plan_only / empty
        // response / null liveness), the harness posting "No response
        // requested." and the next sweep waking the agent again. Each
        // iteration burns provider quota for zero forward progress.
        // Look back across recent runs; if the consecutive non-productive
        // streak has hit the threshold, escalate to blocked instead of
        // waking the agent yet another time.
        result.successfulContinuationObserved += 1;
        const nonProductiveStreak = await countConsecutiveNonProductiveSuccessfulRuns(
          issue.companyId,
          issue.id,
          NON_PRODUCTIVE_RUN_NOOP_THRESHOLD,
        );
        if (nonProductiveStreak >= NON_PRODUCTIVE_RUN_NOOP_THRESHOLD) {
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            comment:
              `Paperclip detected ${nonProductiveStreak} consecutive succeeded heartbeat runs producing no actionable output ` +
              "(livenessState ∈ plan_only / empty_response / failed / null) — the \"No response requested.\" no-op loop. " +
              "Moving to `blocked` so an operator can investigate (assignee may be missing a tool/MCP, or the issue " +
              "needs a clearer next step) instead of burning more provider quota waking the same agent.",
          });
          if (updated) {
            logger.info(
              {
                companyId: issue.companyId,
                issueId: issue.id,
                identifier: issue.identifier,
                streak: nonProductiveStreak,
                threshold: NON_PRODUCTIVE_RUN_NOOP_THRESHOLD,
              },
              "stranded-assigned issue escalated to blocked: non-productive run streak exceeded threshold",
            );
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        continue;
      }
      if (isNonRetryableTerminalRun(latestRun)) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          comment: buildNonRetryableEscalationComment({ status: "in_progress", latestRun }),
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isZeroTokenStartupFailureRun(latestRun)) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const updated = await escalateZeroTokenStartupFailureIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.zeroTokenStartupFailureBlocked += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isUnsuccessfulTerminalIssueRun(latestRun)) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const classification = classifyContinuationFailure(latestRun);

        if (classification.kind === "non_retryable") {
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            comment:
              "Paperclip detected a non-retryable failure on this issue's continuation run " +
              `(\`${classification.errorCode}\`). Skipping automatic retries and moving it to \`blocked\` ` +
              `so it is visible for intervention.${failureSummary ?? ""}`,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")) {
          const { consecutive, latestFinishedAt } = await summarizeRecentContinuationRetries(
            issue.companyId,
            issue.id,
            classification.errorCode,
          );
          if (consecutive >= classification.maxAttempts) {
            const failureSummary = summarizeRunFailureForIssueComment(latestRun);
            const attemptCopy = consecutive <= 1 ? "" : ` (${consecutive}× attempts)`;
            const causeCopy = classification.errorCode
              ? ` Latest cause: \`${classification.errorCode}\`.`
              : "";
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: "in_progress",
              latestRun,
              comment:
                "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
                `execution disappeared, but it still has no live execution path${attemptCopy}.${causeCopy}${failureSummary ?? ""} ` +
                "Moving it to `blocked` so it is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          if (classification.baseBackoffMs > 0 && latestFinishedAt) {
            const elapsed = Date.now() - latestFinishedAt.getTime();
            const requiredDelay = classification.baseBackoffMs *
              Math.pow(2, Math.max(0, consecutive - 1));
            if (elapsed < requiredDelay) {
              result.skipped += 1;
              continue;
            }
          }
        }
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        retryOfRunId: latestRun?.id ?? issue.checkoutRunId ?? null,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    return result;
  }

  async function collectIssueGraphLivenessFindings() {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
    ] = await Promise.all([
      db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          executionState: issues.executionState,
          lastActivityAt: issues.lastActivityAt,
        })
        .from(issues)
        .where(
          and(
            isNull(issues.hiddenAt),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
          ),
        ),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          title: agents.title,
          status: agents.status,
          reportsTo: agents.reportsTo,
        })
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            isNull(issues.hiddenAt),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            isNull(issues.hiddenAt),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
            })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
              ),
            );
      }),
    ]);

    const openRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (!parsed || parsed.companyId !== row.companyId) return [];
        return [
          {
            companyId: row.companyId,
            issueId: parsed.issueId,
            status: row.status,
          },
          {
            companyId: row.companyId,
            issueId: parsed.leafIssueId,
            status: row.status,
          },
        ];
      }

      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    return classifyIssueGraphLiveness({
      issues: issueRows,
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      openRecoveryIssues: openRecoveryIssues.concat(recoveryActionRows),
      now: new Date(),
    });
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  async function removeRecoveryBlockerFromSource(recovery: typeof issues.$inferSelect) {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return false;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return false;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return false;
    await issuesSvc.update(sourceIssue.id, {
      blockedByIssueIds: blockerIds.filter((blockerId) => blockerId !== recovery.id),
    });
    return true;
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  async function retireObsoleteLivenessRecoveryIssues(findings: IssueLivenessFinding[]) {
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      blockerRelationsRemoved: 0,
      retiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      const sourceIssue = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, parsed.companyId), eq(issues.id, parsed.issueId)))
        .then((rows) => rows[0] ?? null);
      if (sourceIssue && !["done", "cancelled"].includes(sourceIssue.status)) {
        const blockerIds = await existingBlockerIssueIds(parsed.companyId, sourceIssue.id);
        if (blockerIds.includes(recovery.id)) {
          result.activeSkipped += 1;
          continue;
        }
      }
      if (await removeRecoveryBlockerFromSource(recovery)) {
        result.blockerRelationsRemoved += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
    }

    return result;
  }

  async function retireDoneLivenessRecoveryBlockers() {
    const closedRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let blockerRelationsRemoved = 0;
    for (const recovery of closedRecoveries) {
      if (await removeRecoveryBlockerFromSource(recovery)) {
        blockerRelationsRemoved += 1;
      }
    }

    return { blockerRelationsRemoved };
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  /**
   * Load `lastActivityAt` for every recoveryIssue referenced by the
   * findings (and, defensively, every dependency hop). Used by the
   * staleness gate to decide which findings have been silently stuck
   * long enough to escalate.
   *
   * Pre-2026-05-06 RCA this loaded `updatedAt` for dependencyPath entries
   * only and the gate REQUIRED activity within the lookback window --
   * which silently quarantined any finding whose recoveryIssue wasn't
   * also a dependency, and any finding whose entire chain went quiet for
   * longer than 24h. We now key off the recoveryIssue itself, with
   * `lastActivityAt` (status flips, comments, assignment changes) as the
   * primary clock so that pure-metadata writes don't reset staleness.
   */
  async function loadLivenessRecoveryIssueLastActivityByKey(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => [
          finding.recoveryIssueId,
          ...finding.dependencyPath.map((entry) => entry.issueId),
        ]),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        lastActivityAt: issues.lastActivityAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.lastActivityAt ?? row.updatedAt,
    ]));
  }

  function recoveryIssueLastActivityForFinding(
    finding: IssueLivenessFinding,
    activityByIssueKey: Map<string, Date>,
  ) {
    const directKey = livenessDependencyIssueKey(finding.companyId, finding.recoveryIssueId);
    const directHit = activityByIssueKey.get(directKey);
    if (directHit) return directHit;
    // Fallback: walk dependency hops and take the OLDEST observed
    // activity. The gate logic below escalates when this is older than
    // the staleness threshold; using the oldest dep ensures we don't
    // refuse to escalate just because some dep upstream got touched
    // recently.
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds
      .map((issueId) => activityByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)))
      .filter((timestamp): timestamp is Date => Boolean(timestamp));
    if (timestamps.length === 0) return null;
    return timestamps.reduce((oldest, current) => (current < oldest ? current : oldest), timestamps[0]!);
  }

  /**
   * Inverted from the original "is the finding's dependency activity
   * within the lookback window?" gate. The recoveryIssue must be STALE
   * for at least `staleThresholdMs` to qualify for auto-recovery --
   * recently-touched issues aren't yet stuck (operator may still be
   * acting on them), and the longer-since-touched the finding is, the
   * more it deserves escalation.
   */
  function isLivenessFindingStaleEnoughForEscalation(
    finding: IssueLivenessFinding,
    staleAt: Date,
    activityByIssueKey: Map<string, Date>,
  ) {
    const lastActivityAt = recoveryIssueLastActivityForFinding(finding, activityByIssueKey);
    // No activity record at all -> definitely stale (defensive: an issue
    // missing from the activity map is either deleted or pre-dates the
    // lastActivityAt column backfill; either way escalation is safe and
    // the finding-suppression elsewhere will dedupe duplicates).
    if (!lastActivityAt) return true;
    return lastActivityAt <= staleAt;
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: { lookbackHours?: number; now?: Date },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    // `lookbackHours` is now a min-staleness threshold (post-2026-05-06
    // RCA gate inversion). A finding is escalation-eligible when its
    // recoveryIssue hasn't seen meaningful activity since this cutoff.
    const staleAt = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const activityByIssueKey = await loadLivenessRecoveryIssueLastActivityByKey(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedNotYetStale = 0;

    for (const finding of findings) {
      const lastActivityAt = recoveryIssueLastActivityForFinding(finding, activityByIssueKey);
      if (!isLivenessFindingStaleEnoughForEscalation(finding, staleAt, activityByIssueKey)) {
        skippedNotYetStale += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: lastActivityAt?.toISOString() ?? null,
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: staleAt.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback: skippedNotYetStale,
      items,
    };
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  async function ensureIssueBlockedByEscalation(input: {
    issue: typeof issues.$inferSelect;
    escalationIssueId: string;
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const blockerIds = await existingBlockerIssueIds(input.issue.companyId, input.issue.id);
    const nextBlockerIds = [...new Set([...blockerIds, input.escalationIssueId])];
    const isAlreadyBlockedByEscalation = blockerIds.includes(input.escalationIssueId);
    const isAlreadyBlocked = input.issue.status === "blocked";
    if (isAlreadyBlockedByEscalation && isAlreadyBlocked) {
      return input.issue;
    }

    const update: Partial<typeof issues.$inferInsert> & { blockedByIssueIds: string[] } = {
      blockedByIssueIds: nextBlockerIds,
    };
    if (!isAlreadyBlocked) {
      update.status = "blocked";
    }

    const updated = await issuesSvc.update(input.issue.id, update);
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.runId ?? null,
      action: "issue.blockers.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        blockerIssueIds: nextBlockerIds,
        escalationIssueId: input.escalationIssueId,
        status: update.status ?? input.issue.status,
        previousStatus: input.issue.status,
      },
    });

    return updated;
  }

  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: existing.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${issue.identifier ?? issue.id}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw error;
      await ensureIssueBlockedByEscalation({
        issue,
        escalationIssueId: raced.id,
        finding: input.finding,
        runId: input.runId ?? null,
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await ensureIssueBlockedByEscalation({
      issue,
      escalationIssueId: escalation.id,
      finding: input.finding,
      runId: input.runId ?? null,
    });

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
  }) {
    const findings = await collectIssueGraphLivenessFindings();
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = new Date();
    // `lookbackHours` is now a min-staleness threshold (post-2026-05-06
    // RCA gate inversion). Escalate when an issue has been silently quiet
    // for at least this long.
    const staleAt = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings);
    const activityByIssueKey = await loadLivenessRecoveryIssueLastActivityByKey(findings);
    const doneRecoveryBlockerCleanup = await retireDoneLivenessRecoveryBlockers();
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: staleAt.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      doneRecoveryBlockerRelationsRemoved: doneRecoveryBlockerCleanup.blockerRelationsRemoved,
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
    };

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingStaleEnoughForEscalation(finding, staleAt, activityByIssueKey)) {
        // Field name preserved for back-compat with existing telemetry/dashboards.
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  // Surface a pool that never recovered within the ccrotate auto-retry budget
  // (PEN-382). Coalesced per (company, ccrotate target): a pool outage exhausts
  // many agents' retries at once, so the escalation is keyed on the target —
  // one open issue per pool, not one per cancelled run.
  async function escalateCcrotateCapacityExhausted(input: {
    companyId: string;
    ccrotateTarget: string;
    agentId: string;
    agentName: string | null;
    runId: string;
    attempts: number;
  }): Promise<{ kind: "created" | "coalesced"; issueId: string }> {
    const originId = input.ccrotateTarget;
    const findOpen = () =>
      db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted),
            eq(issues.originId, originId),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

    const existing = await findOpen();
    if (existing) return { kind: "coalesced", issueId: existing.id };

    const agentLabel = input.agentName
      ? `${input.agentName} (${input.agentId})`
      : input.agentId;
    try {
      const created = await issuesSvc.create(input.companyId, {
        title: `ccrotate pool exhausted — ${input.ccrotateTarget}`,
        description: [
          `The ccrotate capacity pool **${input.ccrotateTarget}** did not recover within the auto-retry budget.`,
          "",
          `- Agent: ${agentLabel}`,
          `- Cancelled run: ${input.runId}`,
          `- Retry attempts before giving up: ${input.attempts}`,
          "",
          "Agent runs are deferring and then cancelling because no account in this pool has usable capacity and none reported a future reset within the retry window. This usually needs a ccrotate token refresh / capacity top-up rather than agent action. This issue is coalesced per pool, so it represents the whole outage rather than a single run — mark it done once the pool recovers.",
        ].join("\n"),
        status: "todo",
        priority: "high",
        originKind: RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted,
        originId,
      });
      return { kind: "created", issueId: created.id };
    } catch (error) {
      // Lost the check-then-create race to a concurrent exhaustion of the same
      // pool. The partial unique index issues_active_ccrotate_capacity_exhaustion_uq
      // guarantees only one open escalation per (company, target), so coalesce
      // onto whoever won the insert rather than surfacing the conflict. PEN-382.
      const conflict = unwrapDatabaseConflictError(error);
      const isDedupeConflict =
        conflict?.code === "23505" &&
        (conflict.constraint === "issues_active_ccrotate_capacity_exhaustion_uq" ||
          (typeof conflict.message === "string" &&
            conflict.message.includes("issues_active_ccrotate_capacity_exhaustion_uq")));
      if (!isDedupeConflict) throw error;
      const winner = await findOpen();
      if (winner) return { kind: "coalesced", issueId: winner.id };
      throw error;
    }
  }

  // Backstop sweeper: clears stale lock columns on issues whose checkoutRunId
  // or executionRunId points at a heartbeat_runs row that is either missing or
  // in a terminal status. Provides self-heal for stale locks that fell outside
  // releaseIssueExecutionAndPromote / clearCheckoutRunIfTerminal / adoption.
  // Idempotent and safe: clears at most one row's worth of lock columns per
  // candidate, and only when the referenced run row is unambiguously terminal.
  async function sweepStaleIssueLocks() {
    const result = {
      cleared: 0,
      issueIds: [] as string[],
    };

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(
        sql`(${issues.checkoutRunId} is not null or ${issues.executionRunId} is not null)`,
      );

    const referencedRunIds = [
      ...new Set(
        candidates
          .flatMap((issue) => [issue.checkoutRunId, issue.executionRunId])
          .filter((id): id is string => !!id),
      ),
    ];
    const runRows =
      referencedRunIds.length > 0
        ? await db
            .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, referencedRunIds))
        : [];
    const runStatusById = new Map<string, string>();
    for (const row of runRows) runStatusById.set(row.id, row.status);

    const isCleanable = (runId: string | null) => {
      if (!runId) return true;
      const status = runStatusById.get(runId);
      if (!status) return true; // missing run row → no real claim
      return TERMINAL_HEARTBEAT_RUN_STATUSES.has(status);
    };

    for (const issue of candidates) {
      if (!isCleanable(issue.checkoutRunId) || !isCleanable(issue.executionRunId)) {
        continue;
      }

      const updated = await db
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issue.id),
            issue.checkoutRunId
              ? eq(issues.checkoutRunId, issue.checkoutRunId)
              : isNull(issues.checkoutRunId),
            issue.executionRunId
              ? eq(issues.executionRunId, issue.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      if (!updated) continue;

      result.cleared += 1;
      result.issueIds.push(updated.id);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.stale_lock_cleared",
        entityType: "issue",
        entityId: updated.id,
        details: {
          source: "recovery.sweep_stale_issue_locks",
          clearedCheckoutRunId: issue.checkoutRunId,
          clearedExecutionRunId: issue.executionRunId,
          referencedRunStatuses: Object.fromEntries(runStatusById),
        },
      });
    }

    if (result.cleared > 0) {
      logger.warn(
        { cleared: result.cleared, issueIds: result.issueIds },
        "swept stale issue lock columns",
      );
    }

    return result;
  }

  return {
    buildRunOutputSilence,
    escalateCcrotateCapacityExhausted,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    dismissStaleEvaluationOnRunTerminated,
    reconcileStrandedAssignedIssues,
    sweepStaleIssueLocks,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileIssueGraphLiveness,
    readRecoveryTimerIntervalMs,
  };
}
