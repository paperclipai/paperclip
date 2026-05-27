import type { Agent } from "@paperclipai/shared";
import type { CompanyUserProfile } from "./company-members";
import { isKoreanLocale } from "@/i18n/locale-utils";

type ActivityDetails = Record<string, unknown> | null | undefined;

type ActivityParticipant = {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
};

type ActivityIssueReference = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

interface ActivityFormatOptions {
  agentMap?: Map<string, Agent>;
  userProfileMap?: Map<string, CompanyUserProfile>;
  currentUserId?: string | null;
  locale?: string | null;
}

const ACTIVITY_ROW_VERBS: Record<string, string> = {
  "issue.created": "created",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.comment_cancelled": "cancelled a queued comment on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_locked": "locked document on",
  "issue.document_unlocked": "unlocked document on",
  "issue.document_deleted": "deleted document from",
  "issue.monitor_scheduled": "scheduled monitor on",
  "issue.monitor_triggered": "triggered monitor for",
  "issue.monitor_cleared": "cleared monitor on",
  "issue.monitor_skipped": "skipped monitor for",
  "issue.monitor_exhausted": "exhausted monitor on",
  "issue.monitor_recovery_wake_queued": "queued monitor recovery for",
  "issue.monitor_recovery_issue_created": "created monitor recovery for",
  "issue.monitor_escalated_to_board": "escalated monitor for",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
  "issue.successful_run_handoff_required": "flagged missing next step on",
  "issue.successful_run_handoff_resolved": "recorded next step chosen on",
  "issue.successful_run_handoff_escalated": "escalated missing next step on",
  "issue.recovery_action_opened": "opened a recovery action on",
  "issue.recovery_action_resolved": "resolved the recovery action on",
  "issue.recovery_action_escalated": "escalated the recovery action on",
  "agent.created": "created",
  "agent.updated": "updated",
  "agent.paused": "paused",
  "agent.resumed": "resumed",
  "agent.terminated": "terminated",
  "agent.key_created": "created API key for",
  "agent.budget_updated": "updated budget for",
  "agent.runtime_session_reset": "reset session for",
  "heartbeat.invoked": "invoked heartbeat for",
  "heartbeat.cancelled": "cancelled heartbeat for",
  "heartbeat.output_stale_source_resolved": "system-folded stale run on",
  "heartbeat.output_stale_recovery_recursion_refused": "refused recovery-on-recovery for",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
  "project.created": "created",
  "project.updated": "updated",
  "project.deleted": "deleted",
  "goal.created": "created",
  "goal.updated": "updated",
  "goal.deleted": "deleted",
  "cost.reported": "reported cost for",
  "cost.recorded": "recorded cost for",
  "company.created": "created company",
  "company.updated": "updated company",
  "company.archived": "archived",
  "company.budget_updated": "updated budget for",
  "asset.created": "created asset",
  "issue.read_marked": "marked issue read",
};

