import { issueStatusLegendLabel, priorityLegendLabel } from "./dashboard-copy";

type IssueComposerCopyLocale = string | null | undefined;

const issueComposerCopy = {
  en: {
    noCompanySelected: "No company selected",
    failedToCreateIssue: "Failed to create issue. Try again.",
    header: {
      newIssue: "New issue",
      newSubIssue: "New sub-issue",
      titlePlaceholder: "Issue title",
    },
    context: {
      assigneeLabel: "For",
      assigneePlaceholder: "Assignee",
      noAssignee: "No assignee",
      searchAssignees: "Search assignees...",
      noAssigneesFound: "No assignees found.",
      projectLabel: "in",
      projectPlaceholder: "Project",
      noProject: "No project",
      searchProjects: "Search projects...",
      noProjectsFound: "No projects found.",
      addReviewerOrApprover: "Add reviewer or approver",
      reviewer: "Reviewer",
      noReviewer: "No reviewer",
      searchReviewers: "Search reviewers...",
      noReviewersFound: "No reviewers found.",
      approver: "Approver",
      noApprover: "No approver",
      searchApprovers: "Search approvers...",
      noApproversFound: "No approvers found.",
      subIssueOf: "Sub-issue of",
    },
    executionWorkspace: {
      title: "Execution workspace",
      description: "Control whether this issue runs in the shared workspace, a new isolated workspace, or an existing one.",
      projectDefault: "Project default",
      newIsolatedWorkspace: "New isolated workspace",
      reuseExistingWorkspace: "Reuse existing workspace",
      chooseExistingWorkspace: "Choose an existing workspace",
      existingWorkspaceFallback: "existing execution workspace",
      reuseSummary: (workspaceName: string, source: string) => `Reusing ${workspaceName} from ${source}.`,
      parentWorkspaceWarning: (workspaceName?: string | null) =>
        `Warning: this sub-issue will no longer use the parent issue workspace${workspaceName ? ` (${workspaceName})` : ""}.`,
    },
    assigneeOptions: {
      claude: "Claude options",
      codex: "Codex options",
      openCode: "OpenCode options",
      agent: "Agent options",
      model: "Model",
      defaultModel: "Default model",
      searchModels: "Search models...",
      noModelsFound: "No models found.",
      thinkingEffort: "Thinking effort",
      enableChrome: "Enable Chrome (--chrome)",
    },
    descriptionPlaceholder: "Add description...",
    attachments: {
      documents: "Documents",
      attachments: "Attachments",
      removeDocument: "Remove document",
      removeAttachment: "Remove attachment",
    },
    toolbar: {
      priority: "Priority",
      upload: "Upload",
      startDate: "Start date",
      dueDate: "Due date",
      discardDraft: "Discard Draft",
    },
    footer: {
      creatingIssue: "Creating issue...",
      creating: "Creating...",
      createIssue: "Create Issue",
      createSubIssue: "Create Sub-Issue",
    },
    optionValues: {
      default: "Default",
      minimal: "Minimal",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "X-High",
      max: "Max",
    },
  },
  "zh-CN": {
    noCompanySelected: "尚未选择公司",
    failedToCreateIssue: "创建任务失败，请重试。",
    header: {
      newIssue: "新建任务",
      newSubIssue: "新建子任务",
      titlePlaceholder: "任务标题",
    },
    context: {
      assigneeLabel: "分配给",
      assigneePlaceholder: "负责人",
      noAssignee: "未分配负责人",
      searchAssignees: "搜索负责人…",
      noAssigneesFound: "没有找到负责人。",
      projectLabel: "所属项目",
      projectPlaceholder: "项目",
      noProject: "无项目",
      searchProjects: "搜索项目…",
      noProjectsFound: "没有找到项目。",
      addReviewerOrApprover: "添加审核人或审批人",
      reviewer: "审核人",
      noReviewer: "无审核人",
      searchReviewers: "搜索审核人…",
      noReviewersFound: "没有找到审核人。",
      approver: "审批人",
      noApprover: "无审批人",
      searchApprovers: "搜索审批人…",
      noApproversFound: "没有找到审批人。",
      subIssueOf: "子任务属于",
    },
    executionWorkspace: {
      title: "执行工作区",
      description: "控制该任务是在共享工作区、新建独立工作区，还是已有工作区中运行。",
      projectDefault: "项目默认",
      newIsolatedWorkspace: "新建独立工作区",
      reuseExistingWorkspace: "复用已有工作区",
      chooseExistingWorkspace: "选择已有工作区",
      existingWorkspaceFallback: "已有执行工作区",
      reuseSummary: (workspaceName: string, source: string) => `复用 ${workspaceName}，来源：${source}。`,
      parentWorkspaceWarning: (workspaceName?: string | null) =>
        `注意：该子任务将不再使用父任务工作区${workspaceName ? `（${workspaceName}）` : ""}。`,
    },
    assigneeOptions: {
      claude: "Claude 选项",
      codex: "Codex 选项",
      openCode: "OpenCode 选项",
      agent: "Agent 选项",
      model: "模型",
      defaultModel: "默认模型",
      searchModels: "搜索模型…",
      noModelsFound: "没有找到模型。",
      thinkingEffort: "思考强度",
      enableChrome: "启用 Chrome（--chrome）",
    },
    descriptionPlaceholder: "添加描述…",
    attachments: {
      documents: "文档",
      attachments: "附件",
      removeDocument: "移除文档",
      removeAttachment: "移除附件",
    },
    toolbar: {
      priority: "优先级",
      upload: "上传",
      startDate: "开始日期",
      dueDate: "截止日期",
      discardDraft: "丢弃草稿",
    },
    footer: {
      creatingIssue: "正在创建任务…",
      creating: "创建中…",
      createIssue: "创建任务",
      createSubIssue: "创建子任务",
    },
    optionValues: {
      default: "默认",
      minimal: "最少",
      low: "低",
      medium: "中",
      high: "高",
      xhigh: "极高",
      max: "最大",
    },
  },
} as const;

