type InboxCopyLocale = string | null | undefined;

const inboxCopy = {
  en: {
    inbox: "Inbox",
    group: "Grouping",
    groupByNone: "None",
    groupByType: "Type",
    archive: "Archive",
    selectCompany: "Select a company to view inbox.",
    markAsRead: "Mark as read",
    dismissFromInbox: "Dismiss from inbox",
    failedRun: "Failed run",
    retrying: "Retrying…",
    retry: "Retry",
    dismiss: "Dismiss",
    approve: "Approve",
    reject: "Reject",
    humanJoinRequest: "Human join request",
    agentJoinRequest: "Agent join request",
    mine: "Mine",
    recent: "Recent",
    unread: "Unread",
    all: "All",
    searchInbox: "Search inbox…",
    disableNesting: "Disable parent-child nesting",
    enableNesting: "Enable parent-child nesting",
    chooseInboxColumns: "Choose which inbox columns stay visible",
    marking: "Marking…",
    markAllAsRead: "Mark all as read",
    markAllAsReadTitle: "Mark all as read?",
    cancel: "Cancel",
    category: "Category",
    allCategories: "All categories",
    myRecentIssues: "My recent issues",
    joinRequests: "Join requests",
    approvals: "Approvals",
    failedRuns: "Failed runs",
    alerts: "Alerts",
    approvalStatus: "Approval status",
    allApprovalStatuses: "All approval statuses",
    needsAction: "Needs action",
    resolved: "Resolved",
    noSearchMatches: "No inbox items match your search.",
    inboxZero: "Inbox zero.",
    noNewItems: "No new inbox items.",
    noRecentItems: "No recent inbox items.",
    noItemsForFilters: "No inbox items match these filters.",
    earlier: "Earlier",
    failedApprove: "Failed to approve",
    failedReject: "Failed to reject",
    failedApproveJoinRequest: "Failed to approve join request",
    failedRejectJoinRequest: "Failed to reject join request",
    retrySkipped: "Retry was skipped.",
    failedArchiveIssue: "Failed to archive issue",
  },
  "zh-CN": {
    inbox: "收件箱",
    group: "分组",
    groupByNone: "无",
    groupByType: "类型",
    archive: "归档",
    selectCompany: "请选择一个公司以查看收件箱。",
    markAsRead: "标记为已读",
    dismissFromInbox: "从收件箱移除",
    failedRun: "失败运行",
    retrying: "重试中…",
    retry: "重试",
    dismiss: "移除",
    approve: "批准",
    reject: "拒绝",
    humanJoinRequest: "人工加入申请",
    agentJoinRequest: "Agent 加入申请",
    mine: "我的",
    recent: "最近",
    unread: "未读",
    all: "全部",
    searchInbox: "搜索收件箱…",
    disableNesting: "关闭父子任务嵌套",
    enableNesting: "开启父子任务嵌套",
    chooseInboxColumns: "选择要显示的收件箱列",
    marking: "标记中…",
    markAllAsRead: "全部标为已读",
    markAllAsReadTitle: "全部标为已读？",
    cancel: "取消",
    category: "分类",
    allCategories: "全部分类",
    myRecentIssues: "我最近处理的任务",
    joinRequests: "加入申请",
    approvals: "审批",
    failedRuns: "失败运行",
    alerts: "提醒",
    approvalStatus: "审批状态",
    allApprovalStatuses: "全部审批状态",
    needsAction: "待处理",
    resolved: "已处理",
    noSearchMatches: "没有收件箱项目匹配你的搜索。",
    inboxZero: "收件箱已清空。",
    noNewItems: "没有新的收件箱项目。",
    noRecentItems: "没有最近的收件箱项目。",
    noItemsForFilters: "没有收件箱项目符合这些筛选条件。",
    earlier: "更早",
    failedApprove: "批准失败",
    failedReject: "拒绝失败",
    failedApproveJoinRequest: "批准加入申请失败",
    failedRejectJoinRequest: "拒绝加入申请失败",
    retrySkipped: "已跳过重试。",
    failedArchiveIssue: "归档任务失败",
  },
} as const;

function resolveLocale(locale: InboxCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getInboxCopy(locale: InboxCopyLocale) {
  return inboxCopy[resolveLocale(locale)];
}

export function formatFailedRunTitle(agentName: string | null, locale: InboxCopyLocale): string {
  const copy = getInboxCopy(locale);
  return `${copy.failedRun}${agentName ? ` — ${agentName}` : ""}`;
}

export function formatRetryButton(isRetrying: boolean, locale: InboxCopyLocale): string {
  const copy = getInboxCopy(locale);
  return isRetrying ? copy.retrying : copy.retry;
}

export function formatApprovalRequesterLabel(name: string, locale: InboxCopyLocale): string {
  return locale === "zh-CN" ? `申请人 ${name}` : `requested by ${name}`;
}

export function formatUpdatedAtLabel(time: string, locale: InboxCopyLocale): string {
  return locale === "zh-CN" ? `更新于 ${time}` : `updated ${time}`;
}

export function formatJoinRequestTitle(requestType: "human" | "agent", agentName: string | null | undefined, locale: InboxCopyLocale): string {
  const copy = getInboxCopy(locale);
  if (requestType === "human") return copy.humanJoinRequest;
  return `${copy.agentJoinRequest}${agentName ? `: ${agentName}` : ""}`;
}

export function formatJoinRequestMeta(time: string, requestIp: string, locale: InboxCopyLocale): string {
  return locale === "zh-CN" ? `${time} 发起，来源 IP ${requestIp}` : `requested ${time} from IP ${requestIp}`;
}

export function formatAdapterLabel(adapterType: string, locale: InboxCopyLocale): string {
  return locale === "zh-CN" ? `适配器：${adapterType}` : `adapter: ${adapterType}`;
}

export function approvalStatusLabel(status: string, locale: InboxCopyLocale): string {
  if (locale === "zh-CN") {
    return (
      {
        pending_approval: "待审批",
        approved: "已批准",
        rejected: "已拒绝",
        cancelled: "已取消",
      }[status] ?? status.replaceAll("_", " ")
    );
  }
  return status.replaceAll("_", " ");
}

export function formatMarkAllReadDescription(count: number, locale: InboxCopyLocale): string {
  if (locale === "zh-CN") {
    return `这会把 ${count} 个未读项目标记为已读。`;
  }
  return `This will mark ${count} unread ${count === 1 ? "item" : "items"} as read.`;
}

export function inboxEmptyMessage(
  tab: "mine" | "recent" | "unread" | "all",
  hasSearch: boolean,
  locale: InboxCopyLocale,
): string {
  const copy = getInboxCopy(locale);
  if (hasSearch) return copy.noSearchMatches;
  if (tab === "mine") return copy.inboxZero;
  if (tab === "unread") return copy.noNewItems;
  if (tab === "recent") return copy.noRecentItems;
  return copy.noItemsForFilters;
}

export function formatBudgetAlert(utilizationPercent: number, locale: InboxCopyLocale): string {
  if (locale === "zh-CN") {
    return `本月预算使用率已达 ${utilizationPercent}%`;
  }
  return `Budget at ${utilizationPercent}% utilization this month`;
}

export function formatAgentErrorSummaryTail(errorCount: number, locale: InboxCopyLocale): string {
  if (locale === "zh-CN") {
    return "个智能体出现错误";
  }
  return errorCount === 1 ? "agent has errors" : "agents have errors";
}