const ACTIVITY_ROW_VERBS_KO: Record<string, string> = {
  "issue.created": "작업 생성",
  "issue.updated": "작업 수정",
  "issue.checked_out": "작업 체크아웃",
  "issue.released": "작업 해제",
  "issue.comment_added": "댓글 작성",
  "issue.comment_cancelled": "대기 댓글 취소",
  "issue.attachment_added": "파일 첨부",
  "issue.attachment_removed": "첨부 제거",
  "issue.document_created": "문서 생성",
  "issue.document_updated": "문서 수정",
  "issue.document_locked": "문서 잠금",
  "issue.document_unlocked": "문서 잠금 해제",
  "issue.document_deleted": "문서 삭제",
  "issue.monitor_scheduled": "모니터 예약",
  "issue.monitor_triggered": "모니터 실행",
  "issue.monitor_cleared": "모니터 해제",
  "issue.monitor_skipped": "모니터 건너뜀",
  "issue.monitor_exhausted": "모니터 한도 소진",
  "issue.monitor_recovery_wake_queued": "모니터 복구 실행 대기",
  "issue.monitor_recovery_issue_created": "모니터 복구 작업 생성",
  "issue.monitor_escalated_to_board": "모니터 보드 에스컬레이션",
  "issue.commented": "댓글 작성",
  "issue.deleted": "작업 삭제",
  "issue.successful_run_handoff_required": "다음 단계 누락 표시",
  "issue.successful_run_handoff_resolved": "다음 단계 선택 기록",
  "issue.successful_run_handoff_escalated": "다음 단계 누락 에스컬레이션",
  "issue.recovery_action_opened": "복구 작업 열기",
  "issue.recovery_action_resolved": "복구 작업 해결",
  "issue.recovery_action_escalated": "복구 작업 에스컬레이션",
  "agent.created": "직원 생성",
  "agent.updated": "직원 수정",
  "agent.paused": "직원 일시정지",
  "agent.resumed": "직원 재개",
  "agent.terminated": "직원 종료",
  "agent.key_created": "직원 API 키 생성",
  "agent.budget_updated": "직원 예산 수정",
  "agent.runtime_session_reset": "직원 세션 초기화",
  "heartbeat.invoked": "상태 점검 실행",
  "heartbeat.cancelled": "상태 점검 취소",
  "heartbeat.output_stale_source_resolved": "오래된 실행 자동 정리",
  "heartbeat.output_stale_recovery_recursion_refused": "복구 반복 거부",
  "approval.created": "승인 요청",
  "approval.approved": "승인",
  "approval.rejected": "반려",
  "project.created": "프로젝트 생성",
  "project.updated": "프로젝트 수정",
  "project.deleted": "프로젝트 삭제",
  "goal.created": "목표 생성",
  "goal.updated": "목표 수정",
  "goal.deleted": "목표 삭제",
  "cost.reported": "비용 보고",
  "cost.recorded": "비용 기록",
  "company.created": "회사 생성",
  "company.updated": "회사 수정",
  "company.archived": "회사 보관",
  "company.budget_updated": "회사 예산 수정",
  "asset.created": "자산 생성",
  "issue.read_marked": "작업 읽음 표시",
};

const ISSUE_ACTIVITY_LABELS: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.comment_cancelled": "cancelled a queued comment",
  "issue.feedback_vote_saved": "saved feedback on an AI output",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_locked": "locked a document",
  "issue.document_unlocked": "unlocked a document",
  "issue.document_deleted": "deleted a document",
  "issue.monitor_scheduled": "scheduled a monitor",
  "issue.monitor_triggered": "triggered a monitor",
  "issue.monitor_cleared": "cleared a monitor",
  "issue.monitor_skipped": "skipped a monitor",
  "issue.monitor_exhausted": "exhausted a monitor",
  "issue.monitor_recovery_wake_queued": "queued a monitor recovery wake",
  "issue.monitor_recovery_issue_created": "created a monitor recovery issue",
  "issue.monitor_escalated_to_board": "escalated a monitor to the board",
  "issue.deleted": "deleted the issue",
  "issue.successful_run_handoff_required": "Run finished without a clear next step",
  "issue.successful_run_handoff_resolved": "Next step chosen",
  "issue.successful_run_handoff_escalated": "Run finished without a next step - recovery escalated",
  "issue.recovery_action_opened": "Opened a source-scoped recovery action",
  "issue.recovery_action_resolved": "Resolved the recovery action",
  "issue.recovery_action_escalated": "Escalated the recovery action",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "heartbeat.output_stale_source_resolved": "System folded a stale run",
  "heartbeat.output_stale_recovery_recursion_refused": "Refused recovery-on-recovery escalation",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown, locale?: string | null): string {
  if (typeof value !== "string") return String(value ?? "none");
  if (isKoreanLocale(locale)) {
    const labels: Record<string, string> = {
      backlog: "대기",
      todo: "할 일",
      in_progress: "진행 중",
      in_review: "검토 중",
      done: "완료",
      cancelled: "취소",
      blocked: "막힘",
      critical: "긴급",
      high: "높음",
      medium: "보통",
      low: "낮음",
    };
    return labels[value] ?? value.replace(/_/g, " ");
  }
  return value.replace(/_/g, " ");
}

function isActivityParticipant(value: unknown): value is ActivityParticipant {
  const record = asRecord(value);
  if (!record) return false;
  return record.type === "agent" || record.type === "user";
}

function isActivityIssueReference(value: unknown): value is ActivityIssueReference {
  return asRecord(value) !== null;
}

