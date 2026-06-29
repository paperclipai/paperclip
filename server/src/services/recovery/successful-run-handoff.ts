import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation, RunLivenessState } from "@paperclipai/shared";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";

export const FINISH_SUCCESSFUL_RUN_HANDOFF_REASON = "finish_successful_run_handoff";
export const SUCCESSFUL_RUN_MISSING_STATE_REASON = "successful_run_missing_state";
export const DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1;
export const SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY =
  "Paperclip needs a disposition before this issue can continue.";
export const SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY =
  "Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner.";
export const LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_PREFIXES = [
  "## This issue still needs a next step",
  "## Successful run missing issue disposition",
] as const;

export const SUCCESSFUL_RUN_HANDOFF_OPTIONS = [
  "mark_done_or_cancelled",
  "send_for_review_or_ask_for_input",
  "mark_blocked",
  "delegate_or_continue_from_checkpoint",
] as const;

const PRODUCTIVE_SUCCESS_LIVENESS_STATES = new Set<RunLivenessState>([
  "advanced",
  "completed",
  "blocked",
  "needs_followup",
]);

const IDEMPOTENT_HANDOFF_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
];
const IDEMPOTENT_HANDOFF_WAKE_STATUS_SET = new Set<string>(IDEMPOTENT_HANDOFF_WAKE_STATUSES);

export function isIdempotentFinishSuccessfulRunHandoffWakeStatus(status: string) {
  return IDEMPOTENT_HANDOFF_WAKE_STATUS_SET.has(status);
}

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type IssueRow = Pick<
  typeof issues.$inferSelect,
  "id" | "companyId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId" | "executionState"
>;
type AgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "status">;
type NoticeIssue = Pick<typeof issues.$inferSelect, "id" | "identifier" | "title" | "status">;
type NoticeRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "status">;
type NoticeAgent = Pick<typeof agents.$inferSelect, "id" | "name">;
type NullableNoticeAgent = NoticeAgent | null | undefined;
type NullableNoticeIssue = NoticeIssue | null | undefined;
type NullableNoticeRun = NoticeRun | null | undefined;

export type SuccessfulRunHandoffNotice = {
  body: string;
  presentation: IssueCommentPresentation;
  metadata: IssueCommentMetadata;
};

export function noticeMetadataReferencesRecoveryAction(
  metadata: IssueCommentMetadata | null | undefined,
  recoveryActionId: string,
) {
  return (metadata?.sections ?? []).some((section) =>
    section.rows.some((row) =>
      row.type === "key_value" &&
      row.label === "Recovery action" &&
      row.value === recoveryActionId,
    ),
  );
}

export type SuccessfulRunHandoffDecision =
  | {
      kind: "enqueue";
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
      instruction: string;
    }
  | {
      kind: "skip";
      reason: string;
      /**
       * When the SOF-334 disposition-freshness gate (or its SOF-549 second
       * inclusion path) suppresses a would-be recovery, this names which
       * inclusion triggered the suppression. Surfaces in the Loki event key
       * `successful_run_missing_state.suppressed_by_disposition_freshness`
       * as a `gateInclusion` label so dashboards can split suppression by
       * signal source. Absent on skips for non-gate reasons.
       */
      gateInclusion?: "comment_post_run" | "in_place_status_transition";
    };

function metadataText(value: unknown, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  const resolved = text.length > 0 ? text : fallback;
  return resolved.length > 2000 ? `${resolved.slice(0, 1997)}...` : resolved;
}

function keyValueRow(label: string, value: unknown): IssueCommentMetadata["sections"][number]["rows"][number] {
  return { type: "key_value", label, value: metadataText(value) };
}

function issueLinkRow(
  label: string,
  issue: NullableNoticeIssue,
): IssueCommentMetadata["sections"][number]["rows"][number] {
  if (!issue) return keyValueRow(label, "unknown");
  return {
    type: "issue_link",
    label,
    issueId: issue.id,
    identifier: issue.identifier,
    title: issue.title,
  };
}

function runLinkRow(
  label: string,
  run: NullableNoticeRun,
): IssueCommentMetadata["sections"][number]["rows"][number] {
  if (!run) return keyValueRow(label, "unknown");
  return { type: "run_link", label, runId: run.id, title: run.status };
}

function agentLinkRow(
  label: string,
  agent: NullableNoticeAgent,
): IssueCommentMetadata["sections"][number]["rows"][number] {
  if (!agent) return keyValueRow(label, "unknown");
  return { type: "agent_link", label, agentId: agent.id, name: agent.name };
}

function systemNoticePresentation(input: {
  tone: IssueCommentPresentation["tone"];
  title: string;
}): IssueCommentPresentation {
  return {
    kind: "system_notice",
    tone: input.tone,
    title: input.title,
    detailsDefaultOpen: false,
  };
}