function resolveLocale(locale: IssueComposerCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getIssueComposerCopy(locale: IssueComposerCopyLocale) {
  return issueComposerCopy[resolveLocale(locale)];
}

export function formatIssueComposerOptionsTitle(
  adapterType: string | null | undefined,
  locale: IssueComposerCopyLocale,
) {
  const copy = getIssueComposerCopy(locale);
  if (adapterType === "claude_local") return copy.assigneeOptions.claude;
  if (adapterType === "codex_local") return copy.assigneeOptions.codex;
  if (adapterType === "opencode_local") return copy.assigneeOptions.openCode;
  return copy.assigneeOptions.agent;
}

export function issueComposerThinkingEffortOptions(
  adapterType: "claude_local" | "codex_local" | "opencode_local",
  locale: IssueComposerCopyLocale,
) {
  const labels = getIssueComposerCopy(locale).optionValues;
  const byAdapter = {
    claude_local: [
      { value: "", label: labels.default },
      { value: "low", label: labels.low },
      { value: "medium", label: labels.medium },
      { value: "high", label: labels.high },
    ],
    codex_local: [
      { value: "", label: labels.default },
      { value: "minimal", label: labels.minimal },
      { value: "low", label: labels.low },
      { value: "medium", label: labels.medium },
      { value: "high", label: labels.high },
      { value: "xhigh", label: labels.xhigh },
    ],
    opencode_local: [
      { value: "", label: labels.default },
      { value: "minimal", label: labels.minimal },
      { value: "low", label: labels.low },
      { value: "medium", label: labels.medium },
      { value: "high", label: labels.high },
      { value: "xhigh", label: labels.xhigh },
      { value: "max", label: labels.max },
    ],
  } as const;
  return byAdapter[adapterType];
}

export function issueComposerStatusOptions(locale: IssueComposerCopyLocale) {
  return [
    { value: "backlog", label: issueStatusLegendLabel("backlog", locale) },
    { value: "todo", label: issueStatusLegendLabel("todo", locale) },
    { value: "in_progress", label: issueStatusLegendLabel("in_progress", locale) },
    { value: "in_review", label: issueStatusLegendLabel("in_review", locale) },
    { value: "done", label: issueStatusLegendLabel("done", locale) },
  ] as const;
}

export function issueComposerPriorityOptions(locale: IssueComposerCopyLocale) {
  return [
    { value: "critical", label: priorityLegendLabel("critical", locale) },
    { value: "high", label: priorityLegendLabel("high", locale) },
    { value: "medium", label: priorityLegendLabel("medium", locale) },
    { value: "low", label: priorityLegendLabel("low", locale) },
  ] as const;
}

export function issueComposerExecutionWorkspaceModes(locale: IssueComposerCopyLocale) {
  const copy = getIssueComposerCopy(locale);
  return [
    { value: "shared_workspace", label: copy.executionWorkspace.projectDefault },
    { value: "isolated_workspace", label: copy.executionWorkspace.newIsolatedWorkspace },
    { value: "reuse_existing", label: copy.executionWorkspace.reuseExistingWorkspace },
  ] as const;
}

export function formatIssueComposerUploadWarningTitle(issueRef: string, locale: IssueComposerCopyLocale) {
  if (locale === "zh-CN") {
    return `${issueRef} 已创建，但上传存在警告`;
  }
  return `Created ${issueRef} with upload warnings`;
}

export function formatIssueComposerUploadWarningBody(count: number, locale: IssueComposerCopyLocale) {
  if (locale === "zh-CN") {
    return `${count} 个暂存文件未能添加。`;
  }
  return `${count} staged ${count === 1 ? "file" : "files"} could not be added.`;
}

export function formatIssueComposerOpenIssueLabel(issueRef: string, locale: IssueComposerCopyLocale) {
  if (locale === "zh-CN") {
    return `打开 ${issueRef}`;
  }
  return `Open ${issueRef}`;
}
