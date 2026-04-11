import type { Agent } from "@paperclipai/shared";
import { getRuntimeLocaleConfig } from "./runtime-locale";

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
  currentUserId?: string | null;
}

type ActivityPageLocale = string | null | undefined;

const ACTIVITY_PAGE_COPY = {
  en: {
    activity: "Activity",
    selectCompany: "Select a company to view activity.",
    filterByType: "Filter by type",
    allTypes: "All types",
    noActivityYet: "No activity yet.",
  },
  "zh-CN": {
    activity: "活动",
    selectCompany: "请选择一个公司以查看活动。",
    filterByType: "按类型筛选",
    allTypes: "全部类型",
    noActivityYet: "还没有活动记录。",
  },
} as const;

const ACTIVITY_TYPE_LABELS_ZH: Record<string, string> = {
  issue: "任务",
  agent: "智能体",
  project: "项目",
  goal: "目标",
  approval: "审批",
  heartbeat: "运行",
  cost: "成本",
  company: "公司",
};

const ACTIVITY_ROW_VERBS_EN: Record<string, string> = {
  "issue.created": "created",
  "issue.read_marked": "marked as read",
  "issue.updated": "updated",
  "issue.checked_out": "checked out",
  "issue.released": "released",
  "issue.comment_added": "commented on",
  "issue.attachment_added": "attached file to",
  "issue.attachment_removed": "removed attachment from",
  "issue.document_created": "created document for",
  "issue.document_updated": "updated document on",
  "issue.document_deleted": "deleted document from",
  "issue.commented": "commented on",
  "issue.deleted": "deleted",
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
};

const ACTIVITY_ROW_VERBS_ZH: Record<string, string> = {
  "issue.created": "创建了",
  "issue.read_marked": "标记为已读",
  "issue.updated": "更新了",
  "issue.checked_out": "检出了",
  "issue.released": "发布了",
  "issue.comment_added": "评论了",
  "issue.attachment_added": "添加了附件到",
  "issue.attachment_removed": "移除了附件自",
  "issue.document_created": "创建了文档于",
  "issue.document_updated": "更新了文档于",
  "issue.document_deleted": "删除了文档自",
  "issue.commented": "评论了",
  "issue.deleted": "删除了",
  "agent.created": "创建了",
  "agent.updated": "更新了",
  "agent.paused": "暂停了",
  "agent.resumed": "恢复了",
  "agent.terminated": "终止了",
  "agent.key_created": "为其创建了 API 密钥",
  "agent.budget_updated": "更新了预算于",
  "agent.runtime_session_reset": "重置了会话于",
  "heartbeat.invoked": "触发了心跳于",
  "heartbeat.cancelled": "取消了心跳于",
  "approval.created": "发起了审批",
  "approval.approved": "通过了",
  "approval.rejected": "拒绝了",
  "project.created": "创建了",
  "project.updated": "更新了",
  "project.deleted": "删除了",
  "goal.created": "创建了",
  "goal.updated": "更新了",
  "goal.deleted": "删除了",
  "cost.reported": "记录了成本于",
  "cost.recorded": "记录了成本于",
  "company.created": "创建了公司",
  "company.updated": "更新了公司",
  "company.archived": "归档了",
  "company.budget_updated": "更新了预算于",
};

const ISSUE_ACTIVITY_LABELS_EN: Record<string, string> = {
  "issue.created": "created the issue",
  "issue.read_marked": "marked the issue as read",
  "issue.updated": "updated the issue",
  "issue.checked_out": "checked out the issue",
  "issue.released": "released the issue",
  "issue.comment_added": "added a comment",
  "issue.feedback_vote_saved": "saved feedback on an AI output",
  "issue.attachment_added": "added an attachment",
  "issue.attachment_removed": "removed an attachment",
  "issue.document_created": "created a document",
  "issue.document_updated": "updated a document",
  "issue.document_deleted": "deleted a document",
  "issue.deleted": "deleted the issue",
  "agent.created": "created an agent",
  "agent.updated": "updated the agent",
  "agent.paused": "paused the agent",
  "agent.resumed": "resumed the agent",
  "agent.terminated": "terminated the agent",
  "heartbeat.invoked": "invoked a heartbeat",
  "heartbeat.cancelled": "cancelled a heartbeat",
  "approval.created": "requested approval",
  "approval.approved": "approved",
  "approval.rejected": "rejected",
};