export function isSuccessfulRunHandoffRequiredNoticeBody(body: string) {
  const trimmed = body.trim();
  return trimmed === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY ||
    LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function buildSuccessfulRunHandoffRequiredNotice(input: {
  issue: NoticeIssue;
  run: NoticeRun;
  agent: NoticeAgent;
  detectedProgressSummary: string;
}): SuccessfulRunHandoffNotice {
  return {
    body: SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
    presentation: systemNoticePresentation({
      tone: "warning",
      title: "Missing issue disposition",
    }),
    metadata: {
      version: 1,
      sourceRunId: input.run.id,
      sections: [
        {
          title: "Required action",
          rows: [
            issueLinkRow("Source issue", input.issue),
            agentLinkRow("Assignee", input.agent),
            keyValueRow("Missing disposition", "clear_next_step"),
            keyValueRow(
              "Valid dispositions",
              "done, cancelled, in_review with an owner, blocked with blockers, delegated follow-up, or explicit continuation",
            ),
          ],
        },
        {
          title: "Run evidence",
          rows: [
            runLinkRow("Successful run", input.run),
            keyValueRow("Run status", input.run.status),
            keyValueRow("Normalized cause", SUCCESSFUL_RUN_MISSING_STATE_REASON),
            keyValueRow("Detected progress", input.detectedProgressSummary),
            keyValueRow("Automatic retry", "one corrective handoff wake queued"),
          ],
        },
      ],
    },
  };
}

export function buildSuccessfulRunHandoffExhaustedNotice(input: {
  issue: NoticeIssue;
  sourceRun: NullableNoticeRun;
  correctiveRun: NullableNoticeRun;
  sourceAssignee: NullableNoticeAgent;
  recoveryIssue: NullableNoticeIssue;
  recoveryActionId?: string | null;
  recoveryOwner: NullableNoticeAgent;
  latestIssueStatus: string;
  latestHandoffRunStatus: string;
  missingDisposition: string;
}): SuccessfulRunHandoffNotice {
  return {
    body: SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
    presentation: systemNoticePresentation({
      tone: "danger",
      title: "Missing disposition recovery blocked",
    }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections: [
        {
          title: "Recovery owner",
          rows: [
            issueLinkRow("Source issue", input.issue),
            input.recoveryActionId
              ? keyValueRow("Recovery action", input.recoveryActionId)
              : issueLinkRow("Recovery issue", input.recoveryIssue),
            agentLinkRow("Recovery owner", input.recoveryOwner),
            agentLinkRow("Source assignee", input.sourceAssignee),
            keyValueRow("Suggested action", "choose and record a valid issue disposition without copying transcript content"),
          ],
        },
        {
          title: "Run evidence",
          rows: [
            runLinkRow("Source run", input.sourceRun),
            runLinkRow("Corrective handoff run", input.correctiveRun),
            keyValueRow("Latest issue status", input.latestIssueStatus),
            keyValueRow("Latest handoff run status", input.latestHandoffRunStatus),
            keyValueRow("Normalized cause", SUCCESSFUL_RUN_MISSING_STATE_REASON),
            keyValueRow("Missing disposition", input.missingDisposition),
          ],
        },
      ],
    },
  };
}

export function buildFinishSuccessfulRunHandoffIdempotencyKey(input: {
  issueId: string;
  sourceRunId: string;
  attempt?: number;
}) {
  return [
    FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
    input.issueId,
    input.sourceRunId,
    String(input.attempt ?? 1),
  ].join(":");
}

export async function findExistingFinishSuccessfulRunHandoffWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, IDEMPOTENT_HANDOFF_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isCorrectiveHandoffRun(run: HeartbeatRunRow) {
  const context = readRecord(run.contextSnapshot);
  return context.handoffRequired === true ||
    readString(context.wakeReason) === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON;
}

function isIssueMonitorMaintenanceRun(run: HeartbeatRunRow) {
  const context = readRecord(run.contextSnapshot);
  const wakeReason = readString(context.wakeReason);
  const source = readString(context.source);
  return Boolean(wakeReason?.startsWith("issue_monitor") || source?.startsWith("issue.monitor"));
}

function isCommentDrivenWake(run: HeartbeatRunRow) {
  const context = readRecord(run.contextSnapshot);
  const wakeReason = readString(context.wakeReason);
  return wakeReason === "issue_commented" ||
    wakeReason === "issue_comment_mentioned" ||
    wakeReason === "issue_reopened_via_comment";
}

function isProductiveSuccessfulRun(input: {
  livenessState: RunLivenessState | null;
  detectedProgressSummary: string | null;
}) {
  if (input.livenessState && PRODUCTIVE_SUCCESS_LIVENESS_STATES.has(input.livenessState)) return true;
  return Boolean(input.detectedProgressSummary);
}

export function buildSuccessfulRunHandoffInstruction(input: {
  issueIdentifier: string | null;
  sourceRunId: string;
}) {
  const issueLabel = input.issueIdentifier ?? "this issue";
  return [
    `Your previous run on ${issueLabel} succeeded, but the issue is still in \`in_progress\` and Paperclip cannot identify a valid issue disposition.`,
    "",
    "Resolve the missing disposition before creating or revising any new artifacts. Choose **exactly one** outcome and perform the matching Paperclip action:",
    "",
    "**Is the issue finished?**",
    "1. Mark it `done` (scope complete) or `cancelled` (intentionally stopped).",
    "",
    "**Does someone else need to look at it?**",
    "2. Move it to `in_review` with a real reviewer path — `executionState.currentParticipant`, a human owner via `assigneeUserId`, a pending issue-thread interaction, or a linked pending approval.",
    "",
    "**Can it not continue right now?**",
    "3. Mark it `blocked` with first-class blockers (`blockedByIssueIds`) or a clearly named unblock owner/action.",
    "",
    "**Is there more work to do?**",
    `4. Either delegate follow-up work (create/link a follow-up issue and block this one on it, or close this issue if its scope is independently complete) or record an explicit continuation path with \`resumeIntent: true\`, \`resumeFromRunId: ${input.sourceRunId}\`, and a concrete next action. Do not perform the remaining source work in this recovery run; the follow-up/resume wake must use the normal model lane.`,
    "",
    "Comments, document revisions, work-product writes, and continuation summaries are supporting evidence only — they do not satisfy this handoff unless the issue state/path also records one valid disposition. If this wake is status-only recovery, document or plan updates are not allowed.",
  ].join("\n");
}

export function decideSuccessfulRunHandoff(input: {
  run: HeartbeatRunRow;
  issue: IssueRow | null;
  agent: AgentRow | null;
  livenessState: RunLivenessState | null;
  detectedProgressSummary: string | null;
  taskKey: string | null;
  hasActiveExecutionPath: boolean;
  hasQueuedWake: boolean;
  hasPendingInteractionOrApproval: boolean;
  hasExplicitBlockerPath: boolean;
  hasOpenRecoveryIssue: boolean;
  hasPauseHold: boolean;
  hasActiveRoutineContinuation: boolean;
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
  /**
   * True when the assignee authored an issue comment with `createdAt` strictly
   * greater than `run.finishedAt`. Indicates the agent has already recorded a
   * disposition after the run completed, so the scan-vs-PATCH race window has
   * resolved and a `successful_run_missing_state` recovery would be a false
   * positive. See SOF-334.
   */
  hasDispositionAfterRunFinished?: boolean;
  /**
   * True when the assignee authored a comment INSIDE the run window
   * (`run.startedAt <= comment.createdAt <= run.finishedAt`) with
   * `createdByRunId = run.id`, AND the issue's `updatedAt` advanced during
   * the run (proving the assignee PATCHed the issue during the heartbeat).
   *
   * This is the SOF-549 / SOF-69 inclusion path. The SOF-334 v1 gate
   * intentionally excluded `createdByRunId = run.id` to avoid suppressing
   * legitimate handoff wakes via run-internal bookkeeping comments. But on
   * continuous-acceptance epics, the assignee's disposition PATCH+comment
   * lands inside the run (e.g. as part of the closing heartbeat), the status
   * may revert to `in_progress` after the transition, and the comment carries
   * the disposition signal that the existing post-run check can't see.
   *
   * The status-transition proxy (`issue.updatedAt >= run.startedAt`) is the
   * minimum signal that distinguishes an in-place disposition comment from a
   * pure progress note: progress notes don't PATCH the issue row. Pairing the
   * in-place comment with a PATCH motion is the SOF-549 option-(a) contract.
   */
  hasInPlaceDispositionWithStatusTransition?: boolean;
}): SuccessfulRunHandoffDecision {
  const { run, issue, agent } = input;

  if (run.status !== "succeeded") return { kind: "skip", reason: "source run did not succeed" };
  if (isCorrectiveHandoffRun(run)) return { kind: "skip", reason: "source run is already a corrective handoff run" };
  if (isIssueMonitorMaintenanceRun(run)) return { kind: "skip", reason: "issue monitor run owns its own recovery path" };
  if (isCommentDrivenWake(run)) return { kind: "skip", reason: "comment-driven wake already owns the next action" };
  if (run.issueCommentStatus === "retry_queued" || run.issueCommentStatus === "retry_exhausted") {
    return { kind: "skip", reason: "missing issue comment retry owns the next action" };
  }
  if (!issue) return { kind: "skip", reason: "issue not found" };
  if (!agent) return { kind: "skip", reason: "agent not found" };
  if (issue.companyId !== run.companyId || agent.companyId !== run.companyId) {
    return { kind: "skip", reason: "company scope mismatch" };
  }
  if (issue.assigneeAgentId !== run.agentId) {
    return { kind: "skip", reason: "issue is no longer assigned to the source run agent" };
  }
  if (issue.assigneeUserId) return { kind: "skip", reason: "issue is human-owned" };
  if (issue.status !== "in_progress") return { kind: "skip", reason: `issue status ${issue.status} is a valid disposition` };
  if (issue.executionState) return { kind: "skip", reason: "issue has execution policy state" };
  if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
  }
  if (input.hasActiveRoutineContinuation) {
    return { kind: "skip", reason: "active routine continuation owns the next action" };
  }
  if (!isProductiveSuccessfulRun(input)) {
    return { kind: "skip", reason: "successful run did not produce handoff-relevant progress" };
  }
  if (input.hasActiveExecutionPath) return { kind: "skip", reason: "issue already has an active execution path" };
  if (input.hasQueuedWake) return { kind: "skip", reason: "issue already has a queued or deferred wake" };
  if (input.hasPendingInteractionOrApproval) {
    return { kind: "skip", reason: "pending interaction or approval owns the next action" };
  }
  if (input.hasExplicitBlockerPath) return { kind: "skip", reason: "explicit blocker path owns the next action" };
  if (input.hasOpenRecoveryIssue) return { kind: "skip", reason: "open recovery issue owns the ambiguity" };
  if (input.hasPauseHold) return { kind: "skip", reason: "issue is under an active pause hold" };
  if (input.budgetBlocked) return { kind: "skip", reason: "budget hard stop blocks corrective wake" };
  if (input.idempotentWakeExists) {
    return { kind: "skip", reason: "corrective handoff wake already exists for this source run" };
  }
  // GGU-SOF-334: disposition-freshness gate. If the agent already posted a
  // comment after the run finished (i.e. the disposition PATCH has landed
  // before this scan), the missing-disposition recovery would be a false
  // positive. Skip arming the corrective handoff wake. The agent has already
  // recorded its work; let the next normal-state scan observe the new comment
  // and reclassify if a real disposition gap is still present.
  if (input.hasDispositionAfterRunFinished) {
    return {
      kind: "skip",
      reason: "agent recorded a disposition after the run completed (scan-vs-PATCH race window resolved)",
      gateInclusion: "comment_post_run",
    };
  }
  // GGU-SOF-549: second inclusion path for the SOF-334 gate. The v1 gate
  // excludes `createdByRunId = run.id` to avoid suppressing legitimate
  // handoff wakes via run-internal bookkeeping comments. But the SOF-69
  // 15-flip shape shows a real gap: when the assignee's disposition
  // PATCH+comment lands inside the run (continuous-acceptance epic, in-place
  // closing heartbeat), the comment is excluded by the v1 clause even though
  // it IS disposition evidence. The fix: also accept an in-place assignee
  // comment paired with PATCH motion on the issue row. This is the smallest
  // change with the highest signal — progress notes don't PATCH the issue.
  if (input.hasInPlaceDispositionWithStatusTransition) {
    return {
      kind: "skip",
      reason:
        "agent recorded an in-place disposition with status-transition evidence (scan-vs-PATCH race resolved on closing heartbeat)",
      gateInclusion: "in_place_status_transition",
    };
  }

  const instruction = buildSuccessfulRunHandoffInstruction({
    issueIdentifier: issue.identifier,
    sourceRunId: run.id,
  });
  const payload = withRecoveryModelProfileHint({
    issueId: issue.id,
    taskId: issue.id,
    sourceIssueId: issue.id,
    sourceRunId: run.id,
    handoffRequired: true,
    handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    missingDisposition: "clear_next_step",
    validDispositionOptions: [...SUCCESSFUL_RUN_HANDOFF_OPTIONS],
    detectedProgressSummary: input.detectedProgressSummary,
    handoffAttempt: 1,
    maxHandoffAttempts: DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
    resumeIntent: true,
    followUpRequested: true,
    resumeFromRunId: run.id,
    ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    instruction,
  }, "status_only");

  return {
    kind: "enqueue",
    idempotencyKey: buildFinishSuccessfulRunHandoffIdempotencyKey({
      issueId: issue.id,
      sourceRunId: run.id,
    }),
    payload,
    instruction,
    contextSnapshot: withRecoveryModelProfileHint({
      ...payload,
      wakeReason: FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
      livenessState: input.livenessState,
    }, "status_only"),
  };
}
