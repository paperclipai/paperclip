import { issueStatusLegendLabel, priorityLegendLabel } from "./dashboard-copy";
import type { InboxIssueColumn } from "./inbox";

type IssuesCopyLocale = string | null | undefined;

const issuesCopy = {
  en: {
    issues: "Issues",
    selectCompany: "Select a company to view issues.",
    searchIssuesPlaceholder: "Search issues...",
    searchIssuesAria: "Search issues",
    columns: "Table columns",
    desktopIssueRows: "Desktop issue rows",
    resetDefaults: "Reset defaults",
    noWorkspace: "No Workspace",
    noParent: "No Parent",
    unassigned: "Unassigned",
    user: "User",
    newIssue: "New Issue",
    listView: "List view",
    boardView: "Board view",
    chooseIssueColumns: "Choose which issue columns stay visible",
    filter: "Filter",
    filters: "Filters",
    clear: "Clear",
    quickFilters: "Quick filters",
    visibility: "Visibility",
    showRoutineRuns: "Show routine runs",
    status: "Status",
    id: "ID",
    priority: "Priority",
    assignee: "Assignee",
    labels: "Labels",
    project: "Project",
    sort: "Sort",
    group: "Grouping",
    title: "Title",
    created: "Created",
    updated: "Updated",
    workspace: "Workspace",
    parentIssue: "Parent Issue",
    none: "None",
    noIssuesMatch: "No issues match the current filters or search.",
    createIssue: "Create Issue",
    noAssignee: "No assignee",
    me: "Me",
    searchAssignees: "Search assignees...",
    properties: "Properties",
    copy: "Copy",
    copied: "Copied!",
    noLabels: "No labels",
    searchLabels: "Search labels...",
    newLabel: "New label",
    creating: "Creating…",
    createLabel: "Create label",
    unassignedIssue: "Unassigned",
    assignToMe: "Assign to me",
    assignToRequester: "Assign to requester",
    requester: "Requester",
    noProject: "No project",
    searchProjects: "Search projects...",
    noBlockers: "No blockers",
    searchIssueBlockers: "Search issues...",
    blockedBy: "Blocked by",
    blocking: "Blocking",
    subIssues: "Sub-issues",
    addSubIssue: "Add sub-issue",
    reviewers: "Reviewers",
    approvers: "Approvers",
    execution: "Execution",
    parent: "Parent",
    depth: "Depth",
    branch: "Branch",
    folder: "Folder",
    createdBy: "Created by",
    userFallback: "User",
    started: "Started",
    completed: "Completed",
    review: "Review",
    approval: "Approval",
    runReviewNow: "Run review now",
    runApprovalNow: "Run approval now",
    live: "Live",
  },
  "zh-CN": {
    issues: "任务",
    selectCompany: "请选择一个公司以查看任务。",
    searchIssuesPlaceholder: "搜索任务…",
    searchIssuesAria: "搜索任务",
    columns: "列",
    desktopIssueRows: "桌面任务行",
    resetDefaults: "恢复默认",
    noWorkspace: "无工作区",
    noParent: "无父任务",
    unassigned: "未分配",
    user: "用户",
    newIssue: "新建任务",
    listView: "列表视图",
    boardView: "看板视图",
    chooseIssueColumns: "选择要显示的任务列",
    filter: "筛选",
    filters: "筛选器",
    clear: "清空",
    quickFilters: "快捷筛选",
    visibility: "显示",
    showRoutineRuns: "显示例行任务运行",
    status: "状态",
    id: "ID",
    priority: "优先级",
    assignee: "负责人",
    labels: "标签",
    project: "项目",
    sort: "排序",
    group: "分组",
    title: "标题",
    created: "创建时间",
    updated: "更新时间",
    workspace: "工作区",
    parentIssue: "父任务",
    none: "无",
    noIssuesMatch: "没有符合当前筛选或搜索条件的任务。",
    createIssue: "创建任务",
    noAssignee: "未分配",
    me: "我",
    searchAssignees: "搜索负责人…",
    properties: "属性",
    copy: "复制",
    copied: "已复制",
    noLabels: "无标签",
    searchLabels: "搜索标签...",
    newLabel: "新标签",
    creating: "创建中…",
    createLabel: "创建标签",
    unassignedIssue: "未分配",
    assignToMe: "分配给我",
    assignToRequester: "分配给请求人",
    requester: "请求人",
    noProject: "无项目",
    searchProjects: "搜索项目...",
    noBlockers: "无阻塞项",
    searchIssueBlockers: "搜索任务...",
    blockedBy: "被阻塞于",
    blocking: "阻塞中",
    subIssues: "子任务",
    addSubIssue: "添加子任务",
    reviewers: "审核人",
    approvers: "审批人",
    execution: "执行",
    parent: "父任务",
    depth: "层级",
    branch: "分支",
    folder: "目录",
    createdBy: "创建者",
    userFallback: "用户",
    started: "开始时间",
    completed: "完成时间",
    review: "审核",
    approval: "审批",
    runReviewNow: "立即执行审核",
    runApprovalNow: "立即执行审批",
    live: "进行中",
  },
} as const;