const ISSUE_ACTIVITY_LABELS_ZH: Record<string, string> = {
  "issue.created": "创建了任务",
  "issue.read_marked": "将任务标记为已读",
  "issue.updated": "更新了任务",
  "issue.checked_out": "检出了任务",
  "issue.released": "发布了任务",
  "issue.comment_added": "添加了评论",
  "issue.feedback_vote_saved": "保存了 AI 输出反馈",
  "issue.attachment_added": "添加了附件",
  "issue.attachment_removed": "移除了附件",
  "issue.document_created": "创建了文档",
  "issue.document_updated": "更新了文档",
  "issue.document_deleted": "删除了文档",
  "issue.deleted": "删除了任务",
  "agent.created": "创建了智能体",
  "agent.updated": "更新了智能体",
  "agent.paused": "暂停了智能体",
  "agent.resumed": "恢复了智能体",
  "agent.terminated": "终止了智能体",
  "heartbeat.invoked": "触发了心跳",
  "heartbeat.cancelled": "取消了心跳",
  "approval.created": "发起了审批",
  "approval.approved": "通过了审批",
  "approval.rejected": "拒绝了审批",
};

const VALUE_LABELS_ZH: Record<string, string> = {
  none: "无",
  backlog: "待处理",
  todo: "待办",
  in_progress: "进行中",
  in_review: "评审中",
  done: "已完成",
  cancelled: "已取消",
  blocked: "已阻塞",
  low: "低",
  medium: "中",
  high: "高",
  critical: "紧急",
  local_board: "董事会",
  board: "董事会",
  system: "系统",
};

