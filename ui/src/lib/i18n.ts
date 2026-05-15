/**
 * Lightweight UI strings for Paperclip board UI (MVP).
 * Default locale: zh-CN. No runtime locale switching yet.
 */

import type { IssueBlockerAttention } from "@paperclipai/shared";

export const UI_LOCALE = "zh-CN" as const;

/** Issue workflow statuses (display only — API values stay English). */
const ISSUE_STATUS: Record<string, string> = {
  backlog: "待整理",
  todo: "待办",
  in_progress: "进行中",
  in_review: "审查中",
  done: "已完成",
  blocked: "阻塞",
  cancelled: "已取消",
  pending_approval: "待审批",
  failed: "失败",
  timed_out: "超时",
};

/** Agent lifecycle statuses */
const AGENT_STATUS: Record<string, string> = {
  active: "活跃",
  running: "运行中",
  idle: "空闲",
  paused: "已暂停",
  error: "错误",
  pending_approval: "待审批",
  terminated: "已终止",
  archived: "已归档",
};

/** Heartbeat / run record statuses */
const RUN_STATUS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  succeeded: "成功",
  failed: "失败",
  timed_out: "超时",
  scheduled_retry: "已安排重试",
  cancelled: "已取消",
  completed: "已完成",
  // misc
  pending: "等待中",
  ok: "正常",
  warning: "警告",
  info: "信息",
};

/** Goal / project-style statuses that appear in StatusBadge */
const OTHER_ENTITY_STATUS: Record<string, string> = {
  planned: "已计划",
  achieved: "已达成",
  completed: "已完成",
  approved: "已批准",
  rejected: "已拒绝",
  revision_requested: "需修改",
};

