import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type { IssueCommentMetadata, IssueCommentPresentation, RunLivenessState } from "@paperclipai/shared";
import { withRecoveryModelProfileHint } from "./model-profile-hint.js";
import {
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_PREFIXES,
  SUCCESSFUL_RUN_HANDOFF_OPTIONS,
  HANDOFF_NOTICE_TITLE_REQUIRED,
  HANDOFF_NOTICE_TITLE_EXHAUSTED,
  HANDOFF_SECTION_REQUIRED_ACTION,
  HANDOFF_SECTION_RUN_EVIDENCE,
  HANDOFF_SECTION_RECOVERY_OWNER,
  HANDOFF_LABEL_SOURCE_ISSUE,
  HANDOFF_LABEL_ASSIGNEE,
  HANDOFF_LABEL_MISSING_DISPOSITION,
  HANDOFF_LABEL_VALID_DISPOSITIONS,
  HANDOFF_LABEL_DETECTED_PROGRESS,
  HANDOFF_LABEL_AUTOMATIC_RETRY,
  HANDOFF_LABEL_RECOVERY_ISSUE,
  HANDOFF_LABEL_RECOVERY_OWNER as HANDOFF_LABEL_RECOVERY_OWNER_ZH,
  HANDOFF_LABEL_SOURCE_ASSIGNEE,
  HANDOFF_LABEL_SUGGESTED_ACTION,
  HANDOFF_LABEL_SOURCE_RUN,
  HANDOFF_LABEL_CORRECTIVE_HANDOFF_RUN,
  HANDOFF_LABEL_LATEST_ISSUE_STATUS,
  HANDOFF_LABEL_LATEST_HANDOFF_RUN_STATUS,
  HANDOFF_LABEL_NORMALIZED_CAUSE,
  HANDOFF_VALUE_ONE_RETRY_QUEUED,
  HANDOFF_VALUE_CHOOSE_DISPOSITION,
  HANDOFF_VALUE_VALID_DISPOSITIONS,
  RUN_LIVENESS_CONTINUATION_INSTRUCTION,
} from "./recovery-messages-zh.js";

// Re-export constants that other modules import directly
export {
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  LEGACY_SUCCESSFUL_RUN_HANDOFF_NOTICE_PREFIXES,
  SUCCESSFUL_RUN_HANDOFF_OPTIONS,
};

export const DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1;

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
      title: HANDOFF_NOTICE_TITLE_REQUIRED,
    }),
    metadata: {
      version: 1,
      sourceRunId: input.run.id,
      sections: [
        {
          title: HANDOFF_SECTION_REQUIRED_ACTION,
          rows: [
            issueLinkRow(HANDOFF_LABEL_SOURCE_ISSUE, input.issue),
            agentLinkRow(HANDOFF_LABEL_ASSIGNEE, input.agent),
            keyValueRow(HANDOFF_LABEL_MISSING_DISPOSITION, "clear_next_step"),
            keyValueRow(
              HANDOFF_LABEL_VALID_DISPOSITIONS,
              HANDOFF_VALUE_VALID_DISPOSITIONS,
            ),
          ],
        },
        {
          title: HANDOFF_SECTION_RUN_EVIDENCE,
          rows: [
            runLinkRow("成功运行", input.run),
            keyValueRow("运行状态", input.run.status),
            keyValueRow(HANDOFF_LABEL_NORMALIZED_CAUSE, SUCCESSFUL_RUN_MISSING_STATE_REASON),
            keyValueRow(HANDOFF_LABEL_DETECTED_PROGRESS, input.detectedProgressSummary),
            keyValueRow(HANDOFF_LABEL_AUTOMATIC_RETRY, HANDOFF_VALUE_ONE_RETRY_QUEUED),
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
      title: HANDOFF_NOTICE_TITLE_EXHAUSTED,
    }),
    metadata: {
      version: 1,
      sourceRunId: input.sourceRun?.id ?? null,
      sections: [
        {
          title: HANDOFF_SECTION_RECOVERY_OWNER,
          rows: [
            issueLinkRow(HANDOFF_LABEL_SOURCE_ISSUE, input.issue),
            issueLinkRow(HANDOFF_LABEL_RECOVERY_ISSUE, input.recoveryIssue),
            agentLinkRow(HANDOFF_LABEL_RECOVERY_OWNER_ZH, input.recoveryOwner),
            agentLinkRow(HANDOFF_LABEL_SOURCE_ASSIGNEE, input.sourceAssignee),
            keyValueRow(HANDOFF_LABEL_SUGGESTED_ACTION, HANDOFF_VALUE_CHOOSE_DISPOSITION),
          ],
        },
        {
          title: HANDOFF_SECTION_RUN_EVIDENCE,
          rows: [
            runLinkRow(HANDOFF_LABEL_SOURCE_RUN, input.sourceRun),
            runLinkRow(HANDOFF_LABEL_CORRECTIVE_HANDOFF_RUN, input.correctiveRun),
            keyValueRow(HANDOFF_LABEL_LATEST_ISSUE_STATUS, input.latestIssueStatus),
            keyValueRow(HANDOFF_LABEL_LATEST_HANDOFF_RUN_STATUS, input.latestHandoffRunStatus),
            keyValueRow(HANDOFF_LABEL_NORMALIZED_CAUSE, SUCCESSFUL_RUN_MISSING_STATE_REASON),
            keyValueRow(HANDOFF_LABEL_MISSING_DISPOSITION, input.missingDisposition),
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
  const issueLabel = input.issueIdentifier ?? "此事务";
  return [
    `你在 ${issueLabel} 上的上一次运行已成功，但此事务仍处于 \`in_progress\` 状态，且 Paperclip 无法识别有效的事务处置。`,
    "",
    "在创建或修改任何新工件之前，请先补全缺失的处置。选择**恰好一种**结果并执行对应的 Paperclip 操作：",
    "",
    "**事务是否已完成？**",
    "1. 将其标记为 `done`（范围已完成）或 `cancelled`（有意停止）。",
    "",
    "**是否需要其他人审阅？**",
    "2. 将其移至 `in_review` 并指定真实审阅路径 — `executionState.currentParticipant`、通过 `assigneeUserId` 指定人类负责人、待处理的 issue-thread 交互，或关联的待审批项。",
    "",
    "**是否当前无法继续？**",
    "3. 将其标记为 `blocked`，需提供一级阻塞项（`blockedByIssueIds`）或明确命名的解除负责人/动作。",
    "",
    "**是否还有更多工作要做？**",
    `4. 委派后续工作（创建/链接后续事务并阻塞此事务，或若此事务范围已独立完成则关闭此事务），或记录明确的续跑路径：\`resumeIntent: true\`、\`resumeFromRunId: ${input.sourceRunId}\` 以及具体的下一步操作。`,
    "",
    "评论、文档修订、工件写入与续跑总结仅作为佐证 — 除非事务状态/路径同时记录了一条有效处置，否则它们不能满足此次交接要求。",
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
  budgetBlocked: boolean;
  idempotentWakeExists: boolean;
}): SuccessfulRunHandoffDecision {
  const { run, issue, agent } = input;

  if (run.status !== "succeeded") return { kind: "skip", reason: "source run did not succeed" };
  if (isCorrectiveHandoffRun(run)) return { kind: "skip", reason: "source run is already a corrective handoff run" };
  if (isIssueMonitorMaintenanceRun(run)) return { kind: "skip", reason: "issue monitor run owns its own recovery path" };
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