function isZhLocale(): boolean {
  return getRuntimeLocaleConfig().locale === "zh-CN";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeValue(value: unknown): string {
  const isZh = isZhLocale();
  if (typeof value !== "string") return String(value ?? (isZh ? "无" : "none"));
  const normalized = value.toLowerCase();
  if (isZh && VALUE_LABELS_ZH[normalized]) return VALUE_LABELS_ZH[normalized];
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

function formatUserLabel(userId: string | null | undefined, currentUserId?: string | null): string {
  const isZh = isZhLocale();
  if (!userId || userId === "local-board") return isZh ? "董事会" : "Board";
  if (currentUserId && userId === currentUserId) return isZh ? "你" : "You";
  return isZh ? `用户 ${userId.slice(0, 5)}` : `user ${userId.slice(0, 5)}`;
}

function formatParticipantLabel(participant: ActivityParticipant, options: ActivityFormatOptions): string {
  const isZh = isZhLocale();
  if (participant.type === "agent") {
    const agentId = participant.agentId ?? "";
    return options.agentMap?.get(agentId)?.name ?? (isZh ? "智能体" : "agent");
  }
  return formatUserLabel(participant.userId, options.currentUserId);
}

function formatIssueReferenceLabel(reference: ActivityIssueReference): string {
  if (reference.identifier) return reference.identifier;
  if (reference.title) return reference.title;
  if (reference.id) return reference.id.slice(0, 8);
  return isZhLocale() ? "任务" : "issue";
}

function formatChangedEntityLabel(
  singular: string,
  plural: string,
  labels: string[],
): string {
  const isZh = isZhLocale();
  if (labels.length <= 0) return plural;
  if (labels.length === 1) return `${singular} ${labels[0]}`;
  if (isZh) return `${labels.length}个${plural}`;
  return `${labels.length} ${plural}`;
}

function formatIssueUpdatedVerb(details: ActivityDetails): string | null {
  if (!details) return null;
  const isZh = isZhLocale();
  const previous = asRecord(details._previous) ?? {};
  if (details.status !== undefined) {
    const from = previous.status;
    if (isZh) {
      return from
        ? `将状态从 ${humanizeValue(from)} 改为 ${humanizeValue(details.status)}`
        : `将状态改为 ${humanizeValue(details.status)}`;
    }
    return from
      ? `changed status from ${humanizeValue(from)} to ${humanizeValue(details.status)} on`
      : `changed status to ${humanizeValue(details.status)} on`;
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    if (isZh) {
      return from
        ? `将优先级从 ${humanizeValue(from)} 改为 ${humanizeValue(details.priority)}`
        : `将优先级改为 ${humanizeValue(details.priority)}`;
    }
    return from
      ? `changed priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)} on`
      : `changed priority to ${humanizeValue(details.priority)} on`;
  }
  return null;
}

function formatIssueUpdatedAction(details: ActivityDetails): string | null {
  if (!details) return null;
  const isZh = isZhLocale();
  const previous = asRecord(details._previous) ?? {};
  const parts: string[] = [];

  if (details.status !== undefined) {
    const from = previous.status;
    parts.push(
      isZh
        ? from
          ? `将状态从 ${humanizeValue(from)} 改为 ${humanizeValue(details.status)}`
          : `将状态改为 ${humanizeValue(details.status)}`
        : from
          ? `changed the status from ${humanizeValue(from)} to ${humanizeValue(details.status)}`
          : `changed the status to ${humanizeValue(details.status)}`,
    );
  }
  if (details.priority !== undefined) {
    const from = previous.priority;
    parts.push(
      isZh
        ? from
          ? `将优先级从 ${humanizeValue(from)} 改为 ${humanizeValue(details.priority)}`
          : `将优先级改为 ${humanizeValue(details.priority)}`
        : from
          ? `changed the priority from ${humanizeValue(from)} to ${humanizeValue(details.priority)}`
          : `changed the priority to ${humanizeValue(details.priority)}`,
    );
  }
  if (details.assigneeAgentId !== undefined || details.assigneeUserId !== undefined) {
    parts.push(
      details.assigneeAgentId || details.assigneeUserId
        ? (isZh ? "分配了任务负责人" : "assigned the issue")
        : isZh ? "取消了任务负责人" : "unassigned the issue",
    );
  }
  if (details.title !== undefined) parts.push(isZh ? "更新了标题" : "updated the title");
  if (details.description !== undefined) parts.push(isZh ? "更新了描述" : "updated the description");

  return parts.length > 0 ? parts.join(isZh ? "，" : ", ") : null;
}

function formatStructuredIssueChange(input: {
  action: string;
  details: ActivityDetails;
  options: ActivityFormatOptions;
  forIssueDetail: boolean;
}): string | null {
  const details = input.details;
  if (!details) return null;
  const isZh = isZhLocale();

  if (input.action === "issue.blockers_updated") {
    const added = readIssueReferences(details, "addedBlockedByIssues").map(formatIssueReferenceLabel);
    const removed = readIssueReferences(details, "removedBlockedByIssues").map(formatIssueReferenceLabel);
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(isZh ? "阻塞项" : "blocker", isZh ? "阻塞项" : "blockers", added);
      return isZh ? `添加了${changed}` : input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(isZh ? "阻塞项" : "blocker", isZh ? "阻塞项" : "blockers", removed);
      return isZh ? `移除了${changed}` : input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return isZh ? "更新了阻塞项" : input.forIssueDetail ? "updated blockers" : "updated blockers on";
  }

  if (input.action === "issue.reviewers_updated" || input.action === "issue.approvers_updated") {
    const added = readParticipants(details, "addedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const removed = readParticipants(details, "removedParticipants").map((participant) => formatParticipantLabel(participant, input.options));
    const singular = input.action === "issue.reviewers_updated"
      ? (isZh ? "评审人" : "reviewer")
      : isZh ? "审批人" : "approver";
    const plural = input.action === "issue.reviewers_updated"
      ? (isZh ? "评审人" : "reviewers")
      : isZh ? "审批人" : "approvers";
    if (added.length > 0 && removed.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, added);
      return isZh ? `添加了${changed}` : input.forIssueDetail ? `added ${changed}` : `added ${changed} to`;
    }
    if (removed.length > 0 && added.length === 0) {
      const changed = formatChangedEntityLabel(singular, plural, removed);
      return isZh ? `移除了${changed}` : input.forIssueDetail ? `removed ${changed}` : `removed ${changed} from`;
    }
    return isZh ? `更新了${plural}` : input.forIssueDetail ? `updated ${plural}` : `updated ${plural} on`;
  }

  return null;
}

function activityRowVerbLabel(action: string): string {
  return (isZhLocale() ? ACTIVITY_ROW_VERBS_ZH : ACTIVITY_ROW_VERBS_EN)[action] ?? action.replace(/[._]/g, " ");
}

function issueActivityLabel(action: string): string {
  return (isZhLocale() ? ISSUE_ACTIVITY_LABELS_ZH : ISSUE_ACTIVITY_LABELS_EN)[action] ?? action.replace(/[._]/g, " ");
}

function resolvePageLocale(locale: ActivityPageLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getActivityPageCopy(locale: ActivityPageLocale) {
  return ACTIVITY_PAGE_COPY[resolvePageLocale(locale)];
}

export function activityTypeLabel(type: string, locale: ActivityPageLocale) {
  if (locale === "zh-CN") {
    return ACTIVITY_TYPE_LABELS_ZH[type] ?? type;
  }
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function formatActivityVerb(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  if (action === "issue.updated") {
    const issueUpdatedVerb = formatIssueUpdatedVerb(details);
    if (issueUpdatedVerb) return issueUpdatedVerb;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: false,
  });
  if (structuredChange) return structuredChange;

  return activityRowVerbLabel(action);
}

export function formatIssueActivityAction(
  action: string,
  details?: Record<string, unknown> | null,
  options: ActivityFormatOptions = {},
): string {
  const isZh = isZhLocale();
  if (action === "issue.updated") {
    const issueUpdatedAction = formatIssueUpdatedAction(details);
    if (issueUpdatedAction) return issueUpdatedAction;
  }

  const structuredChange = formatStructuredIssueChange({
    action,
    details,
    options,
    forIssueDetail: true,
  });
  if (structuredChange) return structuredChange;

  if (
    (action === "issue.document_created" || action === "issue.document_updated" || action === "issue.document_deleted")
    && details
  ) {
    const key = typeof details.key === "string" ? details.key : isZh ? "文档" : "document";
    const title = typeof details.title === "string" && details.title
      ? isZh ? `（${details.title}）` : ` (${details.title})`
      : "";
    return `${issueActivityLabel(action)} ${key}${title}`;
  }

  return issueActivityLabel(action);
}