function readParticipants(details: ActivityDetails, key: string): ActivityParticipant[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityParticipant);
}

function readIssueReferences(details: ActivityDetails, key: string): ActivityIssueReference[] {
  const value = details?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter(isActivityIssueReference);
}

function formatUserLabel(userId: string | null | undefined, options: ActivityFormatOptions = {}): string {
  if (!userId || userId === "local-board") return "Board";
  if (options.currentUserId && userId === options.currentUserId) return "You";
  const profile = options.userProfileMap?.get(userId);
  if (profile) return profile.label;
  return `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  return formatUserLabel(participant.userId, options);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return "issue";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails, locale?: string | null): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const korean = isKoreanLocale(locale);
  if (details.status !== undefined) {
    const from = previous.status;
    if (korean) {
      return from
        ? `상태를 ${humanizeValue(from, locale)}에서 ${humanizeValue(details.status, locale)}로 변경`
        : `상태를 ${humanizeValue(details.status, locale)}로 변경`;
    }
    return from
      ? `changed status from ${humanizeValue(from, locale)} to ${humanizeValue(details.status, locale)} on`
      : `changed status to ${humanizeValue(details.status, locale)} on`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    if (korean) {
      return from
        ? `우선순위를 ${humanizeValue(from, locale)}에서 ${humanizeValue(details.priority, locale)}으로 변경`
        : `우선순위를 ${humanizeValue(details.priority, locale)}으로 변경`;
    }
    return from
      ? `changed priority from ${humanizeValue(from, locale)} to ${humanizeValue(details.priority, locale)} on`
      : `changed priority to ${humanizeValue(details.priority, locale)} on`;
  }
  return null;
}

function formatAssigneeName(details: ActivityDetails, options: ActivityFormatOptions): string | null {
  if (!details) return null;
  const agentId = details.assigneeAgentId;
  const userId = details.assigneeUserId;
  if (typeof agentId === "string" && agentId) {
    return options.agentMap?.get(agentId)?.name ?? "agent";
  }
  if (typeof userId === "string" && userId) {
    return formatUserLabel(userId, options);
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails, options: ActivityFormatOptions = {}): string | null {
  if (!details) return null;
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      from
        ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
        : `changed the status to ${humanizeValue(details.status)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      from
        ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
        : `changed the priority to ${humanizeValue(details.priority)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    const assigneeName = formatAssigneeName(details, options);
    parts.push(assigneeName ? `assigned the issue to ${assigneeName}` : "unassigned the issue");
  }
  if (details.title !== undefined) parts.push("updated the title");
  if (details.description !== undefined) parts.push("updated the description");

  return parts.length > 0 ? parts.join(", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel("blocker", "blockers", removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? "updated blockers" : "updated blockers on";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated" ? "reviewer" : "approver";
    const plural = input.action === "issue.reviewers_updated" ? "reviewers" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return input.forIssueDetail ? `updated ${plural}` : `updated ${plural} on`;
  }

  return null;
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details, options.locale);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  if (isKoreanLocale(options.locale)) {
    return ACTIVITY_ROW_VERBS_KO[action] ?? action.replace(/[._]/g, " ");
  }

  return ACTIVITY_ROW_VERBS[action] ?? action.replace(/[._]/g, " ");
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details, options);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (action.startsWith("issue.monitor_") && details) {
    const serviceName = typeof details.serviceName === "string" && details.serviceName.trim()
      ? details.serviceName.trim()
      : null;
    const base = ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
    return serviceName ? `${base} for ${serviceName}` : base;
  }

  if (
    (
      action === "issue.document_created" ||
      action === "issue.document_updated" ||
      action === "issue.document_locked" ||
      action === "issue.document_unlocked" ||
      action === "issue.document_deleted"
    ) &&
    details
  ) {
    const key = typeof details.key === "string" ? details.key : "document";
    const title = typeof details.title === "string" && details.title ? ` (${details.title})` : "";
    return `${ISSUE_ACTIVITY_LABELS[action] ?? action} ${key}${title}`;
  }

  return ISSUE_ACTIVITY_LABELS[action] ?? action.replace(/[._]/g, " ");
}