function titleCaseUnderscores(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Issue + shared kanban / filters */
export function formatIssueStatus(status: string): string {
  return ISSUE_STATUS[status] ?? titleCaseUnderscores(status);
}

/** StatusBadge: issues, agents, runs, goals, approvals */
export function formatBadgeStatus(status: string): string {
  return (
    ISSUE_STATUS[status]
    ?? AGENT_STATUS[status]
    ?? RUN_STATUS[status]
    ?? OTHER_ENTITY_STATUS[status]
    ?? titleCaseUnderscores(status)
  );
}

/** Kanban / icon dropdown: same as issue statuses for known keys */
export function formatIssueStatusShort(status: string): string {
  return formatIssueStatus(status);
}

export const issueStatusLabelsBoard: Record<string, string> = {
  backlog: ISSUE_STATUS.backlog!,
  todo: ISSUE_STATUS.todo!,
  in_progress: ISSUE_STATUS.in_progress!,
  in_review: ISSUE_STATUS.in_review!,
  done: ISSUE_STATUS.done!,
  blocked: ISSUE_STATUS.blocked!,
  cancelled: ISSUE_STATUS.cancelled!,
};

/** Activity chart legend (Issues by Status) */
export function chartIssueStatusLabel(status: string): string {
  return formatIssueStatus(status);
}

const PRIORITY_ZH: Record<string, string> = {
  critical: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

export function formatPriorityLabel(priority: string): string {
  return PRIORITY_ZH[priority] ?? titleCaseUnderscores(priority);
}

export function formatAgentStatus(status: string): string {
  return AGENT_STATUS[status] ?? titleCaseUnderscores(status);
}

export function formatRunStatus(status: string): string {
  return RUN_STATUS[status] ?? formatBadgeStatus(status);
}

const AGENT_ROLE_ZH: Record<string, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  security: "安全",
  engineer: "工程师",
  designer: "设计",
  pm: "产品经理",
  qa: "测试",
  devops: "运维",
  researcher: "研究",
  general: "通用",
};

export function formatAgentRole(role: string): string {
  return AGENT_ROLE_ZH[role] ?? titleCaseUnderscores(role);
}

/** UI helper — adapter id 仍显示为原始字符串 */
export function formatAdapterTypeLabel(adapterType: string): string {
  return adapterType;
}

// ——— Run ledger / liveness (heartbeat UI) ———

export type LivenessCopyZh = { label: string; description: string };

const LIVENESS_ZH: Record<string, LivenessCopyZh> = {
  completed: { label: "已完成", description: "事务已达到终态。" },
  advanced: { label: "已推进", description: "运行产出了明确进展证据。" },
  plan_only: { label: "仅计划", description: "运行描述了后续工作，但缺少可验证行动。" },
  empty_response: { label: "空响应", description: "运行结束但没有有效输出。" },
  blocked: { label: "阻塞", description: "运行或事务声明了阻塞。" },
  failed: { label: "失败", description: "运行未成功结束。" },
  needs_followup: { label: "需跟进", description: "有输出但未证明实质进展。" },
};

export const LIVENESS_PENDING_ZH: LivenessCopyZh = {
  label: "结束后检测",
  description: "活跃度在运行结束后评估。",
};

export const LIVENESS_RETRY_PENDING_ZH: LivenessCopyZh = {
  label: "重试排队中",
  description: "Paperclip 已排队自动重试，尚未开始。",
};

export const LIVENESS_MISSING_ZH: LivenessCopyZh = {
  label: "无活跃度数据",
  description: "此运行未持久化活跃度分类。",
};

export function getLivenessCopyZh(state: string | undefined): LivenessCopyZh | undefined {
  if (!state) return undefined;
  return LIVENESS_ZH[state];
}

const RUN_OUTPUT_SILENCE_ZH: Partial<Record<string, { label: string }>> = {
  suspicious: { label: "静默监控" },
  critical: { label: "运行停滞" },
  snoozed: { label: "已暂停告警" },
};

export function runOutputSilenceLabelZh(level: string | undefined): string | undefined {
  if (!level) return undefined;
  return RUN_OUTPUT_SILENCE_ZH[level]?.label;
}

// ——— Retry badges (runRetryState.ts) ———

export const RETRY_REASON_ZH: Record<string, string> = {
  transient_failure: "瞬时故障",
  missing_issue_comment: "缺少事务评论",
  process_lost: "进程丢失",
  assignment_recovery: "分配恢复",
  issue_continuation_needed: "需要接续",
  max_turns_continuation: "达到轮次接续",
};

export const RETRY_BADGE_ZH = {
  continuationScheduled: "已安排接续",
  retryScheduled: "已安排重试",
  continuationExhausted: "接续耗尽",
  retryExhausted: "重试耗尽",
  continuedRun: "接续运行",
  retriedRun: "重试运行",
  nextContinuation: "下次接续",
  nextRetry: "下次重试",
  nextPendingSchedule: "等待排期",
  automaticRetriesExhausted: "自动重试已用尽",
} as const;

export const runRetryUi = {
  attemptLabel: (n: number) => `第 ${n} 次尝试`,
  manualInterventionPhrase: "需要人工介入",
} as const;

/** Local dev: banner from GET /api/health devServer (trusted deployment only) */
export const devRestartBanner = {
  title: "需要重启开发服务",
  autoRestartOn: "自动重启已开启",
  reasonBackendChanges: "自本次进程启动以来，后端相关文件已有变更",
  reasonPendingMigrations: "存在尚未应用的数据库迁移，需重新启动后才会生效",
  reasonBackendAndMigrations: "后端相关文件已变更，且存在待应用的迁移",
  updatedAt: (when: string) => ` · 更新于 ${when}`,
  changedFiles: (listed: string, moreCount: number) =>
    moreCount > 0 ? `变更：${listed}（另有 ${moreCount} 项）` : `变更：${listed}`,
  pendingMigrations: (listed: string, moreCount: number) =>
    moreCount > 0 ? `待处理迁移：${listed}（另有 ${moreCount} 项）` : `待处理迁移：${listed}`,
  waitingForRuns: (n: number) =>
    n === 1 ? "等待 1 个进行中的运行结束…" : `等待 ${n} 个进行中的运行结束…`,
  autoRestartWhenIdle: "实例空闲后将自动重启",
  manualRestartBeforeCmd: "确认当前工作可安全打断后，请重启",
} as const;

// ——— Navigation & common pages ———

export const nav = {
  newIssue: "新建事务",
  search: "搜索",
  dashboard: "工作台",
  inbox: "收件箱",
  issues: "事务",
  routines: "例行任务",
  goals: "目标",
  workspaces: "工作区",
  work: "工作",
  org: "组织",
  skills: "技能",
  costs: "成本",
  activity: "活动",
  settings: "设置",
  company: "团队",
  agents: "智能体",
  sidebarAgents: "智能体",
  browseAgents: "浏览智能体",
  newAgent: "新建智能体",
  companies: "团队列表",
  newCompany: "新建团队",
  recentRuns: "最近运行",
} as const;

export const dashboard = {
  welcomeNoCompany: "欢迎使用 Paperclip。先创建团队与智能体即可开始。",
  getStarted: "开始",
  selectCompany: "创建或选择团队以查看工作台。",
  noAgentsBanner: "当前还没有智能体。",
  createAgentLink: "在此创建",
  budgetIncidents: (n: number) => `${n} 个预算事件`,
  budgetDetail: (pausedAgents: number, pausedProjects: number, pending: number) =>
    `${pausedAgents} 个智能体已暂停 · ${pausedProjects} 个项目已暂停 · ${pending} 笔待审批预算`,
  openBudgets: "查看预算",
  agentsEnabled: "可用智能体",
  runningPausedErrors: (running: number, paused: number, errors: number) =>
    `${running} 运行中，${paused} 已暂停，${errors} 错误`,
  tasksInProgress: "进行中事务",
  openBlocked: (open: number, blocked: number) => `${open} 未结，${blocked} 阻塞`,
  monthSpend: "本月支出",
  unlimitedBudget: "无预算上限",
  pctOfBudget: (pct: number | string, budget: string) => `${pct}% · 预算 ${budget}`,
  pendingApprovals: "待审批",
  budgetOverridesPending: (n: number) => `${n} 笔预算覆盖待董事会处理`,
  awaitingReview: "等待董事会处理",
  runActivity: "运行活动",
  last14Days: "最近 14 天",
  issuesByPriority: "按优先级",
  issuesByStatus: "按状态",
  successRate: "成功率",
  recentActivity: "最近活动",
  recentTasks: "最近事务",
  noTasksYet: "暂无事务。",
  noRunsYet: "尚无运行。",
  noIssuesYet: "暂无事务。",
  moreRuns: (n: number) => `还有 ${n} 个进行中或近期运行`,
} as const;

export const dashboardLive = {
  liveRunsBreadcrumb: "实时运行",
  createCompanyHint: "创建团队以查看实时运行。",
  selectCompanyHint: "选择团队以查看实时运行。",
  backDashboard: "工作台",
  title: "智能体实时运行",
  subtitle: "进行中的运行优先，其次为最近完成的运行。",
  showingUpTo: (n: number) => `最多显示 ${n} 条`,
  activeRecent: "进行中 / 最近",
  emptyRuns: "暂无活动或近期的智能体运行。",
} as const;

export const activeAgentsPanel = {
  defaultTitle: "智能体",
  defaultEmpty: "暂无最近的智能体运行。",
} as const;

export const companiesPage = {
  newCompany: "新建团队",
  title: "团队",
  loading: "正在加载团队…",
  agents: "智能体",
  agentCount: (n: number) => `${n} 个智能体`,
  issues: "事务",
  issueCount: (n: number) => `${n} 条事务`,
  budget: "预算",
  unlimitedBudget: "无预算上限",
  select: "当前",
  rename: "重命名",
  renameMenu: "重命名",
  delete: "删除",
  deleteCompany: "删除团队",
  cancel: "取消",
  save: "保存",
  confirmDelete: "确定删除此团队及全部数据？此操作不可撤销。",
  deleting: "删除中…",
  createdPrefix: "创建于",
} as const;

export const agentsPage = {
  all: "全部",
  active: "活跃",
  paused: "已暂停",
  error: "错误",
  filters: "筛选",
  showTerminated: "显示已终止",
  newAgent: "新建智能体",
  agentCount: (n: number) => `${n} 个智能体`,
  empty: "创建第一个智能体以开始。",
  emptySelectCompany: "选择团队以查看智能体。",
  noMatch: "没有符合筛选条件的智能体。",
  noOrg: "尚未定义组织层级。",
  list: "列表",
  tree: "组织",
  live: (n: number) => (n > 1 ? `进行中 (${n})` : "进行中"),
} as const;

export const agentDetail = {
  agentsCrumb: "智能体",
  runs: "运行",
  runPrefix: "运行",
  instructions: "指令",
  configuration: "配置",
  skills: "技能",
  budget: "预算",
  dashboard: "概览",
} as const;

export const issuesPage = {
  title: "事务",
  emptySelectCompany: "选择团队以查看事务。",
} as const;

export const issuesList = {
  searchPlaceholder: "搜索事务…",
  searchAria: "搜索事务",
  nextUp: "下一步",
  waitingBlockers: "等待阻塞项",
  board: "董事会",
  me: "我",
  noWorkspace: "无工作区",
  noProject: "无项目",
  noParent: "无父事务",
  unassigned: "未分配",
  user: "用户",
  createIssue: "创建事务",
  newIssue: "新建事务",
  listView: "列表视图",
  boardView: "看板视图",
  nestingToggle: "父子嵌套显示",
  columnsPicker: "选择显示的列",
  sort: "排序",
  group: "分组",
  colWorkflow: "工作流",
  colStatus: "状态",
  colPriority: "优先级",
  colTitle: "标题",
  colCreated: "创建时间",
  colUpdated: "更新时间",
  groupStatus: "状态",
  groupPriority: "优先级",
  groupAssignee: "经办人",
  groupProject: "项目",
  groupWorkspace: "工作区",
  groupParent: "父事务",
  groupNone: "不分组",
  noMatch: "没有符合当前筛选或搜索的事务。",
  paused: "已暂停",
  needsNext: "需要下一步",
  needsNextTitle: "此事务需要下一步操作",
  searchAssignees: "搜索经办人…",
  loadingMore: "加载更多事务…",
  scrollLoad: "滚动加载更多",
} as const;

export const onboarding = {
  addAgentTitle: (name: string) => `向 ${name} 添加智能体`,
  createAnotherCompany: "再创建一个团队",
  firstCompany: "创建你的第一个团队",
  addAgentDesc: "重新运行引导以为此团队添加智能体和入门任务。",
  anotherCompanyDesc: "重新运行引导以创建另一个团队并初始化首位智能体。",
  firstDesc: "从创建团队和你的第一位智能体开始。",
  addAgent: "添加智能体",
  startOnboarding: "开始引导",
  loading: "加载中…",
  firstCompanyTitle: "创建你的第一个团队",
  firstCompanyBody: "从创建一个团队开始。",
  newCompany: "新建团队",
} as const;

export const newIssue = {
  subIssue: "新建子事务",
  newIssue: "新建事务",
  titlePlaceholder: "事务标题",
  descriptionPlaceholder: "添加描述…",
  for: "For",
  assignee: "经办人",
  noAssignee: "无经办人",
  searchAssignees: "搜索经办人…",
  noAssignees: "未找到经办人。",
  discardDraft: "放弃草稿",
  creating: "正在创建…",
  creatingEllipsis: "创建中…",
  create: "创建事务",
  createSub: "创建子事务",
  failedCreateFallback: "创建事务失败，请重试。",
  statusBacklogDesc: "搁置 — 不会唤醒经办人",
  statusTodoDesc: "可执行 — 会唤醒经办人",
  workModeStandard: "标准",
  workModePlanning: "规划",
  execShared: "项目默认",
  execIsolated: "新建隔离工作区",
  execReuse: "复用已有工作区",
  execWorkspaceSection: "执行工作区",
  execWorkspacePolicyHint:
    "选择智能体执行任务时的工作区策略。API 与机器标识保持不变。",
  priorityChip: "优先级",
  upload: "上传",
  project: "项目",
  noProject: "无项目",
  searchProjects: "搜索项目…",
  noProjectsFound: "未找到项目。",
  reviewer: "审阅人",
  noReviewer: "无审阅人",
  searchReviewers: "搜索审阅人…",
  noReviewersFound: "未找到审阅人。",
  approver: "审批人",
  noApprover: "无审批人",
  searchApprovers: "搜索审批人…",
  noApproversFound: "未找到审批人。",
  addReviewerApprover: "添加审阅人或审批人",
  modelLane: "模型通道",
  model: "模型",
  defaultModel: "默认模型",
  searchModels: "搜索模型…",
  noModels: "未找到模型。",
  thinkingEffort: "思考强度",
  enableChrome: "启用 Chrome (--chrome)",
  documents: "文档",
  attachments: "附件",
  removeDocument: "移除文档",
  removeAttachment: "移除附件",
  startDate: "开始日期",
  dueDate: "截止日期",
  backlogAssignWarning:
    "分配经办人表示可执行意图；若仅为搁置请保持「待整理」。在状态为「待办」或「进行中」之前，经办人不会被唤醒。",
  agentOptions: "智能体选项",
  claudeOptions: "Claude 选项",
  codexOptions: "Codex 选项",
  opencodeOptions: "OpenCode 选项",
  reusingWorkspaceLine: (name: string, location: string) => `复用 ${name}（${location}）。`,
  existingWorkspaceFallback: "既有执行工作区",
  subIssueOf: "父事务",
  chooseReuseWorkspace: "选择已有工作区",
  subIssueWorkspaceMismatch: (parentLabel: string | undefined) =>
    parentLabel
      ? `警告：此子事务将不再使用父事务工作区（${parentLabel}）。`
      : "警告：此子事务将不再使用父事务工作区。",
  primaryLaneHelp: "使用智能体主模型运行。",
  customLaneHelp: "仅为本事务覆盖模型与思考强度。",
  modelLanePrimary: "主模型",
  modelLaneCheap: "经济通道",
  modelLaneCustom: "自定义",
  inProjectRow: "in",
  priority: {
    critical: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  thinkingDefault: "默认",
  thinkingMinimal: "最低",
  thinkingLow: "低",
  thinkingMedium: "中",
  thinkingHigh: "高",
  thinkingXHigh: "极高",
  thinkingMax: "最高",
  /** Board UX: root issues must belong to a project (agents may still omit). */
  projectRequiredToast: "请先选择所属项目。",
  projectRequiredHint: "创建事务前必须选择一个项目。",
  noProjectsToCreateHint: "当前团队还没有可用项目，请先创建项目后再建事务。",
} as const;

export const newAgent = {
  title: "添加智能体",
  dialogHeader: "添加智能体",
  recommendBody:
    "建议由 CEO 负责智能体配置 — 他们了解组织结构，能设置汇报关系、权限与适配器。",
  askCeo: "请 CEO 创建新智能体",
  advancedLink: "我要自行高级配置",
  back: "返回",
  chooseAdapter: "选择适配器类型以进行高级设置。",
  recommended: "推荐",
  ceoIssueTitle: "请创建新智能体",
  ceoIssueDescription: "（在此描述你想要的智能体类型）",
} as const;

/** Full-page advanced hire flow (`/agents/new`) */
export const newAgentAdvancedPage = {
  pageTitle: "新建智能体",
  pageSubtitle: "高级智能体配置",
  breadcrumbNew: "新建智能体",
  namePlaceholder: "智能体名称",
  titlePlaceholder: "职称（例如：工程副总裁）",
  companySkillsHeading: "公司技能",
  companySkillsHint:
    "可选：从公司技能库挂载。Paperclip 内置运行时技能会自动附加。",
  noOptionalSkills: "尚未安装可选的公司技能。",
  ceoFirstAgentNote: "此人将作为 CEO",
  hireFailedFallback: "创建智能体失败",
  openCodeModelRequired:
    "OpenCode 需要在 provider/model 格式下填写明确模型。",
  cancel: "取消",
  testAgent: "测试智能体",
  testingEllipsis: "测试中…",
  createAgent: "创建智能体",
  creatingEllipsis: "创建中…",
} as const;

export const sidebarCompany = {
  selectWorkspace: "选择工作区",
  openSwitcher: "打开工作区切换",
  switchWorkspaceTitle: "切换工作区",
  openSwitcherNamed: (name: string) => `打开 ${name} 工作区切换`,
  openSwitcherGeneric: "打开工作区切换",
  selectPrompt: "选择工作区",
  reorderTeam: (name: string) => `调整 ${name} 的顺序`,
  edit: "编辑",
  done: "完成",
  noWorkspaces: "暂无工作区",
  addCompany: "添加团队…",
  invite: "邀请成员",
  inviteGeneric: "邀请成员",
  inviteTo: (name: string) => `邀请加入 ${name}`,
  companySettings: "团队设置",
  signingOut: "正在退出…",
  signOut: "退出登录",
} as const;

export const sidebarAgents = {
  section: "智能体",
  newAgentAria: "新建智能体",
  menuAria: "智能体区域操作",
  browse: "浏览智能体",
  sortLabel: "智能体排序",
  sortTop: "置顶顺序",
  sortAlphabetical: "按名称",
  sortRecent: "最近活跃",
  edit: "编辑智能体",
  pause: "暂停智能体",
  resume: "恢复智能体",
  updating: "更新中…",
  budgetPaused: "预算已暂停",
  budgetPausedTitle: "因预算限制已暂停",
  liveRuns: (n: number) => `${n} 个进行中`,
  actionsAria: (name: string) => `操作：${name}`,
  toastPaused: "已暂停智能体",
  toastResumed: "已恢复智能体",
  toastPauseErr: "无法暂停智能体",
  toastResumeErr: "无法恢复智能体",
  budgetMarker: "因预算已暂停",
} as const;

export const sidebarProjects = {
  section: "项目",
  newProjectAria: "新建项目",
  menuAria: "项目区域操作",
  browse: "浏览项目",
  sortLabel: "项目排序",
  sortTop: "置顶顺序",
  sortAlphabetical: "按名称",
  sortRecent: "最近更新",
  budgetPausedTitle: "因预算已暂停",
} as const;

export const issueTreeControl = {
  subtreePause: "暂停子树",
  subtreeResume: "恢复子树",
  subtreeCancel: "取消子树",
  subtreeRestore: "恢复子树事务",
  leafPause: "暂停此事务",
  leafResume: "恢复工作",
  helpSubtreePause: "暂停本子树内活动执行，直至手动恢复。",
  helpSubtreeResume: "解除子树暂停，使被挂起的工作可以继续。",
  helpSubtreeCancel: "取消子树中未结束事务，并尽量停止排队/进行中的运行。",
  helpSubtreeRestore: "恢复本子树操作中取消的事务，以便继续工作。",
  helpLeafPause: "暂停此事务上的活动执行，直至手动恢复。",
  helpLeafResume: "解除暂停挂起，使此事务可继续。",
  preview403: "仅董事会成员可预览子树控制。",
  preview409: "子树状态已变更，预览已过期。请重试刷新。",
  preview422: "当前所选事务无法执行此子树操作。",
  previewLoadFailed: "无法加载预览。",
} as const;

export const issueDetailActors = {
  system: "系统",
  board: "董事会",
  unknown: "未知",
} as const;

/** Issue detail page: chrome, banners, cost summary, tree controls, common toasts */
export const issueDetailUi = {
  backToInboxAria: "返回收件箱",
  archiveFromInboxAria: "从收件箱归档",
  moreActionsAria: "更多操作",
  moreIssueActionsAria: "更多事务操作",
  copyAsMarkdown: "复制为 Markdown",
  properties: "属性",
  hideThisIssue: "隐藏此事务",
  copyIssueMarkdownTitle: "复制事务为 Markdown",
  showPropertiesTitle: "显示属性",
  loadingEarlierComments: "正在加载更早的评论…",
  loadEarlierComments: "加载更早的评论",
  pauseWork: "暂停工作",
  pausingWork: "正在暂停…",
  stopWorkPauseRun: "暂停工作",
  stoppingPauseRun: "正在暂停…",
  costSummaryTitle: "费用摘要",
  noCostDataYet: "暂无费用数据。",
  thisIssueLabel: "本事务",
  tokensSummaryCached: (total: string, inp: string, out: string, cached: string) =>
    `Token ${total}（入 ${inp}，出 ${out}，缓存 ${cached}）`,
  tokensSummaryPlain: (total: string, inp: string, out: string) =>
    `Token ${total}（入 ${inp}，出 ${out}）`,
  runtimeRuns: (dur: string, n: number) => `运行时长 ${dur}（${n} 次运行）`,
  noDirectCostData: "无直接费用数据。",
  includingSubIssuesCostPrefix: "含子事务",
  issuesCountShort: (n: number) => `${n} 个事务`,
  pauseWorkLeaf: "暂停工作",
  pauseSubtreeStopWork: "暂停并停止工作",
  cancelIssuesButton: (n: number) => `取消 ${n} 个事务`,
  restoreIssuesButton: (n: number) => `恢复 ${n} 个事务`,
  resumeWorkLeaf: "恢复工作",
  resumeSubtree: "恢复子树",
  subtreePauseActive: "子树暂停生效中。",
  pausedByBoard: "已由董事会暂停。",
  pauseHintLeaf:
    "本事务执行已暂停，恢复前不会继续。人工评论仍可唤醒经办人以进行分类。",
  pauseHintSubtree:
    "根事务及后代执行已暂停，恢复前不会继续。人工评论仍可唤醒各经办人以进行分类。",
  issueHeldSingleLine: "1 个事务已暂停",
  issueHeldDescendantsLine: (n: number) => `${n} 个子事务已暂停`,
  startedPrefix: " · 始于",
  viewAffectedCount: (n: number) => `查看影响范围（${n}）`,
  cancelSubtreeEllipsis: "取消子树…",
  pausedByAncestorLead: "此事务已被祖先事务暂停：",
  pausedByAncestorTrail: "请从根事务恢复以继续延后工作。",
  issueHiddenBanner: "此事务已隐藏",
  uploadingEllipsis: "上传中…",
  uploadAttachment: "上传附件",
  uploadShort: "上传",
  addDescriptionPlaceholder: "添加描述…",
  explainSubtreeControlPlaceholder: "说明应用此子树控制的原因…",
  productivityReviewTooltip: "此任务为生产力复盘。",
  planningModeTooltip: "此事务处于规划模式。",
  blockedParkedTooltip:
    "被搁置工作阻塞 — 至少一名被指派的阻塞事务处于待整理状态，不会唤醒其经办人。",
  subtreeWakeNobodyEligible: "预览中没有符合条件的经办人可被唤醒。",
  subtreeWakeAgentsAfterOp: "操作完成后唤醒已分配的经办人。",
  pauseSubtreeEllipsis: "暂停子树…",
  restoreSubtreeEllipsis: "恢复子树…",
  pauseWorkEllipsis: "暂停工作…",
  restoreSubtreeHelp:
    "恢复本子树操作中取消的事务，以便继续工作。",
  deleteAttachmentTitle: "删除附件",
  toastSubtreeResumed: "子树已恢复",
  toastWorkResumed: "工作已恢复",
  toastSubtreePaused: "子树已暂停",
  toastWorkPaused: "工作已暂停",
  treeControlAppliedSuffix: "已应用",
  toastIssueUpdateFailed: "事务更新失败",
  toastUnableSaveIssue: "无法保存事务更改",
  toastUnableApplySubtree: "无法应用子树控制",
  toastPleaseRetry: "请重试。",
  errNoSubtreeHoldToResume: "没有可恢复的活跃子树暂停挂起。",
  toastReleasePauseLeafFallback: "已解除本事务活动暂停。",
  toastReleasePauseSubtreeFallback: "已解除子树活动暂停。",
  toastWorkPausedRunsCancelledLeaf: (n: number) =>
    `工作已暂停。已取消 ${n} 次运行。`,
  toastWorkPausedRunsCancelledSubtree: (n: number) =>
    `子树已暂停。已取消 ${n} 次运行。`,
  toastSubtreeControlAppliedFallback: "子树控制已应用。",
  toastUnablePauseWork: "无法暂停工作",
  toastWorkPausedTitle: "工作已暂停",
  toastWorkPausedHeldLeaf: "工作已暂停。在恢复前此事务将保持挂起。",
  toastWorkPausedHeldSubtree: "工作已暂停。子树将挂起直至恢复。",
  pausedFromActiveRunReason: "由活动运行控制暂停。",
  toastUnableSaveSubIssue: "无法保存子事务更改",
  toastMonitorQueued: "监控检查已排队",
  toastMonitorFailed: "监控检查失败",
  toastUnableTriggerMonitor: "暂时无法触发监控",
  toastApprovalApproved: "审批已通过",
  toastApprovalRejected: "审批已拒绝",
  toastApprovalApproveFailed: "审批失败",
  toastApprovalRejectFailed: "拒绝失败",
  toastUnableUpdateApproval: "无法更新审批",
  toastCancelFailed: "取消失败",
  toastUnableCancelQueuedComment: "无法取消排队中的评论",
  toastCommentFailed: "评论失败",
  toastUnablePostComment: "无法发表评论",
  toastRequestConfirmed: "请求已确认",
  toastSuggestedTasksAccepted: "建议任务已接受",
  toastAcceptFailed: "接受失败",
  toastUnableAcceptSuggestions: "无法接受建议任务",
  toastRequestDeclined: "请求已拒绝",
  toastSuggestionRejected: "建议已拒绝",
  toastRejectFailed: "拒绝失败",
  toastUnableRejectSuggestions: "无法拒绝建议任务",
  toastAnswersSubmitted: "答案已提交",
  toastSubmitFailed: "提交失败",
  toastUnableSubmitAnswers: "无法提交答案",
  toastUnableCancelQuestion: "无法取消该提问",
  toastQuestionCancelled: "问题已取消",
  toastInterruptRequested: "已请求中断",
  toastInterruptBody: "正在停止当前运行，以便排队评论稍后继续。",
  toastInterruptFailed: "中断失败",
  toastUnableInterruptRun: "无法中断当前运行",
  toastQueuedCommentCanceled: "排队评论已取消",
  toastQueuedRestoredComposer: "排队消息已恢复到编辑器。",
  toastCopiedClipboard: "已复制到剪贴板",
  toastIssueArchivedInbox: "事务已从收件箱归档",
  toastArchiveFailed: "归档失败",
  toastUnableArchiveInbox: "无法将此事务从收件箱归档",
  toastSaveFeedbackFailed: "保存反馈失败",
  toastUnknownError: "未知错误",
  uploadFailed: "上传失败",
  documentImportFailed: "文档导入失败",
  deleteFailed: "删除失败",
  feedbackSavedFutureShare: "反馈已保存。后续投票将共享",
  feedbackSavedFutureLocal: "反馈已保存。后续投票仅本地保存",
  feedbackSavedSharingEnabled: "反馈已保存并已启用共享",
  feedbackSaved: "反馈已保存",
  pausedComposerWakeAssignee: (name: string) =>
    `发送此评论将在子树仍暂停时唤醒 ${name} 以进行分类。`,
  pausedComposerWakeNeedAssignee:
    "请先分配经办人，以便在子树暂停期间唤醒其进行分类。",
  productivityReviewChip: "生产力复盘",
  planningModeChip: "规划中",
  blockedParkedChip: "被搁置阻塞",
  /** Header pill when this issue has queued/running adapter work */
  liveRunChip: "实时",
  routineChip: "例行",
  noProjectChip: "无项目",
  toastAcceptedDraftsSkipped: (created: number, skipped: number) =>
    `已接受 ${created} 条草稿，跳过 ${skipped} 条`,
  deleteAttachmentConfirm: "删除此附件？",
  confirmYes: "是",
  confirmNo: "否",
  subIssuesSectionTitle: "子事务",
  newSubIssueButton: "新建子事务",
  createSubIssueLabel: "子事务",
  attachmentsSectionTitle: "附件",
  attachmentImageAlt: "附件",
  previewSkippedTerminalStatus: "已完成",
  previewUnavailable: "预览不可用。",
  closeDialog: "关闭",
  applyingEllipsis: "正在应用…",
  breadcrumbFallbackTitle: "事务",
  childPausedBadge: "已暂停",
  cancelSubtreeDestructiveWarning:
    "取消子树具有破坏性：未结束的事务将被标记为已取消，并将尽可能中断进行中或排队的工作。",
  treeControlReasonOptional: "原因（可选）",
  wakeAffectedAgentsTitle: (n: number) => `唤醒受影响经办人（${n}）`,
  detailTabChat: "聊天",
  detailTabActivity: "动态",
  detailTabRelatedWork: "相关工作",
} as const;

export const sidebarAccountMenu = {
  boardFallback: "董事会",
  signedIn: "已登录",
  localWorkspaceBoard: "本地工作区董事会",
  badgeAccount: "账户",
  badgeLocal: "本地",
  openMenuAria: "打开账户菜单",
  viewProfile: "查看资料",
  viewProfileDesc: "打开你的活动、任务与用量账本。",
  editProfile: "编辑资料",
  editProfileDesc: "更新显示名称与头像。",
  instanceSettings: "实例设置",
  instanceSettingsDesc: "跳转到你上次打开的实例设置页面。",
  documentation: "文档",
  documentationDesc: "在新标签页打开 Paperclip 文档。",
  switchToLight: "切换到浅色模式",
  switchToDark: "切换到深色模式",
  themeToggleDesc: "切换应用外观。",
  signingOut: "正在退出…",
  signOut: "退出登录",
  signOutDesc: "结束当前浏览器会话。",
  versionPrefix: "Paperclip v",
} as const;

export const agentDetailUi = {
  invocation: "调用",
  adapter: "适配器",
  workingDir: "工作目录",
  command: "命令",
  commandNotes: "命令说明",
  prompt: "提示词",
  context: "上下文",
  environment: "环境",
  loadingLog: "正在加载日志…",
  noLogLines: "暂无持久化日志行",
  stderrExcerpt: "stderr 摘录",
  stdoutExcerpt: "stdout 摘录",
  worktreeSetup: "工作区准备",
  provision: "供给",
  teardown: "拆除",
  worktreeCleanup: "工作区清理",
  assignTask: "分配任务",
  live: "实时",
  pendingApproval: "此智能体待董事会审批，暂不可调用。",
  approveAgent: "批准智能体",
  recentIssues: "最近事务",
  latestRunHeading: "最近运行",
  liveRunHeading: "进行中运行",
  latestRunViewDetails: "查看详情 →",
  noRecentIssues: "暂无相关事务",
  costs: "用量与费用",
  inputTokens: "输入 token",
  outputTokens: "输出 token",
  cachedTokens: "缓存 token",
  totalCost: "总费用",
  date: "日期",
  runId: "运行",
  input: "输入",
  output: "输出",
  cost: "费用",
  apiKeys: "API 密钥",
  noConfigRevisions: "尚无配置修订。",
  branch: "分支",
  baseRef: "基线引用",
  worktreePath: "Worktree",
  repoRoot: "仓库根目录",
  cleanup: "清理动作",
  sourceTimer: "定时",
  sourceAssignment: "分配",
  sourceOnDemand: "按需",
  sourceAutomation: "自动化",
  details: "详情",
  waitingTranscript: "等待转写…",
  noTranscriptPersisted: "此运行尚无持久化转写。",
  permissionsTitle: "权限",
  canCreateAgentsLabel: "可创建新智能体",
  canCreateAgentsHint: "允许此智能体创建或雇佣其他智能体并隐式分配任务。",
  canAssignTasksLabel: "可分配任务",
  taskAssignHintCeo: "CEO 智能体自动启用。",
  taskAssignHintAgentCreator: "在可创建新智能体时自动启用。",
  taskAssignHintExplicit: "已通过公司显式授权启用。",
  taskAssignHintDisabled: "除非显式授权，否则禁用。",
  filesHeading: "文件",
  fileCreate: "创建",
  fileCancel: "取消",
  virtualFileBadge: "虚拟文件",
  virtualFileTooltip: "旧版内联提示词：此废弃虚拟文件保留原 promptTemplate 内容。",
  entryBadge: "入口",
  skillView: "查看",
  skillLocationPrefix: "位置：",
  importSkillsFirst: "请先将技能导入公司库，再在此处挂载。",
  requiredByPaperclip: "Paperclip 要求",
  userInstalledSkillsBanner: (n: number) => `（${n}）用户自行安装，非 Paperclip 管理`,
  missingSkillsTitle: "所需技能在公司库中缺失",
  skillsApplied: "已应用技能",
  selectedSkills: "已选技能",
  failedUpdateSkills: "无法更新技能",
  unsupportedSkillHint: "请在适配器中直接管理技能。",
  noRunsYet: "尚无运行记录。",
  backToRuns: "返回运行列表",
  sessionLabel: "会话",
  sessionChanged: "（已变更）",
  sessionBefore: "之前",
  sessionAfter: "之后",
  sessionIdShort: "ID",
  clearSessionConfirm: (n: number) =>
    n === 1
      ? "清除此运行所触及的 1 个事务的会话？"
      : `清除此运行所触及的 ${n} 个事务的会话？`,
  clearingSession: "正在清除会话…",
  clearSessionForIssues: "清除这些事务的会话",
  failedClearSessions: "无法清除会话",
  issuesTouched: (n: number) => `触及的事务（${n}）`,
  stderrHeading: "stderr",
  stdoutHeading: "stdout",
  loadingRunLogs: "正在加载运行日志…",
  noLogEvents: "暂无日志事件。",
  failureDetails: "失败详情",
  errorPrefix: "错误：",
  adapterResultJson: "适配器 result JSON",
  eventsCount: (n: number) => `事件（${n}）`,
  transcriptCount: (n: number) => `转写（${n}）`,
  transcriptModeNice: "友好",
  transcriptModeRaw: "原始",
  jumpToLive: "跳到实时",
  loadMoreLog: "加载更多日志",
  loadingShort: "加载中…",
  showingLogProgress: (shownKb: string, totalKb?: string) =>
    totalKb ? `已显示前 ${shownKb} KB，共 ${totalKb} KB` : `已显示前 ${shownKb} KB`,
  workspaceLogHide: "隐藏完整日志",
  workspaceLogShow: "显示完整日志",
  workspaceLogLoadFailed: "无法加载工作区操作日志",
  workspaceSectionCount: (n: number) => `工作区（${n}）`,
  workspaceCreatedThisRun: "由此运行创建",
  workspaceReused: "复用已有工作区",
  timeRangeTo: "至",
  apiKeyCreatedBanner: "API 密钥已创建 — 请立即复制，之后不再显示。",
  hide: "隐藏",
  show: "显示",
  copy: "复制",
  copied: "已复制",
  dismiss: "关闭",
  createApiKeySection: "创建 API 密钥",
  apiKeyAuthDescription: "API 密钥用于此智能体向 Paperclip 服务器认证调用。",
  keyNamePlaceholder: "密钥名称（如 production）",
  createKeyButton: "创建",
  loadingKeys: "正在加载密钥…",
  noActiveApiKeys: "暂无有效 API 密钥。",
  activeKeysTitle: "有效密钥",
  revokedKeysTitle: "已撤销密钥",
  keyCreated: "创建于",
  keyRevoked: "已撤销于",
  revokeKey: "撤销",
  runHeartbeat: "运行心跳",
  runNowButtonLabel: "立即运行",
  pauseAgentButton: "暂停",
  resumeAgentButton: "恢复",
  actionFailedFallback: "操作失败",
  resetSessionFailedFallback: "无法重置会话",
  updatePermissionsFailedFallback: "无法更新权限",
  chartRunActivity: "运行活跃度",
  chartLast14Days: "最近 14 天",
  chartIssuesByPriority: "事务优先级分布",
  chartIssuesByStatus: "事务状态分布",
  chartSuccessRate: "成功率",
  seeAllIssues: "查看全部 →",
  moreIssuesFooter: (n: number) => `+另有 ${n} 条事务`,
  copyAgentId: "复制智能体 ID",
  resetSessions: "重置会话",
  terminateAgent: "终止智能体",
  saveFailedToastTitle: "保存失败",
  couldNotSaveAgent: "无法保存智能体",
  savingEllipsis: "保存中…",
  saveButton: "保存",
  failedResumeRun: "无法恢复运行",
  failedRetryRun: "无法重试运行",
  cancelRunButton: "取消",
  cancellingEllipsis: "正在取消…",
  resumeRunButton: "恢复",
  resumingEllipsis: "正在恢复…",
  retryRunButton: "重试",
  retryingEllipsis: "重试中…",
  retrySkippedFallback: "已跳过重试。",
  durationLabel: "时长：",
  claudeLoginRunning: "正在登录 Claude Code…",
  loginToClaudeCode: "登录 Claude Code",
  failedClaudeLogin: "无法执行 Claude 登录",
  loginUrlLabel: "登录链接：",
  exitCodeLabel: "退出码",
  signalLabel: "信号",
  skillModePersistent: "保留在工作区",
  skillModeEphemeral: "智能体运行时应用",
  skillModeUnsupported: "仅追踪",
  skillModeUnknown: "未知",
  unsupportedSkillAcpxCustom: "Paperclip 暂无法为自定义 ACP 命令管理技能。",
  unsupportedSkillOpenclaw:
    "Paperclip 无法在此处管理 OpenClaw 技能，请在 OpenClaw 实例中管理。",
  unsupportedSkillGeneric:
    "Paperclip 暂无法为此适配器管理技能，请在适配器中直接管理。",
  skillSavingChanges: "正在保存更改…",
  skillSavingSoon: "即将保存…",
  viewCompanySkillsLibrary: "查看公司技能库",
  failedLoadRunLog: "无法加载运行日志",
  failedLoadMoreRunLog: "无法加载更多运行日志",
  instructionsAdvancedCollapsible: "高级选项",
  instructionsModeLabel: "模式",
  instructionsModeTooltip:
    "托管：由 Paperclip 存储并提供指令包。外部：你在磁盘上自行指定存放指令包的目录路径。",
  instructionsModeManaged: "托管",
  instructionsModeExternal: "外部",
  instructionsRootPathLabel: "根路径",
  instructionsRootPathTooltip:
    "指令包在磁盘上的绝对目录。托管模式下由 Paperclip 自动设置。",
  instructionsRootPathManagedEmpty: "（托管）",
  instructionsEntryFileLabel: "入口文件",
  instructionsEntryFileTooltip:
    "智能体加载指令时最先读取的文件。默认为 AGENTS.md。",
  bundlePathPlaceholder: "/absolute/path/to/agent/prompts",
  newInstructionFilePlaceholder: "TOOLS.md",
  instructionsHeadingPlaceholder: "# 智能体指令",
  fileContentsPlaceholder: "文件内容",
  copyAsMarkdownTitle: "复制为 Markdown",
} as const;

/** Field (?) tooltip copy for AgentConfigForm / primitives — keys must stay in sync with `help` usages. */
export const agentConfigHelp: Record<string, string> = {
  name: "智能体列表与界面中显示的展示名称。",
  title: "在组织图中展示的职位头衔。",
  role: "组织角色，用于权限边界与编排。",
  reportsTo: "组织层级里，该智能体的上级智能体。",
  capabilities:
    "说明该智能体能承担的工作范围；会在组织图中展示，并参与任务分发相关逻辑。",
  adapterType:
    "运行载体：本地 CLI（Claude / Codex / OpenCode 等）、OpenClaw 网关、派生子进程或通用 HTTP Webhook。",
  cwd:
    "已弃用的遗留「工作目录」兜底项。存量智能体可能仍带此项；新建配置请优先使用项目工作区。",
  promptTemplate:
    "每次心跳都会附带发送的动态提示。宜保持短小、偏任务语境，不要用其承载大块静态说明书。可使用 {{ agent.id }}、{{ agent.name }}、{{ agent.role }} 等模板变量。",
  model: "覆盖适配器默认选用的模型标识。",
  thinkingEffort: "控制模型的推理开销档位；取值范围因适配器/模型而异。",
  chrome: "通过传入 --chrome 启用 Claude 的浏览器（Chrome）集成。",
  dangerouslySkipPermissions: "在无人在场前提下自动放行适配器权限提示（若适配器支持）。",
  dangerouslyBypassSandbox: "以无沙箱方式运行 Codex；需要访问本地文件系统或网络时通常会开启。",
  search: "在 Codex 运行过程中启用网页搜索能力。",
  fastMode:
    "开启 Codex 快速模式：消耗令牌或计费更快；适用于 GPT‑5.4 及手写 Codex 模型 ID。",
  workspaceStrategy:
    "Paperclip 如何落实到具体执行目录。通常为 project_primary；也可使用 git_worktree 为单笔事务检出独立分支。",
  workspaceBaseRef: "创建工作区（含 worktree）分支时的基准引用；留空则用解析得到的仓库引用或 HEAD。",
  workspaceBranchTemplate:
    "派生分支命名模板；支持 {{issue.identifier}}、{{issue.title}}、{{agent.name}}、{{project.id}}、{{workspace.repoRef}}、{{slug}} 等变量。",
  worktreeParentDir: "衍生 worktree 的父目录；可为绝对路径、带 ~/ 的主目录简写或相对仓库根的路径。",
  runtimeServicesJson:
    "可选：随工作区一起启动的长期驻留服务（示例：本地后端、常驻 worker）JSON 声明。",
  maxTurnsPerRun: "单次心跳运行允许的智能体回路（常见为工具往返）上限轮数。",
  command: "要启动的主命令（示例：node、python）。",
  localCommand:
    "显式指定要调用的 CLI 可执行文件路径（例如 /usr/local/bin/claude、coder、本地 OpenCode CLI）。",
  args: "主命令的参数列表，逗号分隔。",
  extraArgs: "附加在命令行末尾的适配器专有参数，逗号分隔。",
  envVars: "注入适配器进程的环境变量；可使用明文或通过密钥引用占位。",
  bootstrapPrompt:
    "仅在会话首次拉起时附带发送；适合一次性环境说明；不应在每轮心跳重复。",
  payloadTemplateJson:
    "可选：在 Paperclip 拼装标准负载之前，与对方 Webhook/API 载荷合并的一段 JSON。",
  webhookUrl: "收到唤醒事件时向对方 POST 的有效 URL。",
  heartbeatInterval:
    "按固定周期间隔为该智能体派发心跳运行；常用于后台巡检类的定时任务。",
  intervalSec: "两次心跳运行之间的最短间隔秒数。",
  timeoutSec: "单个运行可被允许的最长时间（秒）；0 表示不按时间强制终止。",
  graceSec: "发送中断信号后等待进程自行退出的宽限秒数，超时再强制结束。",
  wakeOnDemand: "允许工作流在需要时按需唤醒智能体（任务分配、界面操作、调用 API、自动化流水线等）。",
  cooldownSec: "两次心跳派发之间的最短冷却间隔秒数。",
  maxConcurrentRuns: "该智能体在任意时刻可同时存在的运行个数上限。",
  maxTurnContinuationEnabled:
    "当运行因内置「最多轮数」策略正常停下时，按规则自动接续若干次新运行直至任务收敛或用尽次数。",
  maxTurnContinuationMaxAttempts: "接续策略允许的最大接续次数（与单次 max turns 配额不同维度）。",
  maxTurnContinuationDelaySec: "每次接续运行派发前的休眠秒数。",
  budgetMonthlyCents:
    "以「分」为单位的自然月开销上限（按 UTC）；0 或留空语义为不设上限（仍受公司总控）。",
};

export const agentConfigUi = {
  configRevisionsTitle: "配置修订",
  configRestoreButton: "恢复到此版本",
  configRevisionChangedPrefix: "变更项：",
  configRevisionNoTrackedChanges: "无已跟踪的配置键变更",

  sectionIdentity: "身份",
  sectionExecution: "执行环境",
  sectionAdapter: "适配器",
  sectionPermissionsAndConfig: "权限与适配器选项",
  sectionRunPolicy: "运行策略",
  advancedRunPolicy: "高级运行策略",

  configUnsavedChanges: "尚未保存的修改",

  fieldName: "名称",
  placeholderAgentName: "智能体名称",
  fieldTitle: "职位",
  placeholderTitleExample: "例如：工程副总",
  fieldReportsTo: "汇报上级",
  fieldCapabilities: "能力说明",
  placeholderCapabilities: "概括该智能体的职责边界与擅长领域…",
  fieldPromptTemplate: "心跳提示词片段",
  placeholderPromptRoleFraming:
    "例如：你是 {{ agent.name }}，岗位是 {{ agent.role }}，当前需配合团队完成……",
  bannerPromptHeartbeatCost:
    "该片段会在每次心跳重复附带。请写得短而有针对性，以降低 token 成本和缓存抖动。",

  hintDefaultExecutionTarget:
    "设置在智能体级别默认选用的执行载体；可被项目级或单笔事务的设置覆盖。",
  fieldDefaultEnvironment: "默认环境",
  optionCompanyDefaultLocal: "与公司默认保持一致（本地）",

  fieldAdapterType: "适配器类型",
  testEnvironmentShort: "测试",
  testingEnvironmentEllipsis: "测试中…",

  envTestFailedGeneric: "环境探测未通过",

  fieldWorkingDirDeprecated: "工作目录（已弃用）",
  placeholderProjectPathUnix: "/path/to/project",

  fieldCommandLine: "启动命令",

  bannerBootstrapDeprecation:
    "启动提示阶段的内容属于旧链路，后续版本将下线。请将稳定说明迁至「指令文件」或长期提示片段。",

  fieldBootstrapLegacy: "启动提示词（遗留）",
  placeholderBootstrapPrompt: "首次会话可选的环境说明 Markdown",

  fieldExtraArgsComma: "追加 CLI 参数（逗号分隔）",
  placeholderExtraArgsExample: "例如 --verbose, --temperature=0.2",

  fieldEnvironmentVariables: "环境变量编辑器",

  fieldTimeoutSeconds: "单轮超时（秒）",
  fieldGraceInterruptSeconds: "中断后的宽限期（秒）",

  toggleHeartbeatInterval: "按固定间隔派发心跳",
  runHeartbeatEveryPrefix: "每隔",
  unitSecondsShort: "秒",

  toggleWakeOnDemand: "允许系统按需唤醒",

  fieldCooldownSeconds: "心跳最小间隔（秒）",
  fieldMaxConcurrentRuns: "最大并行运行数",

  toggleContinuationAfterCap: "在触达轮数上限后自动接续",
  fieldContinuationAttempts: "接续派发次数上限",
  fieldContinuationDelaySeconds: "接续前等待（秒）",

  labelPrimaryModelRow: "主模型",
  fieldModelDropdown: "模型",

  bannerCodexMinimalWithSearch:
    "已开启联网检索时，`minimal` 推理档位可能被 Codex 套件拒绝。",


  detectModelAction: "从当前配置探测模型",
  redetectModelAction: "重新探测模型",
  modelSearchPlaceholderTypedCreate: "搜索模型标识…（末尾可直接回车手写）",
  modelSearchPlaceholder: "搜索可用模型…",
  modelBadgeCurrent: "当前",
  modelBadgeDetected: "已探测",
  modelBadgeViaConfig: "配置携带",
  modelUseManualChoice: "使用手写模型",

  placeholderModelPickDefault: "默认（随适配器）",
  placeholderModelPickRequired: "请选择模型（必填）",
  placeholderModelPickOptional: "选择模型",

  modelDetectRunning: "正在探测本地模型标识…",

  refreshingModelsEllipsis: "刷新列表中…",
  refreshModelCatalog: "刷新模型目录",

  modelListNoMatches: "没有匹配的候选项",
  emptyDetectNeedsManualVendor:
    "暂时还没有解析到模型指纹，请直接在下方手写 provider/model。",


  adapterExperimentalPill: "实验性",

  adapterComingSoon: "即将上线",

  envTestStatusPass: "通过",
  envTestStatusWarn: "有告警",
  envTestStatusFail: "失败",
  envTestHintLabel: "建议：",

  cheapProfileTitle: "经济档模型",
  cheapProfileSubtitle:
    "当运行显式切换到「cheap」资费策略时使用；主会话模型不会被替换。",


  hintAdapterDefaultLine: (m: string) => `适配器建议默认：${m}`,
  hintNoCheapDefaultPrompt: "当前适配器未声明便宜档默认，需要你手工指定。",


  noteCheapImplicitFallbackPrefix: "未手写便宜档时将退回到适配器兜底：",

  warningCheapUnset:
    "未选择专用便宜模型且适配器亦无默认；此类运行会先落在主模型上并附加说明标记。",

  openCodeNeedsLocalDiscovery: (environmentName: string) =>
    `实时 OpenCode 模型探测仅在「driver = local」的环境可用。当前会话使用「${environmentName}」环境下的静态列表以及手动条目。`,

  thinkingEffortAuto: "自动（跟随适配器）",
  thinkingEffortMinimal: "极低",
  thinkingEffortLow: "低",
  thinkingEffortMedium: "标准",
  thinkingEffortHigh: "偏高",
  thinkingEffortXHigh: "超高",
  thinkingEffortMax: "最大",
  cursorModePlan: "规划优先",
  cursorModeAsk: "问答优先",

  fieldThinkingEffort: "推理 / 档位",
  fallbackFailedRefreshModels: "刷新模型目录失败",

  fallbackFailedLoadModelsFallback: "无法加载适配器的模型候选列表。",


  reportsPickerChoosePlaceholder: "选择上级智能体…",
  reportsPickerCeoLocked: "仅 CEO — 暂无上级",

  unknownManagerStaleId: "未知上级引用（陈旧 ID）",
  reportingLineTerminatedSuffix: "（实例已归档）",

  reportsToNobody: "不指定上级",

  reportsCurrentTerminated: (managerName: string) => `当前记录：${managerName}（已归档）`,
  reportsStaleExplanation: "原上级已不在团队中，请选择新的管理者或清空。",
  reportingVerbWithName: (managerName: string, terminatedPhrase: string) =>
    `向 ${managerName} 汇报${terminatedPhrase}`,
} as const;

/** 智能体配置 — 环境变量表格（明文 / 公司密钥引用） */
export const envVarEditorUi = {
  sourcePlain: "明文",
  sourceSecret: "密钥",
  selectSecretPlaceholder: "选择密钥…",
  missingSecretOption: (idPrefix: string) => `缺失（${idPrefix}…）`,
  versionLatest: "最新",
  versionSelectAria: "密钥版本",
  placeholderVarName: "变量名",
  placeholderVarValue: "变量值",

  sealButton: "封存",
  sealButtonTitle: "将当前明文写入公司密钥库，并改为引用该密钥",
  newSecretButton: "新建",
  newSecretButtonTitle: "用当前明文创建一条新密钥并引用",

  secretNamePrompt: "密钥名称",
  createSecretFailed: "创建密钥失败",

  bindingIssueIntro: (n: number) => (n === 1 ? "有 1 处密钥绑定需要处理：" : `有 ${n} 处密钥绑定需要处理：`),
  bindingReasonMissing: "找不到对应密钥",
  runsBlockedUntilRemapped: "在重新选择密钥或恢复其状态之前，相关运行可能失败。",

  footerHint:
    "「变量名」填写进程期望的环境变量名（例如 GH_TOKEN）。选择「密钥」可在运行前解析为公司密钥库中的值。以 PAPERCLIP_ 开头的变量仍由系统自动注入。",
} as const;

const BUDGET_SCOPE_TYPE_ZH: Record<string, string> = {
  company: "公司",
  agent: "智能体",
  project: "项目",
};

/** 预算事件的暂停原因 — 仅界面展示（API 值仍为英文） */
const BUDGET_PAUSE_REASON_ZH: Record<string, string> = {
  manual: "手动",
  budget: "预算",
  system: "系统",
};

/** 预算策略卡片（Costs、智能体 / 项目详情的 plain 与默认 card） */
export const budgetPolicyUi = {
  sectionObserved: "已入账",
  sectionBudget: "预算",
  pctOfLimit: (p: number) => `限额已用 ${p}%`,
  noCapConfigured: "未配置上限",
  budgetDisabledDisplay: "已关闭",

  softWarnThreshold: (p: number) => `告警阈值 ${p}%`,
  pauseReasonPausedSuffix: (reasonZh: string) => ` · ${reasonZh}暂停`,

  remainingLabel: "剩余",
  unlimited: "无上限",

  windowLifetime: "终身预算",
  windowMonthlyUtc: "按月预算（UTC）",

  badgePaused: "已暂停",
  badgeWarning: "告警",
  badgeHardStop: "熔断",
  badgeHealthy: "正常",

  pauseExecutionProject:
    "在提高预算或关闭关联事件之前，此项目的执行任务将保持暂停。",
  pauseHeartbeatsScope:
    "在提高预算或关闭关联事件之前，此范围内的心跳将保持暂停。",

  budgetUsdLabel: "预算（美元）",
  budgetInputPlaceholder: "0.00",
  savingButton: "保存中…",
  updateBudgetButton: "更新预算",
  setBudgetButton: "设置预算",

  invalidUsdInputHint: "请输入有效的非负数（美元）。",
} as const;

export function formatBudgetScopeTypeZh(scopeType: string): string {
  return BUDGET_SCOPE_TYPE_ZH[scopeType] ?? titleCaseUnderscores(scopeType);
}

export function formatBudgetWindowKindLabel(windowKind: string): string {
  return windowKind === "lifetime"
    ? budgetPolicyUi.windowLifetime
    : budgetPolicyUi.windowMonthlyUtc;
}

export function formatBudgetPauseReasonZh(reason: string): string {
  return BUDGET_PAUSE_REASON_ZH[reason] ?? reason;
}

export function formatBudgetPolicyStatusBadge(paused: boolean, status: string): string {
  if (paused) return budgetPolicyUi.badgePaused;
  if (status === "warning") return budgetPolicyUi.badgeWarning;
  if (status === "hard_stop") return budgetPolicyUi.badgeHardStop;
  return budgetPolicyUi.badgeHealthy;
}

export function budgetPolicySoftWarnLine(
  warnPercent: number,
  paused: boolean,
  pauseReason: string | null,
): string {
  const base = budgetPolicyUi.softWarnThreshold(warnPercent);
  if (paused && pauseReason) {
    return `${base}${budgetPolicyUi.pauseReasonPausedSuffix(formatBudgetPauseReasonZh(pauseReason))}`;
  }
  return base;
}

/** 审批记录在收件箱等处展示的状态（API 仍为英文枚举） */
const INBOX_APPROVAL_STATUS_ZH: Record<string, string> = {
  pending: "待处理",
  revision_requested: "需修改",
  approved: "已批准",
  rejected: "已拒绝",
  cancelled: "已取消",
};

export function formatInboxApprovalStatus(status: string): string {
  return INBOX_APPROVAL_STATUS_ZH[status] ?? formatBadgeStatus(status);
}

/** 审批类型短名 — {@link ApprovalPayload} 与用户可见标题前缀 */
export const approvalPayloadTypeLabels: Record<string, string> = {
  hire_agent: "雇佣智能体",
  approve_ceo_strategy: "CEO 战略",
  budget_override_required: "预算超限",
  request_board_approval: "董事会审批",
};

/** 收件箱页、行内控件与相关列表（列选择器、“实时”徽章等） */
export const inboxUi = {
  selectCompanyMessage: "请先选择公司以查看收件箱。",

  tabs: {
    mine: "与我相关",
    recent: "最近",
    unread: "未读",
    all: "全部",
  } as const,

  creatorQuickLabelBoard: "看板",
  creatorQuickLabelSelf: "自己",

  searchPlaceholder: "搜索收件箱…",

  nestingEnableTitle: "开启父子事务嵌套",
  nestingDisableTitle: "关闭父子事务嵌套",
  groupByTitle: "分组",
  groupByNone: "不分组",
  groupByType: "类型",
  groupByAssignee: "负责人",
  groupByProject: "项目",
  groupByWorkspace: "工作区",

  issueColumnPickerEyebrow: "桌面端事务行",
  issueColumnPickerDefaultTitle: "选择收件箱中显示的列",
  columnsButton: "列",
  resetColumnsDefaults: "恢复默认",
  resetColumnsHint: "状态、编号、更新时间",

  issuesColumnLabels: {
    status: "状态",
    id: "编号",
    assignee: "分配对象",
    project: "项目",
    workspace: "工作区",
    parent: "父事务",
    labels: "标签",
    updated: "最近活跃",
  } as const satisfies Record<string, string>,

  issuesColumnDescriptions: {
    status: "左侧状态图标。",
    id: "如 PAP-1009 的编号。",
    assignee: "分配的智能体或协作人。",
    project: "关联项目色块名称。",
    workspace: "执行或项目侧工作区名称。",
    parent: "父事务编号与标题。",
    labels: "事务标签名称。",
    updated: "最近可见活跃时间说明。",
  } as const satisfies Record<string, string>,

  liveBadge: "实时",
  swipeArchive: "归档",

  markAsReadAria: "标记已读",
  dismissFromInboxAria: "从收件箱移除",
  dismissAria: "关闭",

  failedRunFallbackMessage: "运行异常退出（无详细文案）。",
  failedRunUntitledIssue: "失败运行",
  failedRunWithAgentSep: " — ",

  retry: "重试",
  retrying: "重试中…",

  approve: "批准",
  reject: "拒绝",

  approvalRequestedByLine: (name: string) => `由 ${name} 发起`,

  joinRequestIpLine: (timeAgoText: string, ip: string) => `${timeAgoText} 自 IP ${ip} 提出申请`,
  joinRequestAdapterPrefix: "适配器：",

  joinRequestAgentBare: "智能体加入申请",
  joinRequestAgentNamed: (name: string) => `智能体加入申请：${name}`,
  joinRequestHumanFallback: "人工加入申请",

  agentsErrorSummary: (n: number) => `${n} 个智能体出现错误`,
  budgetMonthUtilSummary: (pct: number) => `本月预算已用 ${pct}%`,

  markAllRead: "全部标为已读",
  markingEllipsis: "处理中…",
  markAllReadConfirmTitle: "全部标为已读？",
  markAllReadConfirmBodyOne: "将把 1 条未读标为已读。",
  markAllReadConfirmBodyMany: (n: number) => `将把 ${n} 条未读标为已读。`,
  cancel: "取消",

  categoryPlaceholder: "类别",
  approvalStatusPlaceholder: "审批状态",

  categoryEverything: "全部分类",
  categoryRecentIssues: "我最近接触的事务",
  categoryJoinRequests: "加入申请",
  categoryApprovals: "审批",
  categoryFailedRuns: "失败运行",
  categoryAlerts: "告警",

  approvalFilterAllStatuses: "全部审批状态",
  approvalFilterActionable: "待我处理",
  approvalFilterResolved: "已结案",

  emptySearch: "没有与搜索条件匹配的收件项。",
  emptyMine: "收件箱已清空。",
  emptyUnread: "暂无新收件项。",
  emptyRecent: "暂无最近收件项。",
  emptyFiltered: "当前筛选条件下没有收件项。",

  searchArchivedDivider: "已归档",
  searchOtherDivider: "其他匹配",
  timeDividerEarlier: "更早",

  alertsSectionTitle: "提醒",

  newIssueInGroupTitle: (groupLabel: string) => `在「${groupLabel}」新建事务`,
  newIssueInGroupAria: (groupLabel: string) => `在「${groupLabel}」新建事务`,

  subTasksOne: "（1 个子任务）",
  subTasksMany: (n: number) => `（${n} 个子任务）`,

  errApprove: "批准失败",
  errReject: "拒绝失败",
  errApproveJoin: "批准加入失败",
  errRejectJoin: "拒绝加入失败",
  errArchiveIssue: "无法归档",
  errUndoArchive: "无法撤销归档",
  errRetrySkipped: "重试已跳过。",

  activityUpdated: (t: string) => `更新于 ${t}`,

  issueRowPlanningTooltip: "此事务处于规划模式。",
  issueRowParkedBlockerTooltip: "被停滞工作阻塞——至少有一名已分配阻塞者为待整理状态，暂时不会唤起执行者。",
  issueRowProductivityReviewAria: "待效率复盘",
  productivityReviewTooltip: (detail: string) => `效率复盘：${detail}`,
  planningModeChip: "规划中",
  parkedWorkChip: "阻塞（待整理）",

  assigneeFallbackLabel: "用户",
  workspaceFilterTooltip: "按此工作区筛选",
  parentSubIssueItalic: "子事务",
} as const;

/** 侧栏「团队」→「组织」页（组织图） */
export const orgChartUi = {
  importCompany: "导入团队",
  exportCompany: "导出团队",
  emptySelectCompany: "请先选择团队以查看组织图。",
  emptyNoHierarchy: "尚未配置组织层级。",
  zoomIn: "放大",
  zoomOut: "缩小",
  fitToScreen: "适应画布",
  fitToScreenAria: "将组织图适配到可见区域",
} as const;

export const issueFiltersPopoverUi = {
  buttonTooltip: "筛选",
  buttonTooltipActive: (n: number) => `筛选 · ${n} 项生效`,
  buttonLabelCompact: "筛选",
  heading: "筛选条件",
  clear: "清空",
  quickFilters: "快捷筛选",
  sectionStatus: "状态",
  sectionPriority: "优先级",
  sectionAssignee: "负责人",
  noAssignee: "未分配",
  assigneeMe: "自己",
  sectionCreator: "创建者",
  creatorsSearchPlaceholder: "搜索创建者…",
  creatorsNoMatch: "没有匹配的创建者。",
  sectionProject: "项目",
  sectionLabels: "标签",
  sectionWorkspace: "工作区",
  sectionVisibility: "可见性",
  liveOnlyRuns: "仅进行中的运行",
  hideRoutineRuns: "隐藏例行运行",
} as const;

export const issueBreadcrumb = {
  inbox: "收件箱",
  issues: "事务",
} as const;

export const issueFilters = {
  all: "全部",
  active: "活跃",
  backlog: "待整理",
  done: "已完成",
} as const;

export const mobileNav = {
  create: "新建",
  home: "主页",
  issues: "事务",
  agents: "智能体",
  inbox: "收件箱",
  ariaNav: "底部导航",
} as const;

export const runLedger = {
  sectionTitle: "运行账本",
  waitingFirst: "等待第一条运行记录。",
  noRunsLinked: "尚未关联运行。",
  latestRun: "最新运行",
  childWork: "子事务",
  activeDoneCancelled: (active: number, done: number, cancelled: number) =>
    `${active} 个进行中，${done} 已完成，${cancelled} 已取消`,
  allTerminal: (total: number, done: number, cancelled: number) =>
    `全部 ${total} 个已结束（${done} 完成，${cancelled} 取消）`,
  more: (n: number) => `另有 ${n} 个`,
  staleAlert: "停滞运行告警",
  silenceWarn: "输出静默监控",
  silentFor: "最近活跃运行已静默",
  extended: "较长时间",
  recoveryReview: "查看恢复上下文。",
  continueMonitoring: "继续监控",
  snooze1h: "推迟 1 小时",
  falsePositive: "标记误报",
  watchdogNotRecorded: "看门狗决策未记录",
  emptyHistory: "有历史后，运行与活动将显示在此。",
  emptyLegacy: "关联到该事务的历史运行将显示在此（即使无活跃度元数据）。",
  run: "运行",
  by: "由",
  live: "实时",
  exhausted: "已耗尽",
  continuationAttempt: (n: number) => `接续尝试 ${n}`,
  stopRetryPending: "重试等待中",
  stopQueued: "等待开始",
  stopRunning: "仍在运行",
  stopUnavailable: "不可用",
  stopNoReason: "无停止原因",
  waitingNextAttempt: "等待下一次尝试",
  noActionYet: "尚无动作记录",
  noConcreteAction: "无具体动作",
  noUsefulOutput: "无有效输出",
  noneRecorded: "无记录",
  underOneMinute: "不足 1 分钟",
  minutes: (n: number) => `${n} 分钟`,
  hours: (n: number) => `${n} 小时`,
  hoursMinutes: (h: number, m: number) => `${h} 小时 ${m} 分钟`,
  ariaSection: "事务运行账本",
  childSummaryActive: (active: number, done: number, cancelled: number) =>
    `${active} 个进行中，${done} 已完成，${cancelled} 已取消`,
  childSummaryTerminal: (total: number, done: number, cancelled: number) =>
    `全部 ${total} 个已结束（${done} 完成，${cancelled} 取消）`,
  moreChildren: (n: number) => `另有 ${n} 个`,
  watchdogStaleTitle: "停滞运行告警",
  watchdogSilenceTitle: "输出静默监控",
  silentForPrefix: "最近活跃运行已静默",
  silentExtended: "较长时间",
  reviewLinkForRecovery: "查看恢复上下文。",
  snoozeReasonLedger: "从事务运行账本推迟",
  dismissReasonLedger: "从事务运行账本标记误报",
  toastWatchdogFailed: "看门狗决策未记录",
  watchdog403: "仅董事会或指定的恢复责任人可记录看门狗决策。",
  watchdogGenericError: "无法记录看门狗决策。",
  emptyFeedWithActivity: "有历史后，运行与活动将显示在此。",
  emptyFeedLegacy: "关联到该事务的历史运行将显示在此（即使无活跃度元数据）。",
  runLabel: "运行",
  byAgent: "由",
  liveChip: "实时",
  exhaustedChip: "已耗尽",
  elapsed: "耗时",
  lastUsefulAction: "最近有效动作",
  stopColumn: "停止",
  unknownDuration: "未知",
  retryOfRun: "重试来源运行",
  nextActionPrefix: "下一步：",
  olderItemsHidden: (n: number) => `另有 ${n} 条较早记录未显示`,
  runningNowBy: (agent: string) => `${agent} 正在运行`,
  queuedFor: (agent: string) => `排队中：${agent}`,
  autoRetryScheduledFor: (agent: string) => `已为 ${agent} 安排自动重试`,
  genericStatusBy: (status: string, agent: string) => `${status} · ${agent}`,
  stopTimeout: (sec: string) => `超时（${sec}）`,
  stopTimeoutShort: "超时",
  stopMaxTurns: "已达最大轮次",
  stopBudgetPaused: "预算已暂停",
  stopCancelled: "已取消",
  stopPausedByBoard: "董事会暂停",
  stopProcessLost: "进程丢失",
  stopAdapterFailed: "适配器失败",
  stopCompleted: (time?: string) => (time ? `已完成（${time}）` : "已完成"),
  cheapFallbackPrimary: "Cheap 配置已回退到主模型",
  profileUnavailable: (name: string) => `${name} 配置不可用`,
  modelProfileLineRequested: (v: string) => `请求：${v}`,
  modelProfileLineApplied: (v: string) => `应用：${v}`,
  modelProfileLineSource: (v: string) => `来源：${v}`,
  modelProfileLineFallback: (v: string) => `回退：${v}`,
  durationSeconds: (s: number) => `${s} 秒`,
  durationMinutesSeconds: (m: number, s: number) => (s > 0 ? `${m} 分 ${s} 秒` : `${m} 分钟`),
  durationHours: (h: number) => `${h} 小时`,
  durationHoursMinutes: (h: number, m: number) =>
    m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`,
  modelProfileEqual: (r: string) => `模型：${r}`,
  modelProfileArrow: (a: string, b: string) => `模型：${a} → ${b}`,
  modelProfileUnavailable: (r: string) => `模型：${r}（不可用）`,
} as const;

/** Blocked state detail for StatusIcon (parity with former English helper). */
export function formatBlockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined): string {
  if (!blockerAttention || blockerAttention.state === "none") return "阻塞";

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return `阻塞 · 等待活跃子事务 ${blockerAttention.sampleBlockerIdentifier}`;
    }
    if (count === 1) return "阻塞 · 等待 1 个活跃子事务";
    return `阻塞 · 等待 ${count} 个活跃子事务`;
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return `阻塞 · 由活跃依赖 ${blockerAttention.sampleBlockerIdentifier} 覆盖`;
    }
    if (count === 1) return "阻塞 · 由 1 个活跃依赖覆盖";
    return `阻塞 · 由 ${count} 个活跃依赖覆盖`;
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf =
      blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return `阻塞 · 审查停滞于 ${leaf}`;
    if (count === 1) return "阻塞 · 审查停滞，缺少明确下一步";
    return `阻塞 · ${count} 项审查停滞，缺少明确下一步`;
  }

  if (blockerAttention.reason === "attention_required") {
    const count =
      blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const attentionCopy = `${count} 个阻塞项需要处理`;
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return `阻塞 · ${attentionCopy}；${coveredCount} 个已由活跃工作覆盖`;
    }
    return `阻塞 · ${attentionCopy}`;
  }

  return "阻塞";
}