function resolveLocale(locale: IssuesCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getIssuesCopy(locale: IssuesCopyLocale) {
  return issuesCopy[resolveLocale(locale)];
}

export function issueQuickFilterLabel(
  key: "all" | "active" | "backlog" | "done",
  locale: IssuesCopyLocale,
): string {
  if (locale === "zh-CN") {
    return (
      {
        all: "全部",
        active: "进行中",
        backlog: "待规划",
        done: "已完成",
      }[key] ?? key
    );
  }
  return (
    {
      all: "All",
      active: "Active",
      backlog: "Backlog",
      done: "Done",
    }[key] ?? key
  );
}

export function issueSortFieldLabel(
  field: "status" | "priority" | "title" | "created" | "updated",
  locale: IssuesCopyLocale,
): string {
  return (
    {
      status: getIssuesCopy(locale).status,
      priority: getIssuesCopy(locale).priority,
      title: getIssuesCopy(locale).title,
      created: getIssuesCopy(locale).created,
      updated: getIssuesCopy(locale).updated,
    }[field]
  );
}

export function issueGroupFieldLabel(
  field: "status" | "priority" | "assignee" | "workspace" | "parent" | "none",
  locale: IssuesCopyLocale,
): string {
  const copy = getIssuesCopy(locale);
  return (
    {
      status: copy.status,
      priority: copy.priority,
      assignee: copy.assignee,
      workspace: copy.workspace,
      parent: copy.parentIssue,
      none: copy.none,
    }[field]
  );
}

export function issueColumnLabel(column: InboxIssueColumn, locale: IssuesCopyLocale): string {
  const copy = getIssuesCopy(locale);
  return {
    status: copy.status,
    id: copy.id,
    assignee: copy.assignee,
    project: copy.project,
    workspace: copy.workspace,
    parent: copy.parentIssue,
    labels: copy.labels,
    updated: copy.updated,
  }[column];
}

export function issueColumnsTriggerLabel(locale: IssuesCopyLocale): string {
  return getIssuesCopy(locale).columns;
}

export function issueColumnsSectionLabel(locale: IssuesCopyLocale): string {
  return getIssuesCopy(locale).desktopIssueRows;
}

export function issueColumnsResetLabel(locale: IssuesCopyLocale): string {
  return getIssuesCopy(locale).resetDefaults;
}

export function issueColumnsResetSummary(locale: IssuesCopyLocale): string {
  const copy = getIssuesCopy(locale);
  return locale === "zh-CN" ? `${copy.status}、${copy.id}、${copy.updated}` : `${copy.status}, ${copy.id}, ${copy.updated}`;
}

export function issueLiveLabel(locale: IssuesCopyLocale): string {
  return getIssuesCopy(locale).live;
}

export function issueColumnDescription(column: InboxIssueColumn, locale: IssuesCopyLocale): string {
  if (locale === "zh-CN") {
    return {
      status: "左侧状态标记。",
      id: "像 PAP-1009 这样的任务编号。",
      assignee: "负责该任务的智能体或董事会成员。",
      project: "关联项目及其颜色标识。",
      workspace: "执行该任务的工作区或项目工作区。",
      parent: "父任务编号和标题。",
      labels: "任务标签。",
      updated: "最近一次可见活动时间。",
    }[column];
  }

  return {
    status: "Issue state chip on the left edge.",
    id: "Ticket identifier like PAP-1009.",
    assignee: "Assigned agent or board user.",
    project: "Linked project pill with its color.",
    workspace: "Execution or project workspace used for the issue.",
    parent: "Parent issue identifier and title.",
    labels: "Issue labels and tags.",
    updated: "Latest visible activity time.",
  }[column];
}

export function issueActivitySummaryLabel(time: string, locale: IssuesCopyLocale): string {
  return locale === "zh-CN" ? `更新于 ${time}` : `Updated ${time}`;
}

export function issueStatusLabel(status: string, locale: IssuesCopyLocale): string {
  return issueStatusLegendLabel(status, locale);
}

export function issuePriorityLabel(priority: string, locale: IssuesCopyLocale): string {
  return priorityLegendLabel(priority, locale);
}

export function formatIssueFilterCount(count: number, locale: IssuesCopyLocale): string {
  return locale === "zh-CN" ? `筛选：${count}` : `Filters: ${count}`;
}

export function formatIssueSubtaskCount(count: number, locale: IssuesCopyLocale): string {
  if (locale === "zh-CN") {
    return `（${count} 个子任务）`;
  }
  return `(${count} sub-task${count === 1 ? "" : "s"})`;
}

export function copiedActionLabel(copied: boolean, locale: IssuesCopyLocale): string {
  const copy = getIssuesCopy(locale);
  return copied ? copy.copied : copy.copy;
}

export function issueExecutionStageLabel(stage: "review" | "approval", locale: IssuesCopyLocale): string {
  const copy = getIssuesCopy(locale);
  return stage === "review" ? copy.review : copy.approval;
}

export function issueExecutionRunNowLabel(stage: "review" | "approval", locale: IssuesCopyLocale): string {
  const copy = getIssuesCopy(locale);
  return stage === "review" ? copy.runReviewNow : copy.runApprovalNow;
}

export function issueParticipantSearchPlaceholder(stage: "review" | "approval", locale: IssuesCopyLocale): string {
  if (locale === "zh-CN") {
    return `搜索${stage === "review" ? "审核人" : "审批人"}...`;
  }
  return `Search ${stage === "review" ? "reviewers" : "approvers"}...`;
}

export function issueParticipantNoneLabel(stage: "review" | "approval", locale: IssuesCopyLocale): string {
  if (locale === "zh-CN") {
    return `无${stage === "review" ? "审核人" : "审批人"}`;
  }
  return `No ${stage === "review" ? "reviewers" : "approvers"}`;
}

export function issueDeleteLabelTitle(name: string, locale: IssuesCopyLocale): string {
  return locale === "zh-CN" ? `删除 ${name}` : `Delete ${name}`;
}

export function issueAssignToRequesterLabel(requesterLabel: string | null | undefined, locale: IssuesCopyLocale): string {
  if (requesterLabel) {
    return locale === "zh-CN" ? `分配给 ${requesterLabel}` : `Assign to ${requesterLabel}`;
  }
  return locale === "zh-CN" ? "分配给请求人" : "Assign to requester";
}

export function formatIssueExecutionStateLabel(args: {
  stage: "review" | "approval";
  status: "changes_requested" | "pending";
  participantLabel?: string | null;
  locale: IssuesCopyLocale;
}) {
  const stageLabel = issueExecutionStageLabel(args.stage, args.locale);
  if (args.locale === "zh-CN") {
    return args.status === "changes_requested"
      ? `${stageLabel}要求修改${args.participantLabel ? `，执行者：${args.participantLabel}` : ""}`
      : `${stageLabel}待处理${args.participantLabel ? `，执行者：${args.participantLabel}` : ""}`;
  }
  return args.status === "changes_requested"
    ? `${stageLabel} requested changes${args.participantLabel ? ` by ${args.participantLabel}` : ""}`
    : `${stageLabel} pending${args.participantLabel ? ` with ${args.participantLabel}` : ""}`;
}
