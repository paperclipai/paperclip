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
  issues: "事务清单",
  routines: "例行任务",
  heartbeatTasks: "心跳任务",
  orchestrationInjection: "运行清单",
  orchestrationGates: "编排闸门",
  goals: "公司目标",
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

export const heartbeatTasksPage = {
  title: "心跳任务",
  subtitle: "只读汇总当前团队里配置过心跳的智能体、关键心跳机制参数和最近运行状态。",
  selectCompany: "请选择团队查看心跳任务。",
  failedToLoad: "无法加载心跳任务。",
  enabledAgents: "已启用心跳",
  configuredAgents: "已配置心跳",
  liveRuns: "运行中",
  empty: "当前团队还没有配置过心跳的智能体。",
  agent: "智能体",
  state: "状态",
  interval: "间隔",
  cooldown: "冷却",
  concurrent: "并行",
  continuation: "接续等待 / 次数",
  lastHeartbeat: "上次心跳",
  lastRun: "最近运行",
  on: "开启",
  off: "关闭",
  never: "从未",
  running: (count: number) => `运行中 ${count}`,
  concurrencySemanticsFootnote:
    "并行上限常为 1。若评论/指派类等唤醒尚在排队或运行中，调度器触发的定时心跳会避让：不新增 timer run，写入 `agent_wakeup_requests` 一条 `skipped`（reason 含 heartbeat.timer_yield），并顺延界面上的「上次心跳」；与 **042** 的 `effectiveTrigger` 同看时间线更清楚。（工单 **043**）",
} as const;

/** 编排闸门页：只读说明控制面「工程自动化」有哪些闸门，与技能/提示词注入无关。 */
export const orchestrationGatesPage = {
  title: "编排闸门",
  subtitle:
    "用产品语言说明：系统在「定时巡检、有人互动、花钱/暂停、卡住恢复、自动开单」这些环节里，什么时候会动、动完会怎样；并收录 **API 心跳调度器** 里同一轮会跑的服务端编排（过去单独归在心跳里、没写进本表的那些）。不含智能体技能包、长文提示词拼装——那些请看「运行清单」对照单次运行。",
  selectCompany: "请选择团队查看编排闸门。",
  footnote:
    "具体数值与优先级以你当前运行的版本为准；升级或自建实例后可能微调。本页是说明书，不是实时监控大屏。",
  notInScope:
    "不包含：技能怎么打包、说明文档怎么拼进对话、一次运行实际喂给模型多长上下文——请用「运行清单」对照某次运行。",
  relatedHeartbeatTasks: "心跳任务（多久巡检、开不开）",
  relatedInjection: "运行清单（单次运行里上下文怎么拼的）",
  columnComponent: "调度组件",
  columnUi: "所属",
  columnConfigurable: "可配置项",
  columnHardcoded: "调度规则",
  columnCodeRef: "代码位置（可选）",
  expandSchedulingRules: "展开",
  collapseSchedulingRules: "收起",
  uiNone: "无单独页面",
  jumpHeartbeatTasks: "心跳任务",
  jumpCosts: "成本与预算",
  jumpAgents: "智能体列表",
  jumpOrchestrationInjection: "运行清单",
  jumpIssues: "事务清单",
  jumpInstanceExperimental: "实例实验设置",
} as const;

export type OrchestrationGatesTableRow = {
  id: string;
  component: string;
  uiLinks: ReadonlyArray<{ to: string; labelKey: keyof Pick<
    typeof orchestrationGatesPage,
    "jumpHeartbeatTasks" | "jumpCosts" | "jumpAgents" | "jumpOrchestrationInjection" | "jumpIssues" | "jumpInstanceExperimental"
  > }>;
  configurable: string;
  hardcoded: string;
  codeRef: string;
};

export const orchestrationGatesRows: ReadonlyArray<OrchestrationGatesTableRow> = [
  {
    id: "server-scheduler",
    component: "API 心跳调度",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "实例级：是否打开调度、整轮间隔多长（默认开、约每 30s 一轮，最短约 10s）；改部署后要重启。与「智能体心跳任务」页里每人自己的间隔是两层：这里管服务器多久跑一整轮，那里管某个经办多久巡检一次。具体变量名见代码位置。",
    hardcoded:
      "调度说明：服务端按固定周期拉起整链恢复，并决定每轮间隔。\n\n调度开启时：API 启动后先跑一轮，之后每到间隔再跑；每轮按序做孤儿回收、队列续跑、滞留对账、关系图、无输出、产出审查等，并与同一节拍上的定时唤醒、例行唤醒并行。\n\n调度关闭时：整链不再触发。\n\n触发：进程已起、调度为开，且每到一轮间隔。\n\n结果：各子项含义与顺序见本表后文；整链与两类唤醒在同一间隔内跑完。",
    codeRef: "server/index.ts · config HEARTBEAT_SCHEDULER_ENABLED · HEARTBEAT_SCHEDULER_INTERVAL_MS",
  },
  {
    id: "timer",
    component: "心跳避退",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "心跳任务页：每个智能体「隔多久巡检一次」「要不要开」。若由运维部署：可改「礼让之后推迟多久再测下一次」（默认约 2 分钟），用来让评论/指派触发的跑次先跑完。",
    hardcoded:
      "避退说明：定时巡检与互动唤醒错峰。\n\n发生避让时：同一智能体若已有留言、指派等来源的跑次在排队或运行，定时这一轮不插队：不多开一轮纯定时跑，界面「上次心跳」会后移；运行清单可核对是否记录跳过。\n\n无事可领时：没有可领用的当事事务时，定时巡检也不会空转多排队。\n\n触发：到达心跳任务节奏；且要么没有可巡检领用的事务，要么仍有其他来源跑次未结束。\n\n结果：通常不新增一轮纯定时跑次，或把下次定时后推，并尽量留下可追溯说明。",
    codeRef: "orchestration-invariants · heartbeat-timer-yield · heartbeat",
  },
  {
    id: "heartbeat-tick-timers",
    component: "定时到点",
    uiLinks: [{ to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" }],
    configurable:
      "节拍由「API 心跳调度」统一牵引；单次具体行为在智能体/事务策略里。不在本页改数值。",
    hardcoded:
      "定时到点说明：登记过的定时器一到点，就把对应唤醒排进执行队列。\n\n与「例行计划到点」同节拍：同一套心跳节拍里，先处理到期定时器，再接例行计划触发，然后进入整段服务器恢复链。\n\n触发：每到一轮调度间隔，且定时器队列里有到期项。\n\n结果：到期唤醒进入执行队列（仍过预算、暂停等闸门）。",
    codeRef: "server/index.ts setInterval · heartbeat.tickTimers · routines.tickScheduledTriggers",
  },
  {
    id: "routine-tick-scheduled",
    component: "例行计划到点",
    uiLinks: [{ to: "/issues", labelKey: "jumpIssues" }],
    configurable: "具体触发条件在例行/自动化配置里（若版本已露出）；时钟仍依赖实例级调度开关与间隔。",
    hardcoded:
      "例行计划到点说明：例行里配置的周期/定时到了，就按例行规则入队。\n\n与「定时到点」同节拍，但走例行事务管线，不走心跳里那条业务恢复子链。\n\n触发：每到一轮调度间隔，且例行侧有待触发项。\n\n结果：按例行定义排队运行或产生唤醒（细节以实现为准）。",
    codeRef: "routineService.tickScheduledTriggers · server/index.ts",
  },
  {
    id: "orphan-reap",
    component: "孤儿运行回收",
    uiLinks: [{ to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "周期性扫描可带「多久算陈旧」阈值（默认约 5 分钟，以当前实现为准）；属服务端内部策略，看板无单独页。",
    hardcoded:
      "孤儿运行回收说明：进程已经不在或状态和真实不一致时，把仍标成进行中的跑次收干净。\n\n调度开着时：启动先收一轮，之后每个间隔再收。避免界面、成本和真实进程脱节。\n\n触发：API 启动后首轮及之后每个调度间隔。\n\n结果：终止或修正孤儿跑次，后面的续跑、滞留对账在更干净的状态上跑。",
    codeRef: "heartbeat.reapOrphanedRuns",
  },
  {
    id: "promote-scheduled-retries",
    component: "重试提升",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "单次运行上的「计划重试」时刻多在运行/事务相关界面或记录里；全实例批量扫描节奏与「API 心跳调度」间隔一致。",
    hardcoded:
      "提升说明：到了预约重试点、仍处于「计划重试」状态的跑次，按轮从库里捞出并升阶；每轮条数上限以实现为准。\n\n触发：每个调度间隔内，紧挨孤儿回收之后、队列续跑之前。\n\n结果：到期重试进入可推进状态，与「预约重试」里「到点再跑」的约定衔接。",
    codeRef: "heartbeat.promoteDueScheduledRetries",
  },
  {
    id: "resume-queued-runs",
    component: "队列续跑",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "仍显示为「排队」的跑次表示已持久化落库；无单独总开关，跟随「API 心跳调度」轮询。",
    hardcoded:
      "续跑说明：仍处在排队里的跑次会先按智能体归并，再逐个尝试「启动该智能体的下一条排队跑次」；用在进程重启或切换之后，把上一进程留在库里的排队接着往前推。\n\n触发：每个调度间隔内，紧跟重试提升之后、滞留对账等之前；若提升步骤抛错，本轮续跑不会执行。\n\n结果：各智能体名下排队跑次有机会被拉起（仍过预算、暂停等闸门）。",
    codeRef: "heartbeat.resumeQueuedRuns · startNextQueuedRunForAgent",
  },
  {
    id: "stranded-wake-requeue",
    component: "滞留补救",
    uiLinks: [{ to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "团队、事务上的档位与预算仍适用。实例可单独关掉「自动建滞留回收子单」（通常只影响是否生成子单，不等同于整段滞留对账都停）；具体变量名见代码位置。本行的补派、唤醒多数仍会跑，除非协作树上有暂停类抑制。",
    hardcoded:
      "滞留补救说明：事务已分给经办，但当下没有健康执行路径时：先补唤醒、补派（含初次派活或续跑），不先走「滞留回收」子单。\n\n对账会在一批仍分给经办、事务尚在待办或进行中、且当下看不到排队或运行中路径等情况里找机会；需要时入滞留补救或初次派活队列。多轮仍拉不通，才会升高到阻塞并可能生成子单。\n\n触发：每轮调度里，重试提升与队列续跑之后。\n\n结果：经办多一次（或策略允许多次）自动唤醒；仍失败就看下行「滞留回收」。",
    codeRef: "recovery/reconcileStrandedAssignedIssues · enqueueStrandedIssueRecovery · enqueueInitialAssignedTodoDispatch · PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED",
  },
  {
    id: "issue-graph-liveness-reconcile",
    component: "关系图活性对账",
    uiLinks: [{ to: "/instance/settings/experimental", labelKey: "jumpInstanceExperimental" }],
    configurable:
      "实例设置 · 实验：是否启用自动恢复、回溯小时数（默认约一天，以页面为准）。",
    hardcoded:
      "关系图活性对账说明：依赖/阻塞关系长期不健康时，按实验设定自动恢复或开单。\n\n与滞留对账不同：盯的是图结构和升级类异常，不是「单条分派跑不通」。可与滞留链在同一轮里先后执行。\n\n触发：每轮调度（含启动首轮）且实验打开、回溯窗口内有命中项。\n\n结果：可能新建升级类事务并叫醒负责人，或沿用已有升级单。",
    codeRef: "heartbeat.reconcileIssueGraphLiveness · recovery/issue-graph-liveness",
  },
  {
    id: "silent-active-run-watchdog",
    component: "活跃无输出盯梢",
    uiLinks: [{ to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" }],
    configurable: "阈值（约 1h / 4h 等）写在实现里，本页不暴露滑块；若将来实例级可配会出现在设置。",
    hardcoded:
      "活跃无输出盯梢说明：跑次长时间卡在活跃却几乎没控制台输出时，分级怀疑，并可能开复查单或留评论。\n\n与「心跳避退」不是一回事：这里盯的是输出静默，并对同类提醒去重。\n\n触发：每轮调度内，扫描正在跑且命中静默规则的心跳跑次。\n\n结果：可能创建或挂上「活跃无输出复核」类工单并叫醒；细节见活动日志。",
    codeRef: "recovery/scanSilentActiveRuns · heartbeat",
  },
  {
    id: "bare-wake",
    component: "无单不叫",
    uiLinks: [{ to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" }],
    configurable: "没有单独总开关；一次叫醒必须能落到具体事务上，否则系统不认。",
    hardcoded:
      "无单不叫说明：说不清是哪张单就不叫醒；台账和界面要一致。\n\n拒绝「只有一句话、但绑不上任何事务」的即时叫醒，以免智能体在真空中瞎跑。若事务已经关了，仍有一条显示「进行中」的运行，会自动收尾并修正占用，避免界面和成本看上去不对。\n\n触发：外部只丢了说明却指不到某条事务；或事务已结束仍挂着进行中的运行。\n\n结果：不进入执行队列；或取消那次无效运行并把状态纠正回来。",
    codeRef: "orchestration-invariants · heartbeat",
  },
  {
    id: "event-wake",
    component: "互动叫醒",
    uiLinks: [
      { to: "/issues", labelKey: "jumpIssues" },
      { to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" },
    ],
    configurable:
      "可按事务调「评论叫醒要带多少上下文」（档位）；未设则用团队默认值。若当前界面没有该字段，只能走接口或等后续版本露出。",
    hardcoded:
      "互动叫醒说明：你在事务上一动，就叫醒经办人（同类会合并）。\n\n同一次保存里，对同一经办、同一张单的多重叫醒会合成一次，避免连续刷屏跑。评论特别长或点名很多时，会按档位做压缩再叫醒，减轻噪声和费用。\n\n触发：留言、改指派、签出、推进执行阶段等你日常在事务里做的操作。\n\n结果：一般只触发一轮叫醒，经办智能体可能带着压过的评论摘要继续干活。",
    codeRef: "routes/issues · comment-wake-tier",
  },
  {
    id: "budget",
    component: "预算暂停",
    uiLinks: [
      { to: "/costs", labelKey: "jumpCosts" },
      { to: "/agents", labelKey: "jumpAgents" },
    ],
    configurable: "成本页里公司 / 智能体 / 事务相关的额度与周期；智能体列表里可暂停某个智能体。",
    hardcoded:
      "预算暂停说明：钱不够或点了暂停，就先别跑（含个别智能体暂停）。\n\n系统按既定顺序检查「是否超支、是否暂停」等门槛，再决定能不能跑。\n\n触发：每一次「新的一次运行要排队」或「接着跑」之前。\n\n结果：直接拦住，并标明预算不足或已暂停等原因；运行记录里能看到对应说法。",
    codeRef: "budgets · heartbeat",
  },
  {
    id: "recovery",
    component: "协作树护栏",
    uiLinks: [{ to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" }],
    configurable:
      "若实例对人因暂停、未复机等有抑制策略，以活动日志与当前版本为准。",
    hardcoded:
      "协作树护栏说明：协作树上有暂停类抑制时，别在不该自动救济时把阻塞链越拖越长。\n\n任何自动恢复进来前，都会先看树上是否挂着人因暂停、未复机一类抑制（与滞留、关系图等子项配套）。不等同于「关系图不健康」那一行。\n\n触发：要带自动救济的后台路径碰到该事务或其子树之前。\n\n结果：可能不再自动追加叫醒、阻塞边或回收子单，避免同一问题叠好几层。",
    codeRef: "recovery/pause-hold-guard · isAutomaticRecoverySuppressedByPauseHold",
  },
  {
    id: "stranded-recovery",
    component: "滞留回收",
    uiLinks: [
      { to: "/issues", labelKey: "jumpIssues" },
      { to: "/orchestration-injection", labelKey: "jumpOrchestrationInjection" },
    ],
    configurable:
      "与「滞留补救」同一套：树上的暂停、预算、以及「是否自动建滞留回收子单」的实例开关都还在；最后一项往往只关建子单，不一定整段对账都停。变量名见代码位置。",
    hardcoded:
      "滞留回收说明：源单已分给经办却长期跑不通时，伸一张子单给管理人收场。\n\n同一源单通常只留一张进行中的滞留回收子单；已是回收子单的不再套娃。管理人在候选链里挑。跑完仍缺下一步时，也可能再走同类收尾单（标题里常会写出缺哪一步）。\n\n触发：滞留补救几轮仍拉不通、握手或续跑用尽等分支命中时；与同轮入队阶段相邻。\n\n结果：新建子事务指派给管理人并叫醒；源单可标成阻塞。本步之前的自动叫醒见上行「滞留补救」。",
    codeRef: "recovery/service · reconcileStrandedAssignedIssues · ensureStrandedIssueRecoveryIssue · PAPERCLIP_STRANDED_ISSUE_RECOVERY_ENABLED",
  },
  {
    id: "productivity",
    component: "产出纠偏",
    uiLinks: [],
    configurable: "当前看板没有单独设置页，门槛写在产品里；将来若做成可配，会出现在实例或团队级设置。",
    hardcoded:
      "产出纠偏说明：觉得产出不对劲，自动开审查单让你拍板。\n\n例如：连着多轮跑完却一直没人回评论、单次拖得太久、改动过于频繁等；并且通常在 24 小时内同类自动开单有次数上限，避免单子雪崩。\n\n触发：与「关系图活性」「活跃无输出」等同在一轮调度尾部执行；命中产出或节奏异常模式时。\n\n结果：生成供你人工判断的审查类事务（与滞留回收单不是同一条链：这里是产出或节奏异常触发的审查），而不是默默替你改业务结论。",
    codeRef: "heartbeat.reconcileProductivityReviews · productivity-review",
  },
  {
    id: "monitor",
    component: "执行盯梢",
    uiLinks: [{ to: "/issues", labelKey: "jumpIssues" }],
    configurable: "在事务侧维护「下一次何时再检查」（若详情或策略界面、接口有暴露）。若策略允许 **到期新建可见恢复单**，在同一事务或活动日志里能看到对应记录。",
    hardcoded:
      "执行盯梢说明：到点再查一眼（执行监控）。\n\n系统自动维护节奏，并让同类自动动作可区分、不重复刷同一件事。监控耗尽、超时等且策略为「建恢复单」时，会新开一张供人收场的事务（与「滞留回收」成因不同：这里偏执行阶段约定）。\n\n触发：到了你（或策略）定的「下一次检查」时刻，或你在界面里点「马上再查」（若有）。\n\n结果：叫醒经办按约定往下跑；或按策略结束监控。若配置为新建恢复单，你会多一张待处理事务（可在活动里搜监控恢复相关动作）。",
    codeRef: "issue-execution-policy · heartbeat",
  },
  {
    id: "retry",
    component: "预约重试",
    uiLinks: [
      { to: "/heartbeat-tasks", labelKey: "jumpHeartbeatTasks" },
      { to: "/issues", labelKey: "jumpIssues" },
    ],
    configurable:
      "某次运行上可以约定「几点再试」「为什么再试」；部分界面在事务里能看或改「计划重试」（视版本）。",
    hardcoded:
      "预约重试说明：约好的重试时间到了，或系统发现该补一手。\n\n后台按固定节奏扫到期的重试；失败原因有一套固定说法。服务端批量先做「重试提升」再做「队列续跑」（见上文两行），与此处用户可见的预约互为补充。\n\n触发：到了预约时间；或需要补偿的情况（例如该落的评论没落下、进程异常退出等）。\n\n结果：重新排队再跑一轮；仍然要先过预算和暂停两关。",
    codeRef: "heartbeat",
  },
];

export const orchestrationInjectionPage = {
  title: "运行清单",
  runDetailTitle: "运行详情",
  detailTabEnqueue: "唤起入队",
  detailTabInput: "输入编排",
  detailTabExecution: "执行回传",
  detailTabRecord: "运行记录",
  detailTabEnqueueIntro:
    "本栏说明「入执行队列之前」的门控与排队语义。当前条目对应的一次运行**已经落库**，历史上若在入队前曾被预算、审批等拦截，需结合活动日志或实例策略查看。下列入口可对照调度与闸门说明。",
  detailTabLinkGates: "编排闸门",
  detailTabLinkHeartbeatTasks: "心跳任务",
  executionPromptCrossRef: "完整提示词拼装、分块与控制面指标见「输入编排」标签。",
  backToList: "返回运行列表",
  runNotFound: "未找到该运行，可能已清理或不属于当前团队。",
  subtitle: "对照最近运行：看调度上下文、唤醒载荷与适配器提示词如何拼装，和事务侧现象是否对得上。",
  selectCompany: "请选择团队查看运行清单。",
  failedToLoad: "无法加载运行清单数据。",
  empty: "当前团队还没有可查看的运行记录。",
  recentRuns: "最近运行",
  runTableTitle: "运行列表",
  runTableColId: "运行 ID",
  runTableColAgent: "智能体",
  runTableColStatus: "状态",
  runTableColSource: "来源",
  runTableColCreated: "创建时间",
  runTableColSummary: "摘要",
  filterAgent: "智能体",
  filterStatus: "状态",
  filterSource: "来源",
  filterAll: "全部",
  paginationTotal: (n: number) => `共 ${n.toLocaleString()} 条`,
  paginationPage: (page: number, totalPages: number) => `第 ${page} / ${totalPages} 页`,
  prevPage: "上一页",
  nextPage: "下一页",
  pageSizeLabel: "每页",
  pageSizeOption: (n: number) => `${n} 条`,
  emptyFiltered: "没有符合当前筛选条件的运行记录。",
  runStatusDisplay: {
    queued: "排队",
    scheduled_retry: "预约重试",
    running: "运行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
    timed_out: "超时",
  } as const,
  run: "运行",
  runRowIdLabel: "运行 ID",
  copyRunCardAria: "复制运行卡片全文",
  runDetailAgentRunMirror: "与智能体运行页一致",
  runDetailAgentRunMirrorHint:
    "下列区块与「智能体 → 智能体运行」标签内右侧展开一致：运行摘要、用量、会话、关联事务与完整运行记录。",
  openInAgentRuns: "在智能体运行中打开",
  runDetailAgentMissing: "当前团队暂无该智能体元数据，无法渲染完整运行面板；请确认公司上下文与智能体列表已加载。",
  copyContextSnapshotCardAria: "复制运行快照全文",
  copyWakePayloadCardAria: "复制唤醒载荷全文",
  agent: "智能体",
  status: "状态",
  source: "来源",
  startedAt: "开始时间",
  createdAt: "创建时间",
  promptUnavailable: "这次运行没有上报最终提示词。适配器可能不是提示词型运行，或运行发生在该事件记录之前。",
  eventUnavailable: "这次运行没有 adapter.invoke 事件。",
  promptCombinationHint:
    "以下为控制面拼装块（折叠展示）；块顺序及内容与上报的整块最终提示词一致。仅在 adapter.invoke 携带 promptSections 时显示分块。",
  promptCacheCorrelationTitle: "提示词与缓存对齐（invoke 语义）",
  promptCacheModeCold: "冷启动：stdin 按拼装块完整下发；模型侧 token 缓存是否命中以计费/用量回执为准。",
  promptCacheModeResumed: "续会话：此前缀多由模型或 CLI 会话承接；下列块本次未再随 stdin 下发（不等同于 KV 命中计数）。",
  promptCacheStabilityKeyLabel: "稳定键（materialization）",
  promptCacheSuppressedLabel: "本轮 stdin 省略的拼装块",
  promptSectionTitles: {
    agent_instructions: "智能体说明（instructions）",
    bootstrap: "首轮引导（bootstrap）",
    wake: "唤醒上下文",
    session_handoff: "会话交接",
    task_context: "事务 / 任务上下文",
    heartbeat_template: "心跳模板渲染",
    codex_fallback_handoff: "Codex 交接回退",
    runtime_env_note: "运行时环境提示",
    api_access_note: "API 访问提示",
    skill_note: "Skill 备忘",
    skill_instructions: "Skill 拼装说明",
    system_append: "系统提示附加（Pi）",
  } as const satisfies Record<string, string>,
  finalPrompt: "最终提示词",
  copyFinalPrompt: "复制",
  copyFinalPromptDone: "已复制",
  copyFinalPromptAria: "复制完整最终提示词",
  copyFinalPromptFailedTitle: "复制失败",
  copyFinalPromptFailedBody: "浏览器未允许访问剪贴板，或页面不在安全上下文中。",
  copyPromptSectionAria: (sectionTitle: string) => `复制：${sectionTitle}`,
  copyAdapterInvocationCardAria: "复制适配器调用卡片全文",
  promptParagraphFallbackHint:
    "本次运行未上报控制面分块。下面按连续空行（双换行）切成多段，便于逐段复制；分段边界不一定等于服务端真实组件，仅作辅助。",
  promptParagraphLabel: (n: number) => `段落 ${n}`,
  promptMetrics: "提示词指标",
  adapterInvocation: "适配器调用",
  contextSnapshot: "运行快照",
  wakePayload: "唤醒载荷",
  wakeAttributionTitle: "唤起归因",
  wakeAttributionWinningLabel: "合并后认账的触发",
  wakeAttributionAbsorbedTitle: "被合并吸收的其他触发",
  wakeAttributionFallbackHint:
    "本条运行尚未写入合并归因（常见于未发生多源合并）。请以列表中的来源与摘要、以及下方完整运行快照为准。",
  wakeAttributionTriggerDetailLabel: "补充说明",
  wakeAttributionLastMergeLabel: "最后一次合并时间",
  wakeAttributionAbsorbedAtLabel: "吸收时间",
  wakeAttributionSourceLabels: {
    timer: "定时",
    assignment: "分配",
    on_demand: "按需",
    automation: "自动化",
  } as const,
  wakeReasonLabels: {
    issue_commented: "评论叫醒",
    issue_reopened_via_comment: "评论后重新打开",
    issue_comment_mentioned: "评论中 @ 提到",
    heartbeat_timer: "心跳定时",
    issue_assigned: "分配交办",
    issue_execution_same_name: "同链执行合并",
  } as const,
  commandNotes: "调用说明",
  command: "命令",
  cwd: "工作目录",
  adapterType: "适配器",
  noSelection: "选择一条运行查看详情。",
  noData: "无",
  chars: (count: number) => `${count.toLocaleString()} 字符`,
} as const;

/** 项目详情页（`/projects/:id`）右侧主内容区 */
export const projectDetailUi = {
  tabIssues: "事务清单",
  tabOverview: "概览",
  tabPluginOperations: "插件操作",
  tabWorkspaces: "工作区",
  tabConfiguration: "配置",
  tabBudget: "预算",
  addDescriptionPlaceholder: "添加描述…",
  status: "状态",
  targetDate: "目标日期",
  changeProjectColorAria: "更改项目颜色",
  selectColorAria: (color: string) => `选择颜色 ${color}`,
  pausedByBudgetHardStop: "因预算熔断已暂停",
  managedByPlugin: (pluginDisplayName: string) => `由 ${pluginDisplayName} 托管`,
  loadingWorkspaces: "正在加载工作区…",
  toastArchived: (name: string) => `「${name}」已归档`,
  toastUnarchived: (name: string) => `「${name}」已取消归档`,
  toastArchiveFailed: "归档项目失败",
  toastUnarchiveFailed: "取消归档失败",
  fallbackProjectName: "项目",
  breadcrumbProjects: "项目列表",
} as const;

export const projectPropertiesUi = {
  saving: "保存中",
  saved: "已保存",
  failed: "失败",
  statusBacklog: "待排期",
  statusPlanned: "已计划",
  statusInProgress: "进行中",
  statusCompleted: "已完成",
  statusCancelled: "已取消",
  fieldName: "名称",
  fieldDescription: "描述",
  projectNamePlaceholder: "项目名称",
  addDescriptionPlaceholder: "添加描述…",
  noDescription: "暂无描述",
  fieldStatus: "状态",
  fieldLead: "负责人",
  fieldGoals: "目标",
  addGoalButton: "添加目标",
  allGoalsLinked: "已全部关联目标。",
  removeGoalAria: (title: string) => `移除目标 ${title}`,
  fieldEnv: "环境变量",
  envHint:
    "应用于本项目内事务的全部运行；与智能体环境变量重键时，以项目值为准。",
  fieldCreated: "创建时间",
  fieldUpdated: "更新时间",
  fieldTargetDate: "目标日期",
  codebase: "代码库",
  codebaseHelpAria: "代码库说明",
  codebaseTooltip:
    "仓库标识权威来源；本地目录为智能体默认写入代码的位置。",
  repoEyebrow: "仓库",
  localFolderEyebrow: "本地目录",
  notSet: "未设置。",
  changeRepo: "更改仓库",
  setRepo: "设置仓库",
  clearRepoAria: "清除仓库",
  paperclipManagedFolder: "由 Paperclip 管理的目录。",
  changeLocalFolder: "更改本地目录",
  setLocalFolder: "设置本地目录",
  clearLocalFolderAria: "清除本地目录",
  legacyWorkspacesNote:
    "该项目还存在额外的历史工作区记录；代码库视图以主工作区为准。",
  noUrl: "无 URL",
  save: "保存",
  cancel: "取消",
  errLocalFolderAbsolute: "本地目录须为完整绝对路径。",
  errRepoUrlGithub: "须使用有效的 GitHub 或 GitHub Enterprise 仓库 URL。",
  confirmClearLocalFromWorkspace: "从本工作区清除本地目录？",
  confirmDeleteWorkspaceLocal: "删除本工作区的本地目录？",
  confirmClearRepoFromWorkspace: "从本工作区清除仓库？",
  confirmDeleteWorkspaceRepo: "删除本工作区的仓库？",
  errSaveWorkspace: "保存工作区失败。",
  errDeleteWorkspace: "删除工作区失败。",
  errUpdateWorkspace: "更新工作区失败。",
  executionWorkspaces: "执行工作区",
  executionWorkspacesHelpAria: "执行工作区说明",
  executionWorkspacesTooltip:
    "项目级默认：隔离检出与执行工作区行为。",
  enableIsolatedCheckouts: "启用隔离事务检出",
  enableIsolatedCheckoutsHint:
    "允许事务在「项目主检出」与「隔离执行工作区」之间选择。",
  enabled: "已开启",
  disabled: "已关闭",
  newIssuesDefaultIsolated: "新建事务默认使用隔离检出",
  newIssuesDefaultIsolatedHint:
    "关闭后，新建事务默认留在项目主检出上，除非手动选择隔离。",
  showAdvancedCheckout: "显示高级检出设置",
  hideAdvancedCheckout: "隐藏高级检出设置",
  hostManagedImplementationPrefix: "托管实现：",
  fieldEnvironment: "运行环境",
  noEnvironmentOption: "未选环境",
  fieldBaseRef: "基准引用",
  fieldBranchTemplate: "分支模板",
  fieldWorktreeParentDir: "工作树父目录",
  fieldProvisionCommand: "预置命令",
  fieldTeardownCommand: "拆除命令",
  provisionTeardownFootnote:
    "预置在派生工作树内、智能体执行前运行；拆除命令预留给后续清理流程。",
  dangerZone: "危险操作",
  archiveBlurb: "归档后将从侧栏与项目选择器中隐藏。",
  unarchiveBlurb: "取消归档后将恢复到侧栏与项目选择器。",
  archiveverb: "归档",
  unarchiveverb: "取消归档",
  archiving: "正在归档…",
  unarchiving: "正在取消归档…",
  confirm: "确认",
  cancelverb: "取消",
  archiveProject: "归档项目",
  unarchiveProject: "取消归档项目",
  archiveConfirmPrompt: (verb: string, name: string) => `${verb}「${name}」？`,
  selectCompanyForSecrets: "请先选择团队后再创建密钥",
  localPathPlaceholder: "/absolute/path/to/workspace",
  repoUrlPlaceholder: "https://github.com/org/repo",
} as const;

export const projectWorkspacesUi = {
  empty: "尚无需要展示的非默认工作区活动。",
  cleanupAttention: "需要处理清理问题",
} as const;

export const projectWorkspaceCardUi = {
  kindExecution: "执行工作区",
  kindProject: "项目工作区",
  updatedPrefix: "更新于",
  servicesCount: (running: number, total: number) => `${running}/${total} 个服务`,
  stopServices: "停止服务",
  startServices: "启动服务",
  retryClose: "重试关闭",
  closeWorkspace: "关闭工作区",
  branchEyebrow: "分支",
  pathEyebrow: "路径",
  serviceEyebrow: "服务",
  linkedIssues: "关联事务",
  moreLinked: (n: number) => `+ 还有 ${n} 个`,
  branchCopied: "已复制分支",
  pathCopied: "已复制路径",
  copyBranchAria: "复制分支",
  copyPathAria: "复制路径",
} as const;

export const executionWorkspaceCloseUi = {
  closeWorkspace: "关闭工作区",
  retryClose: "重试关闭",
  descriptionIntro: (name: string) =>
    `将「${name}」归档并清理其拥有的工作区产物。Paperclip 会保留工作区记录与事务历史，但从活跃工作区视图中移除。`,
  checkingSafe: "正在检查该工作区是否可以安全关闭…",
  inspectFailed: "无法检查关闭就绪状态。",
  stateBlocked: "当前无法关闭",
  stateReadyWithWarnings: "存在告警，但允许关闭",
  stateReady: "可以关闭",
  hintSharedSession:
    "这是共享工作区会话。归档后仅移除该会话记录，底层项目工作区仍保留。",
  hintOwnCheckout:
    "该执行工作区有独立检出路径，可单独归档。",
  hintProjectPrimary:
    "该执行工作区当前指向项目主工作区路径。",
  hintDisposable: "该工作区可丢弃并可归档。",
  blockingIssues: "阻塞事务",
  blockingReasons: "阻塞原因",
  warnings: "警告",
  gitStatus: "Git 状态",
  gitBranch: "分支",
  gitBaseRefLabel: "基准引用",
  unknown: "未知",
  notSet: "未设置",
  mergedIntoBase: "已合并进基准",
  yes: "是",
  no: "否",
  aheadBehind: "领先 / 落后",
  dirtyTrackedFiles: "已跟踪文件的未提交变更",
  untrackedFiles: "未跟踪文件",
  otherLinkedIssues: "其他关联事务",
  attachedRuntimeServices: "已挂运行时服务",
  noAdditionalDetails: "无更多详情",
  cleanupActions: "清理操作",
  cleanupFailedBlurb:
    "该工作区上次清理失败。重试关闭将重新执行清理流程并在成功时更新状态。",
  alreadyArchived: "该工作区已归档。",
  repoRootLabel: "仓库根目录：",
  workspacePathLabel: "工作区路径：",
  lastChecked: (when: string) => `上次检查：${when}`,
  cancel: "取消",
  toastCloseRetried: "已重试关闭工作区",
  toastClosed: "工作区已关闭",
  toastCloseFailed: "关闭工作区失败",
  unknownError: "未知错误",
} as const;

const PROJECT_PROPERTY_STATUS_LABELS: Record<string, string> = {
  backlog: projectPropertiesUi.statusBacklog,
  planned: projectPropertiesUi.statusPlanned,
  in_progress: projectPropertiesUi.statusInProgress,
  completed: projectPropertiesUi.statusCompleted,
  cancelled: projectPropertiesUi.statusCancelled,
};

export function formatProjectPropertyStatusLabel(status: string): string {
  return PROJECT_PROPERTY_STATUS_LABELS[status] ?? status.replace(/_/g, " ");
}

const EXECUTION_WORKSPACE_STATUS_ZH: Record<string, string> = {
  active: "活跃",
  idle: "空闲",
  in_review: "审阅中",
  archived: "已归档",
  cleanup_failed: "清理失败",
};

export function formatExecutionWorkspaceStatusZh(status: string): string {
  return EXECUTION_WORKSPACE_STATUS_ZH[status] ?? status.replace(/_/g, " ");
}

const WORKSPACE_RUNTIME_SERVICE_STATUS_ZH: Record<string, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  failed: "失败",
};

export function formatWorkspaceRuntimeServiceStatusZh(status: string): string {
  return WORKSPACE_RUNTIME_SERVICE_STATUS_ZH[status] ?? status;
}

const WORKSPACE_RUNTIME_LIFECYCLE_ZH: Record<string, string> = {
  shared: "共享",
  ephemeral: "临时",
};

export function formatWorkspaceRuntimeLifecycleZh(lifecycle: string): string {
  return WORKSPACE_RUNTIME_LIFECYCLE_ZH[lifecycle] ?? lifecycle;
}

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
  nextUp: "下一个",
  waitingBlockers: "等待阻塞解除",
  board: "看板",
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
  needsNextTitle: "该事务需要下一步操作",
  searchAssignees: "搜索经办人…",
  loadingMore: "加载更多事务…",
  scrollLoad: "滚动加载更多",
  subIssuesProgressAria: "子事务完成进度",
  noActiveSubIssues: "无活跃子事务",
  allSubIssuesDone: "子事务均已完成",
  noActionableSubIssues: "无可执行的子事务",
  assignee: "经办人",
  noAssignee: "无经办人",
  subTaskCount: (n: number) => `（${n} 个子事务）`,
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
  liveNow: "运行中",
  startedPrefix: " · 始于",
  finishedPrefix: " · 完成于",
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
  versionPrefix: "回形针 v",
} as const;

export const agentDetailUi = {
  invocation: "调用",
  // AgentProperties labels
  propStatus: "状态",
  propRole: "角色",
  propTitle: "职位",
  propAdapter: "适配器",
  propSession: "会话",
  propLastError: "最后错误",
  propLastHeartbeat: "最后心跳",
  propReportsTo: "汇报上级",
  propCreated: "创建时间",
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
  worktreePath: "工作树路径",
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
  stderrHeading: "标准错误",
  stdoutHeading: "标准输出",
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
  terminateAgent: "删除智能体",
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
  maxConcurrentRuns:
    "该智能体在任意时刻可同时存在的运行个数上限。当前产品与 SPEC 将把该值夹在 1。评论/指派/按需等较重的唤醒与定时心跳并排时：若已有较重运行处于排队或运行中，定时心跳会先退让（不产生新的 timer run，顺延下次触发时间）；与 **042** `effectiveTrigger` 优先级一起看时间线更清晰。",
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

// ——— 成本页 `/costs` ———

export const costsUi = {
  pageTitle: "成本",
  pageSubtitle: "推理支出、平台费用、额度与实时订阅配额视图。",
  emptySelectCompany: "请选择公司以查看成本。",
  customRangeTo: "至",

  metricInferenceSpend: "推理支出",
  inferenceSpendSubtitle: (formattedTokens: string) =>
    `${formattedTokens}（笔请求范围内事件的 Token 合计）`,

  metricBudget: "预算",
  budgetMetricOpen: "正常",
  budgetPausedSubtitle: (agents: number, projects: number) =>
    `${agents} 个智能体已暂停 · ${projects} 个项目已暂停`,
  budgetUtilSubtitle: (spend: string, cap: string) => `${spend} / ${cap}（占月度上限）`,
  budgetNoMonthlyCap: "未配置月度上限",

  metricFinanceNet: "账务净额",
  financeNetSubtitle: (debits: string, credits: string) => `借方 ${debits} · 贷方 ${credits}`,

  metricFinanceEvents: "账务事件",
  financeEventsSubtitle: (estimated: string) => `范围内预估 ${estimated}`,

  tabOverview: "概览",
  tabBudgets: "预算",
  tabProviders: "供应商",
  tabBillers: "计费方",
  tabFinance: "账务",

  selectDatesToLoad: "请选择起止日期以加载数据。",

  inferenceLedgerTitle: "推理台账",
  inferenceLedgerDescription: "所选时间范围内、按请求计量的推理支出。",
  budgetLine: (amount: string) => `预算 ${amount}`,
  unlimitedBudget: "无预算上限",
  usageEyebrow: "用量",
  monthlyBudgetConsumedPct: (pct: number) => `本范围内已用月度预算的 ${pct}%。`,

  byAgentTitle: "按智能体",
  byAgentDescription: "各智能体在所选周期内的消耗。",
  noCostEvents: "尚无成本事件。",
  tokInOut: (inn: string, out: string) => `入 ${inn} · 出 ${out}`,
  runCountApi: (n: number) => (n > 0 ? `${n} 次 API` : "0 次 API"),
  runCountSubscription: (n: number) => (n > 0 ? `${n} 次订阅` : "0 次订阅"),
  modelRowTokLabel: (formatted: string) => `${formatted} Token`,

  byProjectTitle: "按项目",
  byProjectDescription: "通过关联项目的事务归集的运次成本。",
  noProjectAttributedCosts: "尚无可归集到项目的运次成本。",
  unattributed: "未归属",

  financeTimelineEmptyCostsOverview:
    "尚无账务事件。计费方发票或贷项入账后，将显示账户级费用。",

  budgetControlPlaneTitle: "预算控制面",
  budgetControlPlaneDescription:
    "针对智能体与项目的硬停支出上限。供应商订阅配额另行展示，见「供应商」Tab。",

  metricActiveIncidents: "活跃事件",
  activeIncidentsSubtitle: "软/硬阈值已触发（待处理）",
  metricPendingApprovals: "待审批",
  pendingApprovalsSubtitle: "预算覆盖申请待看板处理",
  metricPausedAgents: "已暂停智能体",
  pausedAgentsSubtitle: "因预算已阻断智能体心跳",
  metricPausedProjects: "已暂停项目",
  pausedProjectsSubtitle: "因预算已阻断项目执行",

  activeIncidentsHeading: "活跃事件",
  activeIncidentsHint: "在此提高预算或明确保持暂停以处理硬停。",

  scopeBudgetDescription: {
    company: "全公司月度策略。",
    agent: "各智能体的循环月度支出策略。",
    project: "与执行绑定的项目的生命周期支出策略。",
  } as const,
  scopeBudgetTitle: (scopeLabel: string) => `${scopeLabel}预算`,

  noBudgetPoliciesBody:
    "尚无预算策略。可在智能体/项目详情页设置，或使用既有公司月度预算控制。",

  allProviders: "全部供应商",
  allBillers: "全部计费方",
  noCostEventsInPeriod: "本周期内无成本事件。",
  noBillableEventsInPeriod: "本周期内无可计费事件。",

  financeByBillerTitle: "按计费方",
  financeByBillerDescription: "按收费/入账方分组的账户级账务事件。",
  noFinanceEvents: "尚无账务事件。",

  financeSummaryTitle: "账务台账",
  financeSummaryDescription: "无法映射到单笔推理请求的账户级费用。",
  financeSummaryDebits: "借方",
  financeSummaryDebitsSubtitle: (n: number) => `范围内共 ${n} 条事件`,
  financeSummaryCredits: "贷方",
  financeSummaryCreditsSubtitle: "退款、冲减与额度退回",
  financeSummaryNet: "净额",
  financeSummaryNetSubtitle: "所选周期内借方减贷方",
  financeSummaryEstimated: "预估",
  financeSummaryEstimatedSubtitle: "尚未以发票为准的预估借方",
} as const;

export const costsBudgetIncidentUi = {
  stateResolved: "已解决",
  stateDismissed: "已忽略",
  stateEscalated: "已升级",
  statePendingApproval: "待审批",
  stateOpen: "待处理",
  hardStopEyebrow: (scopeZh: string) => `${scopeZh}硬停`,
  spendingAgainstLimit: (observed: string, limit: string) =>
    `支出已达 ${observed}，上限为 ${limit}。`,
  pauseProject:
    "在解决预算事件之前，本项目的新工作不会启动。",
  pauseScopeHeartbeats:
    "在解决预算事件之前，该范围内新的心跳将不会启动。",
  newBudgetUsd: "新预算（USD）",
  raiseBudgetResume: "提高预算并恢复",
  applying: "提交中…",
  budgetMustExceedObserved: "新预算须高于当前已观测支出。",
  keepPaused: "保持暂停",
} as const;

/** AccountingModelCard — 计费模型说明卡片 */
export const accountingModelCardUi = {
  title: "计费模型",
  description:
    "回形针现在将请求级推理用量与账户级财务事件分离，确保在通过 OpenRouter、Cloudflare、Bedrock 等中间商结算时供应商报告准确。",
  inferenceLedger: "推理台账",
  inferenceLedgerDesc: "单次请求级用量与计费运行，来自 cost_events。",
  inferencePoints: [
    "Token + 计费美元",
    "供应商、结算方、模型",
    "订阅与超量感知",
  ],
  financeLedger: "财务台账",
  financeLedgerDesc: "账户级费用，非单次提示-响应对。",
  financePoints: [
    "充值、退款、手续费",
    "Bedrock 预置或训练费用",
    "积分过期与调整",
  ],
  liveQuotas: "实时配额",
  liveQuotasDesc: "可实时阻断流量的供应商或结算方窗口。",
  liveQuotaPoints: [
    "供应商配额窗口",
    "结算方积分系统",
    "错误直接暴露",
  ],
} as const;

export const costsProviderUi = {
  periodSpend: "周期内支出",
  pctOfAllocation: (pct: number) => `占分配额度 ${pct}%`,
  thisWeek: "本周",
  weeklyAllocationHint: (amount: string) => `约 ${amount}/周`,
  rollingWindows: "滚动窗口",
  tok: (formatted: string) => `${formatted} Token`,
  subscription: "订阅",
  pctTokenViaSubscription: (pct: number) => `${pct}% 的 Token 用量来自订阅`,
  titlePctOfProviderTokens: (pct: number) => `占该供应商 Token 的 ${pct}%`,
  titlePctOfProviderCost: (pct: number) => `占该供应商费用的 ${pct}%`,
  subscriptionQuota: "订阅配额",
  pctUsed: (pct: number) => `已用 ${pct}%`,
  resetsOn: (date: string) => `${date} 重置`,
  descInOut: (inn: string, out: string) => `入 ${inn} · 出 ${out}`,
  meteredRunsHint: (api: number, sub: number) => {
    if (api > 0 && sub > 0) return `约 ${api} 次 API / ${sub} 次订阅运行`;
    if (api > 0) return `约 ${api} 次 API 运行`;
    if (sub > 0) return `约 ${sub} 次订阅运行`;
    return "";
  },
  subscriptionDetailLine: (runCount: number, totalTokFmt: string | null, inFmt: string, outFmt: string) => {
    let s = `${runCount} 次运行`;
    if (totalTokFmt) s += ` · ${totalTokFmt} 合计`;
    s += ` · ${inFmt} 入 · ${outFmt} 出`;
    return s;
  },
} as const;

export const costsBillerUi = {
  descLine: (inn: string, out: string, providers: number, models: number) =>
    `入 ${inn} · 出 ${out} · ${providers} 个供应商 · ${models} 个模型`,
  meteredRuns: (n: number) => (n === 0 ? "0 次按量运行" : `${n} 次按量运行`),
  subscriptionRuns: (n: number) => (n === 0 ? "0 次订阅运行" : `${n} 次订阅运行`),
  thisWeekAmount: (amount: string) => `本周 ${amount}`,
  providerModelsLine: (providers: number, models: number) =>
    `${providers} 个供应商 · ${models} 个模型`,
  billingTypes: "计费类型",
  upstreamProviders: "上游供应商",
  tok: (formatted: string) => `${formatted} Token`,
} as const;

export const costsFinanceCardsUi = {
  recentEventsTitle: "近期账务事件",
  recentEventsDescription: "充值、费用、贷项、承诺及其它非按请求计费项。",
  emptyInPeriod: "本周期内无账务事件。",
  invoicePrefix: (id: string) => `发票 ${id}`,
  regionPrefix: (code: string) => `区域 ${code}`,
  tierPrefix: (name: string) => `档位 ${name}`,
  estimatedBadge: "预估",
  mixTitle: "账务事件构成",
  mixDescription: "按事件类型的账户级费用分组。",
  mixRowMeta: (events: number, billers: number) =>
    `${events} 条事件 · ${billers} 个计费方`,
  mixDebitsLine: (amount: string) => `借方 ${amount}`,
  billerMeta: (events: number, kinds: number) => `${events} 条事件，涉 ${kinds} 类`,
  netEyebrow: "净额",
  gridDebits: "借方",
  gridCredits: "贷方",
  gridEstimated: "预估",
} as const;

export const costsSubscriptionPanelUi = {
  anthropicTitle: "Anthropic 订阅",
  anthropicSubtitle: "实时 Claude 配额窗口。",
  codexTitle: "Codex 订阅",
  codexSubtitle: "实时 Codex 配额窗口。",
  accountWindows: "账户级窗口",
  modelWindows: "模型级窗口",
  resetsAt: (when: string) => `${when} 重置`,
  pctUsed: (pct: number) => `已用 ${pct}%`,
} as const;

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
    blocked: "阻塞",
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

  blockedGroupByTitle: "阻塞分组",
  blockedSortTitle: "阻塞排序",
  blockedLoadingErrorTitle: "无法加载阻塞收件箱。",
  blockedLoadingErrorBody: "其他收件箱选项卡仍可使用。",
  blockedEmptyTitle: "没有停住的工作。",
  blockedEmptyBody: "需要决策、恢复或外部行动的事务会出现在这里。",
  blockedNoSearchResults: "没有停住的事务匹配当前搜索。",

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

/** IssueBlockedNotice — successful run handoff / next-step prompt. */
export const issueBlockedNotice = {
  needsNextTitle: "该事务需要下一步操作。",
  needsNextBody: "一次运行已成功完成，但该事务仍处于 {status} 状态，且没有明确的下一步负责人。",
  markDoneOrCancelled: "标记为已完成或已取消。",
  sendForReviewOrAskInput: "送审或请求输入。",
  markBlockedWithOwner: "标记为阻塞并指定阻塞负责人。",
  delegateOrQueueContinuation: "委派后续工作或排队等待继续。",
  correctiveWakeQueued: (agentName: string) => `已为 ${agentName} 排队修正唤醒`,
  correctiveWakeQueuedFallback: "已为经办人排队修正唤醒",
  detectedProgress: (summary: string) => `检测到进展：${summary}`,
  // Blocker section strings
  blockedByLinked: (count: number, plural: string) =>
    `该事务的工作被${count === 1 ? "关联事务" : `${count} 个关联事务`}阻塞，在${plural === "it is" ? "其" : "它们"}完成前无法继续。评论仍会唤醒经办人进行处理。`,
  stalledInReview: (count: number) =>
    `该事务的工作被关联事务阻塞，但阻塞链在审核中停滞，没有明确的下一步。${count > 1 ? "请解决以下停滞的审核或移除阻塞。" : "请解决以下停滞的审核或移除阻塞。"}`,
  stalledInReviewLabel: "审核中停滞",
  ultimatelyWaitingOn: "最终等待",
  blockedByParkedWork: "被暂停工作阻塞",
  blockedUntilMoved: "该事务的工作被阻塞，直到移回待办才能继续。评论仍会唤醒经办人进行处理。",
} as const;

/** 侧边栏导航 */
export const sidebarNav = {
  // Instance sidebar
  instanceSettings: "实例设置",
  instanceProfile: "资料",
  instanceGeneral: "通用",
  instanceAccess: "访问控制",
  instanceHeartbeats: "心跳",
  instanceExperimental: "实验性",
  instancePlugins: "插件",
  instanceAdapters: "适配器",
  // Company sidebar
  companySettings: "公司设置",
  companyGeneral: "通用",
  companyEnvironments: "环境",
  companyAccess: "访问控制",
  companyInvites: "邀请",
  companySecrets: "密钥",
  companySkills: "技能",
} as const;

/** 公司设置页 */
export const companySettingsPage = {
  noCompanySelected: "未选择公司。请从上方切换器选择公司。",
  general: "通用",
  companyName: "公司名称",
  companyNameHint: "公司的显示名称。",
  description: "描述",
  descriptionHint: "公司资料中显示的可选描述。",
  descriptionPlaceholder: "公司可选描述",
  appearance: "外观",
  logo: "徽标",
  logoHint: "上传 PNG、JPEG、WEBP、GIF 或 SVG 徽标图片。",
  removing: "移除中…",
  removeLogo: "移除徽标",
  uploadingLogo: "正在上传徽标…",
  brandColor: "品牌色",
  brandColorHint: "设置公司图标的色调。留空为自动生成颜色。",
  autoPlaceholder: "自动",
  clear: "清除",
  attachmentLimit: "附件大小限制",
  attachmentLimitHint: (max: number) => `接受范围：1-${max} MiB。`,
  attachmentLimitError: (max: number) => `请输入 1 到 ${max} 的整数。`,
  saving: "保存中…",
  saveChanges: "保存更改",
  saved: "已保存",
  failedToSave: "保存失败",
  hiring: "招聘",
  requireBoardApproval: "新员工需董事会审批",
  requireBoardApprovalHint: "新智能体招聘在董事会批准前保持待定。",
  invites: "邀请",
  generateOpenClawInvite: "生成 OpenClaw 邀请提示",
  generateOpenClawInviteHint: "创建一次性 OpenClaw 智能体邀请并渲染可复制提示。",
  generating: "生成中…",
  openClawInvitePrompt: "OpenClaw 邀请提示",
  copied: "已复制",
  copiedSnippet: "已复制片段",
  copySnippet: "复制片段",
  companyPackages: "公司数据包",
  importExportMoved: "导入导出已迁移至专用页面，可从 组织架构图 头部访问。",
  export: "导出",
  import: "导入",
  dangerZone: "危险操作",
  archiveHint: "归档公司以从侧边栏隐藏。数据仍保留在数据库中。",
  archiving: "归档中…",
  alreadyArchived: "已归档",
  archiveCompany: "归档公司",
  failedToArchive: "归档公司失败",
  failedToCreateInvite: "创建邀请失败",
} as const;

/** 公司环境页 */
export const companyEnvironmentsPage = {
  noCompanySelected: "选择公司以管理环境。",
  title: "公司环境",
  disabledHint: "在实例实验性设置中启用环境，以管理公司执行目标。",
  subtitle: "为项目、事务工作区和远程适配器定义可复用的执行目标。",
  adapter: "适配器",
  local: "本地",
  ssh: "SSH",
  sandboxViaPlugin: "沙箱（插件）",
  noEnvironments: "该公司尚未保存任何环境。",
  sshHostFallback: "SSH 主机",
  userFallback: "用户",
  runsOnHost: "在此 Paperclip 主机上运行。",
  testing: "测试中…",
  testConnection: "测试连接",
  testProvider: "测试提供商",
  editing: "编辑中",
  edit: "编辑",
  editEnvironment: "编辑环境",
  addEnvironment: "添加环境",
  name: "名称",
  nameHint: "此执行目标的运营名称。",
  description: "描述",
  descriptionHint: "关于此机器用途的可选说明。",
  driver: "驱动",
  driverHint: "本地在此主机上运行。SSH 存储远程机器目标。沙箱存储插件支持的提供商配置。",
  sandbox: "沙箱",
  localOption: "本地",
  host: "主机",
  hostHint: "远程机器的 DNS 名称或 IP 地址。",
  port: "端口",
  portHint: "默认 22。",
  username: "用户名",
  usernameHint: "SSH 登录用户。",
  remoteWorkspacePath: "远程工作区路径",
  remoteWorkspacePathHint: "Paperclip 将在 SSH 连接测试期间验证的绝对路径。",
  workspacePlaceholder: "/Users/paperclip/workspace",
  privateKey: "私钥",
  privateKeyHint: "可选 PEM 私钥。留空以依赖服务器的 SSH 代理或默认密钥链。",
  noSavedSecret: "无已保存的密钥",
  knownHosts: "已知主机",
  knownHostsHint: "启用严格主机密钥检查时使用的可选 known_hosts 块。",
  strictHostKeyChecking: "严格主机密钥检查",
  strictHostKeyCheckingHint: "除非你刻意想在探测时禁用主机密钥接受，否则保持开启。",
  provider: "提供商",
  providerHint: "已安装的具运行能力的沙箱提供商插件将显示在此处。",
  noProviderFields: "此提供商未声明额外的配置字段。",
  saving: "保存中…",
  creating: "创建中…",
  saveEnvironment: "保存环境",
  createEnvironment: "创建环境",
  cancel: "取消",
  testDraft: "测试草稿",
  failedToSave: "保存环境失败",
  environmentCreated: "环境已创建",
  environmentUpdated: "环境已更新",
  readyMessage: (name: string) => `${name} 已就绪。`,
  failedToSaveToast: "保存环境失败",
  envSaveFailed: "环境保存失败。",
  probePassed: "环境探测通过",
  probeFailed: "环境探测失败",
  draftProbePassed: "草稿探测通过",
  draftProbeFailed: "草稿探测失败",
  sandboxProviders: (names: string) => `已安装的沙箱提供商：${names}`,
  sandboxProvidersNote: "这些不是适配器类型。它们为支持沙箱执行的适配器提供沙箱驱动。",
  supportMatrixNote: "环境选择使用与智能体默认设置相同的适配器支持矩阵。SSH 始终可用于远程管理的适配器，沙箱环境仅在安装了具运行能力的沙箱提供商插件时出现。",
} as const;

/** 公司邀请页 */
export const companyInvitesPage = {
  noCompanySelected: "选择公司以管理邀请。",
  title: "公司邀请",
  description: "创建人类邀请链接以访问公司。新邀请链接在生成时会自动复制到剪ipboard。",
  createInvite: "创建邀请",
  createInviteHint: "生成人类邀请链接并选择其应请求的默认访问权限。",
  chooseRole: "选择角色",
  viewer: "观察者",
  viewerDesc: "可以查看公司工作并跟进，无运营权限。",
  viewerDetail: "无内置权限。",
  operator: "操作员",
  operatorDesc: "推荐给需要帮助运行工作但无需管理访问的人。",
  operatorDetail: "可以分配任务。",
  admin: "管理员",
  adminDesc: "推荐给需要邀请人员、创建智能体和批准加入的操作员。",
  adminDetail: "可以创建智能体、邀请用户、分配任务和批准加入请求。",
  owner: "所有者",
  ownerDesc: "完整公司访问权限，包括成员资格和权限管理。",
  ownerDetail: "包含管理员的所有权限，外加管理成员和权限授予。",
  defaultBadge: "默认",
  inviteInfo: "每个邀请链接只能使用一次。首次成功使用将消耗链接并创建或复用匹配的加入请求，然后等待审批。",
  creating: "创建中…",
  create: "创建邀请",
  inviteHistoryNote: "下方的邀请历史保留审计追踪。",
  latestInvite: "最新邀请链接",
  inviteUrlHint: "此 URL 包含服务器返回的当前 Paperclip 域名。",
  openInvite: "开放邀请",
  inviteHistory: "邀请历史",
  inviteHistoryHint: "查看邀请状态、角色、邀请人和任何关联的加入请求。",
  openJoinQueue: "打开加入请求队列",
  noInvites: "该公司尚未创建任何邀请。",
  state: "状态",
  role: "角色",
  invitedBy: "邀请人",
  created: "创建时间",
  joinRequest: "加入请求",
  action: "操作",
  unknownInviter: "未知邀请人",
  reviewRequest: "查看请求",
  revoke: "撤销",
  inactive: "未激活",
  loadingMore: "加载更多中…",
  viewMore: "查看更多",
  inviteCreated: "邀请已创建",
  inviteReady: "邀请已就绪并已复制到剪贴板。",
  inviteReadyNoCopy: "邀请已就绪。",
  clipboardUnavailable: "剪贴板不可用",
  manualCopyHint: "请从下方字段手动复制邀请 URL。",
  failedToCreate: "创建邀请失败",
  unknownError: "未知错误",
  inviteRevoked: "邀请已撤销",
  failedToRevoke: "撤销邀请失败",
  pendingBadge: (n: number) => `待处理（${n}）`,
} as const;

/** 公司访问页 */
export const companyAccessPage = {
  noCompanySelected: "选择公司以管理访问。",
  loading: "正在加载公司访问…",
  noPermission: "你无权管理公司成员。",
  failedToLoad: "加载公司成员失败。",
  title: "公司访问",
  description: (name: string) => `管理 ${name} 的公司成员资格、成员资格状态和显式权限授予。`,
  instanceAdminWarning: "此账户可通过实例管理员权限在此管理访问，但目前尚未持有活跃的公司成员资格。",
  humans: "人类",
  humansHint: "在此管理人类公司成员资格、状态和授予。",
  pendingHumanJoins: "待处理的人类加入",
  pendingHumanJoinsHint: "在人类加入请求成为活跃公司成员之前进行审查。",
  unknownRequester: "未知人类请求者",
  noEmail: "无可用邮箱",
  joinInviteSuffix: " 加入邀请",
  defaultRoleSuffix: " 默认角色 ",
  inviteMetadataUnavailable: "邀请元数据不可用",
  submitted: "提交于 ",
  approveHuman: "批准人类",
  rejectHuman: "拒绝人类",
  userAccount: "用户账户",
  role: "角色",
  status: "状态",
  grants: "授予",
  action: "操作",
  noMemberships: "尚未找到该公司的用户成员资格。",
  unset: "未设置",
  edit: "编辑",
  remove: "移除",
  editMember: "编辑成员",
  editMemberDesc: (name: string) => `更新 ${name} 的公司角色、成员资格状态和显式授予。`,
  companyRole: "公司角色",
  membershipStatus: "成员资格状态",
  active: "活跃",
  pending: "待定",
  suspended: "已暂停",
  grantsSection: "授予",
  grantsHint: "角色自动提供隐式授予。以下显式授予仅用于覆盖和角色变更后应保留的额外访问。",
  implicitGrants: "角色的隐式授予",
  implicitGrantsIncluded: (role: string) => `"${role}" 角色自动包含这些权限。`,
  noImplicitGrants: "未选择角色，因此此成员目前没有隐式授予。",
  includedImplicitly: (role: string) => `由 "${role}" 角色隐式包含。仅在角色变更后仍应保持时才添加显式授予。`,
  storedExplicitly: "为此成员显式存储。",
  saving: "保存中…",
  saveAccess: "保存访问",
  removeMember: "移除成员",
  removeMemberDesc: (name: string) => `归档 ${name} 并在隐藏此用户之前移动活跃分配。`,
  checkingAssigned: "正在检查已分配的事务…",
  openAssigned: (n: number) => ` ${n} 个已分配的事务`,
  issueReassignment: "事务重新分配",
  leaveUnassigned: "保留未分配",
  humansOptgroup: "人类",
  agentsOptgroup: "智能体",
  roleSuffix: (role: string) => `（${role}）`,
  moreIssues: (n: number) => ` 还有 ${n} 个事务`,
  memberUpdated: "成员已更新",
  failedToUpdate: "更新成员失败",
  joinRequestApproved: "加入请求已批准",
  failedToApprove: "批准加入请求失败",
  joinRequestRejected: "加入请求已拒绝",
  failedToReject: "拒绝加入请求失败",
  memberRemoved: "成员已移除",
  assignedCleanedUp: (n: number) => ` 已清理 ${n} 个已分配的事务。`,
  failedToRemove: "移除成员失败",
  createAgents: "创建智能体",
  inviteHumansAndAgents: "邀请人类和智能体",
  manageMembersAndGrants: "管理成员和授予",
  assignTasks: "分配任务",
  assignScopedTasks: "分配范围任务",
  manageActiveCheckouts: "管理活跃事务签出",
  approveJoinRequests: "批准加入请求",
  manageEnvironments: "管理环境",
  noExplicitGrants: "无显式授予",
  cancel: "取消",
  unknownError: "未知错误",
} as const;

/** 实例设置侧边栏和页面通用 */
export const instanceSettingsPage = {
  profile: "资料",
  general: "通用",
  access: "访问控制",
  heartbeats: "心跳",
  experimental: "实验性",
  plugins: "插件",
  adapters: "适配器",
} as const;

/** 实例设置 — 个人资料页 */
export const profileSettingsPage = {
  loadingProfile: "正在加载资料…",
  failedToLoadProfile: "加载资料失败。",
  title: "资料",
  subtitle: "控制你的账户在侧边栏和其他看板界面中的显示方式。",
  storedInStorage: (name: string) => `存储在 ${name} 的 Paperclip 文件存储中。`,
  selectCompanyToUpload: "选择公司以上传头像到 Paperclip 存储。",
  changePhoto: "更换照片",
  uploadPhoto: "上传照片",
  remove: "移除",
  noEmail: "无邮箱",
  displayName: "显示名称",
  displayNameHint: "显示在侧边栏账户页脚和评论作者界面中。",
  emailLabel: "邮箱",
  emailHint: "邮箱由你的认证会话管理，此处为只读。",
  saving: "保存中…",
  saveProfile: "保存资料",
  failedToUpdateProfile: "更新资料失败。",
  failedToUploadAvatar: "上传头像失败。",
  failedToRemoveAvatar: "移除头像失败。",
  selectCompanyBeforeUpload: "上传头像前请先选择公司。",
} as const;

/** 实例设置 — 通用页 */
export const instanceGeneralPage = {
  loadingGeneral: "正在加载通用设置…",
  failedToLoadGeneral: "加载通用设置失败。",
  title: "通用",
  subtitle: "配置实例范围的偏好，包括日志显示、键盘快捷键、备份保留和数据共享。",
  deploymentAndAuth: "部署与认证",
  localTrustedDesc: "本地信任模式针对本地操作员优化。浏览器请求作为本地看板上下文运行，无需登录。",
  authenticatedPublicDesc: "认证公开模式需要登录才能访问看板，适用于公开 URL。",
  authenticatedPrivateDesc: "认证私有模式需要登录，适用于 LAN、VPN 或其他私有网络部署。",
  authReadiness: "认证就绪",
  ready: "就绪",
  notReady: "未就绪",
  bootstrapStatus: "引导状态",
  setupRequired: "需要设置",
  bootstrapInvite: "引导邀请",
  active: "活跃",
  none: "无",
  censorUsernameInLogs: "在日志中屏蔽用户名",
  censorUsernameHint: "隐藏主页目录路径和其他操作员可见日志输出中的用户名段。实时转写视图中路径外的用户名提及尚未屏蔽。默认关闭。",
  toggleCensorAria: "切换用户名日志屏蔽",
  keyboardShortcuts: "键盘快捷键",
  keyboardShortcutsHint: "启用应用键盘快捷键，包括收件箱导航和全局快捷键（如创建问题或切换面板）。默认关闭。",
  toggleShortcutsAria: "切换键盘快捷键",
  backupRetention: "备份保留",
  backupRetentionHint: "配置自动数据库备份的保留时间。备份大约每小时运行一次并使用 gzip 压缩。在每日窗口内保留所有备份；超出后，每周和每月各保留一个备份。",
  daily: "每日",
  weekly: "每周",
  monthly: "每月",
  daysLabel: (n: number) => `${n} 天`,
  weeksLabel: (n: number) => n === 1 ? "1 周" : `${n} 周`,
  monthsLabel: (n: number) => n === 1 ? "1 个月" : `${n} 个月`,
  aiFeedbackSharing: "AI 反馈共享",
  aiFeedbackSharingHint: "控制点赞和点踩投票是否可将选定的 AI 输出发送给 Paperclip Labs。投票始终保存在本地。",
  readTermsOfService: "阅读我们的服务条款",
  feedbackNoDefault: "尚未保存默认值。下次点赞或点踩时会询问一次，然后将答案保存到此处。",
  feedbackAlwaysAllow: "始终允许",
  feedbackAlwaysAllowDesc: "自动共享已投票的 AI 输出。",
  feedbackDontAllow: "不允许",
  feedbackDontAllowDesc: "投票 AI 输出仅保存在本地。",
  feedbackRetestHint: "要在本地开发中重新测试首次使用提示，请从该实例的 instance_settings.general JSON 行中移除 feedbackDataSharingPreference 键，或将其设回 \"prompt\"。未设置和 \"prompt\" 都表示尚未选择默认值。",
  signOut: "退出登录",
  signOutHint: "退出此 Paperclip 实例。你将被重定向到登录页面。",
  signingOut: "正在退出…",
  failedToSignOut: "退出登录失败。",
  failedToUpdate: "更新设置失败。",
} as const;

/** 实例设置 — 访问控制页 */
export const instanceAccessPage = {
  loadingUsers: "正在加载实例用户…",
  adminAccessRequired: "需要实例管理员访问权限才能管理用户。",
  failedToLoadUsers: "加载用户失败。",
  title: "实例访问控制",
  subtitle: "搜索用户、管理实例管理员状态，以及控制他们可访问的公司。",
  searchUsers: "搜索用户",
  searchPlaceholder: "按姓名或邮箱搜索",
  activeMemberships: (n: number) => `${n} 个活跃公司成员`,
  selectUserToInspect: "选择用户以查看实例访问权限。",
  loadingUserAccess: "正在加载用户访问权限…",
  failedToLoadUserAccess: "加载用户访问权限失败。",
  removeInstanceAdmin: "移除实例管理员",
  promoteToInstanceAdmin: "提升为实例管理员",
  companyAccess: "公司访问权限",
  companyAccessHint: "切换该公司的成员资格。新访问默认为活跃操作员成员资格。",
  saving: "保存中…",
  saveCompanyAccess: "保存公司访问权限",
  currentMemberships: "当前成员资格",
  membershipRoleUnset: "未设置",
  toastCompanyAccessUpdated: "公司访问权限已更新",
  toastInstanceRoleUpdated: "实例角色已更新",
  noUserSelected: "未选择用户",
} as const;

/** 实例设置 — 心跳页 */
export const instanceHeartbeatsPage = {
  loadingHeartbeats: "正在加载定时心跳…",
  failedToLoadHeartbeats: "加载定时心跳失败。",
  title: "定时心跳",
  subtitle: "在所有公司中启用了定时心跳的智能体。",
  active: "活跃",
  disabled: "已禁用",
  companies: "公司",
  company: "公司",
  disableAll: "全部禁用",
  disabling: "禁用中…",
  confirmDisableAll: (n: number) => `禁用所有 ${n} 个已启用的定时心跳？`,
  noHeartbeats: "当前条件下没有匹配的定时心跳。",
  on: "开启",
  off: "关闭",
  fullAgentConfig: "完整智能体配置",
  disableTimerHeartbeat: "禁用定时心跳",
  enableTimerHeartbeat: "启用定时心跳",
  never: "从未",
  failedToUpdateHeartbeat: "更新心跳失败。",
  failedToDisableAll: "禁用全部心跳失败。",
  failedToDisableSingle: (n: number, detail: string) =>
    n === 1
      ? `禁用 1 个定时心跳失败：${detail}`
      : `禁用 ${n}/${n} 个定时心跳失败。首个错误：${detail}`,
} as const;

/** Secrets page (`/secrets`) */
export const secretsPage = {
  title: "密钥",
  selectCompany: "选择团队以管理密钥。",
  tabSecrets: "密钥",
  tabVaults: "供应商保险库",
  searchPlaceholder: "按名称、键、引用搜索",
  searchAria: "搜索密钥",
  newSecret: "新建密钥",
  emptyMessage: "还没有密钥。创建第一个托管密钥或链接外部引用。",
  emptyAction: "新建密钥",
  noMatch: "没有符合筛选条件的密钥。",
  errorLoad: "加载密钥失败：",
  retry: "重试",
  filters: "筛选",
  clear: "清除",
  statusLabel: "状态",
  providerLabel: "供应商",
  activeStatus: "活跃",
  allStatuses: "全部状态",
  disabledStatus: "已禁用",
  archivedStatus: "已归档",
  allProviders: "全部供应商",
  thName: "名称",
  thMode: "模式",
  thProvider: "供应商",
  thStatus: "状态",
  thVersion: "版本",
  thLastRotated: "上次轮换",
  thLastResolved: "上次解析",
  thReferences: "引用数",
  thReference: "引用",
  paperclipManaged: "Paperclip 托管",
  linkedExternal: "链接外部",
  owned: "自有",
  open: "打开",
  viewReferencesAria: (name: string) => `查看 ${name} 的引用`,
  tabDetails: "详情",
  tabUsage: "使用情况",
  tabEvents: "访问事件",
  updateValue: "更新值",
  updateReference: "更新引用",
  disable: "禁用",
  activate: "启用",
  unarchive: "取消归档",
  archive: "归档",
  delete: "删除",
  createTitle: "创建密钥",
  createDescription:
    "选择 Paperclip 是否拥有未来供应商写入权限，或仅在运行时解析现有供应商引用。",
  managedValue: "托管值",
  externalReference: "外部引用",
  nameLabel: "名称",
  keyLabel: "键",
  keyOptional: "（可选）",
  keyPlaceholder: "自动从名称生成",
  providerVaultLabel: "供应商保险库",
  deploymentDefault: "部署默认",
  notConfigured: "（未配置）",
  externalOnly: "（仅外部）",
  managedHint:
    "Paperclip 托管密钥在选定供应商中创建，未来轮换通过 Paperclip 写入新版本。",
  externalHint:
    "现有供应商密钥在 Paperclip 中为仅解析模式。在供应商中轮换值后，仅在路径、ARN 或版本变更时更新此引用。",
  valueLabel: "值",
  valuePlaceholder: "存储一次，不再显示",
  refLabel: "外部引用",
  descriptionLabel: "描述",
  descriptionPlaceholder: "此密钥的用途？（不要填值）",
  createButton: "创建密钥",
  linkButton: "链接引用",
  rotating: "轮换中…",
  cancel: "取消",
  rotateValueTitle: "更新密钥值",
  rotateRefTitle: "更新外部引用",
  rotateValueDesc:
    "创建新的供应商支持版本。锁定最新版本的消费者将在下次运行获取新值。",
  rotateRefDesc:
    "创建指向现有供应商密钥的新 Paperclip 元数据版本。Paperclip 不写入新的供应商值。",
  newValuePlaceholder: "粘贴新值",
  updatedRefPlaceholder: "更新后的引用",
  rotateHint: "先在供应商中轮换实际值，再更改此 Paperclip 引用。",
  rotateWithDefaultHint: "使用部署默认轮换保留当前回退行为。",
  rotateButton: "更新值",
  rotateRefButton: "更新引用",
  deleteTitle: "删除密钥",
  deleteDesc: (name: string) => `永久删除 ${name}。`,
  deleteTrail: "活跃绑定将失败，直到你重新映射它们。",
  deleteButton: "删除",
  deleting: "删除中…",
  editVaultTitle: "编辑供应商保险库",
  createVaultTitle: "创建供应商保险库",
  vaultDescription: "仅保存非敏感路由元数据。凭据保留在运行时环境或供应商身份中。",
  vaultDisplayLabel: "显示名称",
  vaultStatusLabel: "状态",
  vaultStatusReady: "就绪",
  vaultStatusWarning: "警告",
  vaultStatusComingSoon: "即将上线",
  vaultStatusDisabled: "已禁用",
  vaultDefaultFor: (provider: string) => `作为 ${provider} 的默认`,
  toastCreated: "密钥已创建",
  toastRotated: "已轮换",
  toastRotatedBody: (name: string, version: number) => `${name} → v${version}`,
  toastStatusChanged: (status: string) => `密钥${status}`,
  toastDeleted: "密钥已删除",
  toastStatusFailedTitle: "状态更新失败",
  toastStatusFailedBody: "请重试。",
  toastDeleteFailedTitle: "删除失败",
  toastDeleteFailedBody: "请重试。",
  howToTitle: "按绑定供应商运行时环境变量使用密钥。",
  vaultComingSoonHint:
    "此供应商可保存草稿路由元数据，但在供应商模块实现并审查之前，运行时写入和解析保持禁用。",
  saveVault: "保存保险库",
  createVault: "创建保险库",
  saving: "保存中…",
  checkHealth: "检查健康",
  makeDefault: "设为默认",
  defaultBadge: "默认",
  healthNotChecked: "未检查健康",
  healthLabel: "健康",
  addVault: "添加保险库",
  noVaults: "尚无公司级保险库。密钥仍可使用部署默认供应商设置。",
  notSupported: "尚不支持。",
  loadingVaults: "正在加载供应商保险库",
  errorLoadVaults: "加载供应商保险库失败：",
  importFromVault: "从保险库导入",
  awsVaultDisabled: "AWS 保险库已禁用 — 管理",
  awsVaultHint: "配置 AWS 供应商保险库以启用远程导入",
  descriptionField: "描述",
  custodyField: "保管",
  providerField: "供应商",
  latestVersionField: "最新版本",
  createdField: "创建时间",
  updatedField: "更新时间",
  linkedRef: "链接的供应商引用",
  providerManagedPath: "供应商管理路径",
  custodyManagedDesc: "Paperclip 拥有此供应商密钥的创建和轮换写入权限。",
  custodyExternalDesc: "Paperclip 解析此供应商引用，但不轮换供应商值。",
  custodyWarning: "Paperclip 从不重新显示存储的值。",
  noBindings: "无活跃绑定。在智能体、项目、环境或插件配置中添加此密钥以开始使用。",
  loading: "加载中…",
  required: "必需",
  optional: "可选",
  noEvents: "无访问事件记录。每次运行时解析会在此写入一个脱敏条目。",
  vaultLabel: "保险库",
  referencesTitle: "密钥引用",
  referencesDesc: (name: string, count: number) =>
    `${name} 被 ${count} 个${count === 1 ? "位置" : "位置"}引用。`,
  awsManagedPath: "AWS 托管路径",
  selectProvider: "选择一个供应商。",
  providerVaultDisabled: "此供应商保险库已禁用。",
  providerVaultComingSoon: "此供应商保险库仅保存为草稿元数据。",
  vaultHealthError: "此供应商保险库健康检查失败。",
  backupAcknowledgment: "我了解备份和恢复需要数据库元数据和本地加密主密钥文件。",
  awsRegionLabel: "AWS 区域",
  namespaceLabel: "命名空间",
  secretNamePrefixLabel: "密钥名称前缀",
  kmsKeyIdLabel: "KMS 密钥 ID",
  ownerTagLabel: "所有者标签",
  environmentTagLabel: "环境标签",
  addressLabel: "地址",
  mountPathLabel: "挂载路径",
  secretPathPrefixLabel: "密钥路径前缀",
  gcpProjectIdLabel: "项目 ID",
  gcpLocationLabel: "位置",
  optionalSuffix: "（可选）",
  // Block reasons
  blockSelectProvider: "选择一个供应商。",
  blockNotConfigured: "在此部署中未配置。",
  blockHealthFailed: "健康检查失败：",
} as const;

/** Company skills page (`/skills`) */
export const companySkillsPage = {
  title: "技能",
  available: "可用",
  noMatch: "没有符合筛选条件的技能。",
  filterPlaceholder: "筛选技能",
  sourcePlaceholder: "粘贴路径、GitHub URL 或 skills.sh 命令",
  add: "添加",
  scanProjects: "扫描项目工作区查找技能",
  scanning: "正在扫描项目工作区以查找技能…",
  refreshing: "正在刷新技能列表…",
  scanComplete: "项目技能扫描完成",
  scanFailed: "项目技能扫描失败",
  scanFailedBody: "扫描项目工作区失败。",
  scanConflicts: "发现技能冲突",
  scanWarnings: "扫描警告",
  skillCreated: "技能已创建",
  skillCreatedBody: (name: string) => `${name} 现在可在 Paperclip 工作区中编辑。`,
  createFailed: "技能创建失败",
  createFailedBody: "创建技能失败。",
  removeSkill: "移除技能",
  removeDesc: "从公司库中移除此技能。如果仍有智能体使用它，移除将被阻止直至解绑。",
  removeConfirm: (name: string) => `你即将移除 ${name}。`,
  removeConfirmGeneric: "你即将移除此技能。",
  usedByLabel: "当前被使用",
  detachHint: "从所有智能体解绑此技能以启用移除。",
  close: "关闭",
  cancel: "取消",
  removing: "移除中…",
  removeButton: "移除技能",
  skillRemoved: "技能已移除",
  skillRemovedBody: (name: string) => `${name} 已从公司技能库中移除。`,
  removeFailed: "移除失败",
  removeFailedBody: "移除技能失败。",
  importSuccess: "技能已导入",
  importSuccessBody: (n: number) => `已添加 ${n} 个技能。`,
  importWarnings: "导入警告",
  importFailed: "技能导入失败",
  importFailedBody: "导入技能来源失败。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "保存失败",
  saveFailedBody: "保存技能文件失败。",
  skillUpdated: "技能已更新",
  pinnedTo: "已固定到",
  updateFailed: "更新失败",
  updateFailedBody: "安装技能更新失败。",
  selectCompany: "选择团队以管理技能。",
  selectSkill: "选择技能以检查其文件。",
  selectFile: "选择文件以检查。",
  namePlaceholder: "技能名称",
  slugPlaceholder: "可选短名称",
  descPlaceholder: "简短描述",
  creating: "创建中…",
  createButton: "创建技能",
  edit: "编辑",
  stopEditing: "停止编辑",
  view: "查看",
  code: "代码",
  checkUpdates: "检查更新",
  installUpdate: "安装更新",
  upToDate: "最新",
  untracked: "未跟踪",
  tracking: "跟踪",
  editable: "可编辑",
  readOnly: "只读",
  sourceLabel: "来源",
  keyLabel: "键",
  modeLabel: "模式",
  noAgents: "无智能体连接",
  noFiles: "无文件清单。",
  sourceHelpTitle: "添加技能来源",
  sourceHelpDesc: "先在字段中粘贴本地路径、GitHub URL 或 `skills.sh` 命令。",
  browseSkillsSh: "浏览 skills.sh",
  browseSkillsShHint: "查找安装命令并在此粘贴。",
  searchGitHub: "搜索 GitHub",
  searchGitHubHint: "查找包含 `SKILL.md` 的仓库，然后在此粘贴仓库 URL。",
  scanSummary: (found: number, imported: number, updated: number, conflicts: number, skipped: number, workspaces: number) =>
    `发现 ${found} 个，导入 ${imported} 个，更新 ${updated} 个${conflicts > 0 ? `，${conflicts} 个冲突` : ""}${skipped > 0 ? `，${skipped} 个跳过` : ""}，共 ${workspaces} 个工作区。`,
  deleteTitle: "移除技能",
  deleteDesc: "从公司库中移除此技能。如果仍有智能体使用它，移除将被阻止直至解绑。",
  foundSuffix: " 个发现",
  importedSuffix: " 个导入",
  updatedSuffix: " 个更新",
  conflictsSuffix: " 个冲突",
  skippedSuffix: " 个跳过",
  acrossPrefix: "共 ",
  workspacesSuffix: " 个工作区",
} as const;

// ——— Instance Experimental Settings page ———

export const instanceExperimentalPage = {
  breadcrumbExperimental: "实验性",
  title: "实验性",
  subtitle: "选择仍在评估中的功能，在成为默认行为之前。",
  loading: "正在加载实验性设置…",
  errorLoading: "加载实验性设置失败。",
  errorUpdateFallback: "更新实验性设置失败。",

  // Enable Environments
  enableEnvironmentsTitle: "启用环境",
  enableEnvironmentsDesc: "在公司设置中显示环境管理，并允许项目和智能体环境分配控件。",

  // Isolated Workspaces
  enableIsolatedWorkspacesTitle: "启用隔离工作区",
  enableIsolatedWorkspacesDesc: "在项目配置中显示执行工作区控件，并允许新建和已有事务运行的隔离工作区行为。",

  // Auto-Restart Dev Server
  autoRestartDevServerTitle: "空闲时自动重启开发服务",
  autoRestartDevServerDesc: "在 `pnpm dev`（完整 dev-runner）中，等待所有排队和运行的本地智能体运行完成，然后在后端变更或迁移使当前启动过期时自动重启服务。",

  // Timer Heartbeat
  timerHeartbeatTitle: "定时心跳策略",
  timerHeartbeatDesc: "哪些智能体角色可从服务器接收定时（间隔）心跳。其他角色仍通过分配和手动调用唤醒。实验期间无需重新部署代码即可调整。",
  eligibleRolesLabel: "符合条件的角色（逗号分隔）",
  intervalLabel: "默认间隔（秒，最小 30）",
  enableByDefault: "默认对符合条件的角色开启定时",
  enableByDefaultDesc: "符合条件的角色的新建和导入智能体会获得 <code>heartbeat.enabled</code>，除非在负载中显式关闭。",
  saveTimerPolicy: "保存定时策略",
  errorAtLeastOneRole: "请至少添加一个角色（例如 ceo, cto）。",
  errorIntervalRange: "间隔必须是 30 到 86400 秒之间的整数。",

  // Auto-Create Issue Recovery
  autoRecoveryTitle: "自动创建事务恢复任务",
  autoRecoveryDesc: "让心跳调度器为配置回溯窗口内发现的事务依赖链创建恢复事务。",
  lookbackHours: "回溯小时",
  saveHours: "保存小时",
  preview: "预览",
  runNow: "立即运行",
  currentWindow: (n: number) => `当前窗口：最近 ${n} ${n === 1 ? "小时" : "小时"}。`,
  errorLookbackRange: "回溯小时必须是 1 到 720 之间的整数。",

  // Recovery Dialog
  recoveryDialogTitle: "确认自动恢复",
  recoveryDialogDesc: (count: number, hours: number) =>
    `${count} 个恢复任务匹配过去 ${hours} 小时。`,
  recoveryDialogChecking: "正在检查恢复候选以启用。",
  recoveryEmptyState: "现在不会创建恢复任务。自动恢复仍可为此窗口内的未来活跃度事件运行。",
  recoveryTargetPrefix: "恢复目标：",
  recoverySkipped: (n: number) =>
    `${n} 个当前${n === 1 ? "发现" : "发现"}超出配置的回溯范围，不会被处理。`,
  recoveryTasks: (n: number) => `任务${n === 1 ? "" : "s"}`,
  cancel: "取消",
  enableOnly: "仅启用",
  enableAndCreate: (n: number) => `启用并创建 ${n}`,
  enable: "启用",

  // aria labels
  ariaToggleEnvironments: "切换环境实验性设置",
  ariaToggleIsolatedWorkspaces: "切换隔离工作区实验性设置",
  ariaToggleAutoRestart: "切换开发服务自动重启",
  ariaToggleAutoRecovery: "切换事务图活跃度自动恢复",
  ariaToggleTimerDefault: "切换定时心跳默认开启",
} as const;

// ——— Plugin Manager page ———

export const pluginManagerPage = {
  breadcrumbPlugins: "插件",
  title: "插件管理器",
  installPlugin: "安装插件",
  installDialogTitle: "安装插件",
  installDialogDesc: "输入你要安装的插件的 npm 包名。",
  npmPackageLabel: "npm 包名",
  npmPackagePlaceholder: "@paperclipai/plugin-example",
  cancel: "取消",
  install: "安装",
  installing: "安装中…",

  alphaWarning: "插件处于 alpha 阶段。",
  alphaWarningDesc: "插件运行时和 API 仍在变化。此功能稳定前会有破坏性变更。",

  availablePlugins: "可用插件",
  examplesBadge: "示例",
  loadingExamples: "正在加载内置示例…",
  errorLoadingExamples: "加载内置示例失败。",
  noExamples: "此检出中未找到内置示例插件。",
  notInstalled: "未安装",
  installExample: "安装示例",
  openSettings: "打开设置",
  review: "审查",

  installedPlugins: "已安装插件",
  noPluginsInstalled: "未安装插件",
  noPluginsDesc: "安装插件以扩展功能。",
  noDescription: "未提供描述。",

  /** 内置示例插件：与 `GET /api/plugins/examples` 的 packageName 对齐。 */
  bundledExampleUi: {
    "@paperclipai/plugin-hello-world-example": {
      displayName: "Hello World 小组件（示例）",
      description: "演示用 UI 插件：在看板里挂一个简单的 Hello World 小组件。",
    },
    "@paperclipai/plugin-file-browser-example": {
      displayName: "文件浏览器（示例）",
      description: "在项目导航里增加「文件」入口，并在项目详情页里浏览文件。",
    },
    "@paperclipai/plugin-kitchen-sink-example": {
      displayName: "插件能力全景（示例）",
      description:
        "大而全的参考实现：展示当前插件 API、前后桥接、各类界面扩展位、任务、Webhook、工具、流式输出，以及受信任本地工作区/进程等演示。",
    },
    "@paperclipai/plugin-orchestration-smoke-example": {
      displayName: "编排冒烟 / 集成验收（示例）",
      description:
        "集成与编排方向的验收夹具：插件路由范围、受限库表命名空间、事务编排、文档、唤醒、运行摘要与界面状态等。",
    },
  } as const,

  exampleRowBadge: "示例",
  pluginError: "插件错误",
  viewFullError: "查看完整错误",

  // Dialogs
  uninstallTitle: "卸载插件",
  uninstallDesc: (name: string) => `确定要卸载「${name}」吗？此操作不可撤销。`,
  uninstalling: "卸载中…",
  uninstall: "卸载",
  enable: "启用",
  enabled: "已启用",
  disabled: "已禁用",
  errorDetailsTitle: "错误详情",
  errorDetailsDesc: (name: string) => `${name} 遇到错误状态。`,
  whatErrored: "什么出错了",
  fullErrorOutput: "完整错误输出",
  noErrorSummary: "无错误摘要。",
  close: "关闭",

  // Toasts
  toastInstalled: "插件安装成功",
  toastInstallFailed: "插件安装失败",
  toastUninstalled: "插件卸载成功",
  toastUninstallFailed: "插件卸载失败",
  toastEnabled: "插件已启用",
  toastEnableFailed: "插件启用失败",
  toastDisabled: "插件已禁用",
  toastDisableFailed: "插件禁用失败",

  // aria
  ariaDisable: "禁用",
  ariaEnable: "启用",
  ariaUninstall: "卸载",
  ariaConfigure: "配置",
} as const;

// ——— Plugin Settings page ———

export const pluginSettingsPage = {
  breadcrumbPluginDetails: "插件详情",
  loadingPlugin: "正在加载插件详情…",

  tabConfiguration: "配置",
  tabStatus: "状态",

  about: "关于",
  description: "描述",
  author: "作者",
  categories: "类别",
  none: "无",

  settings: "设置",
  noSettingsRequired: "此插件不需要任何设置。",
  configureFromEnvironments: "从公司环境配置此插件。",
  configureFromEnvironmentsDesc: (label: string) =>
    `${label || "此插件"}在那里注册环境运行时设置，使凭证保持公司范围而非实例全局。`,
  openCompanyEnvironments: "打开公司环境",

  runtimeDashboard: "运行时仪表板",
  runtimeDashboardDesc: "工作进程、计划任务和 Webhook 投递",
  workerProcess: "工作进程",
  noWorker: "无注册的工作进程。",
  status: "状态",
  pid: "PID",
  uptime: "运行时间",
  pendingRPCs: "待处理 RPC",
  crashes: "崩溃",
  consecutiveTotal: (consecutive: number, total: number) => `${consecutive} 连续 / ${total} 总计`,
  lastCrash: "最后崩溃",
  recentJobRuns: "最近任务运行",
  noJobRuns: "无任务运行记录。",
  recentWebhookDeliveries: "最近 Webhook 投递",
  noWebhookDeliveries: "无 Webhook 投递记录。",
  lastChecked: (time: string) => `最后检查：${time}`,
  diagnosticsUnavailable: "运行时诊断当前不可用。",

  recentLogs: "最近日志",
  recentLogEntries: (n: number) => `最后 ${n} 条日志条目`,

  healthStatus: "健康状态",
  checkingHealth: "正在检查健康…",
  overall: "总体",
  healthChecksReady: "插件就绪后运行健康检查。",

  detailsCard: "详情",
  pluginIdLabel: "插件 ID",
  pluginKeyLabel: "插件键",
  npmPackageLabel: "NPM 包",
  versionLabel: "版本",

  permissions: "权限",
  noPermissionsRequested: "未请求特殊权限。",

  // Local folders
  selectCompanyForFolders: "选择团队以配置此插件的本地文件夹。",
  localFolders: "本地文件夹",
  errorLoadingFolders: "加载本地文件夹设置失败。",
  loadingFolders: "正在加载本地文件夹…",
  healthy: "健康",
  needsAttention: "需要注意",
  readWrite: "读写",
  readOnly: "只读",
  configured: "已配置",
  readable: "可读",
  writable: "可写",
  notRequested: "未请求",
  yes: "是",
  no: "否",
  configuredPath: "已配置路径",
  localFolderRequired: "本地文件夹路径为必填。",
  localFolderAbsolute: "本地文件夹必须是完整绝对路径。",
  save: "保存",
  validationProblems: "验证问题",
  requiredDirectories: "所需目录",
  requiredFiles: "所需文件",
  notInspected: "未检查",
  present: "存在",
  missing: (n: number) => `缺少 ${n} 个`,
  noneDeclared: "未声明。",
  rootNotInspectedDesc: "已配置根目录未经检查。",

  // Config form
  loadingConfig: "正在加载配置…",
  configSaved: "配置已保存。",
  saveFailed: "保存配置失败。",
  testPassed: "配置测试通过。",
  testFailed: "配置测试失败。",
  saveConfiguration: "保存配置",
  saving: "保存中…",
  testConfiguration: "测试配置",
  testing: "测试中…",
} as const;

// ——— Adapter Manager page ———

export const adapterManagerPage = {
  breadcrumbAdapters: "适配器",
  title: "适配器",
  alphaBadge: "Alpha",

  installAdapter: "安装适配器",
  installDialogTitle: "安装外部适配器",
  installDialogDesc: "从 npm 或本地路径添加适配器。适配器包必须导出 <code>createServerAdapter()</code>。",
  npmPackage: "npm 包",
  localPath: "本地路径",
  pathLabel: "适配器包路径",
  pathPlaceholder: "/mnt/e/Projects/my-adapter  或  E:\\Projects\\my-adapter",
  pathHint: "接受 Linux、WSL 和 Windows 路径。Windows 路径会自动转换。",
  packageNameLabel: "包名",
  packageNamePlaceholder: "my-paperclip-adapter",
  versionLabel: "版本（可选）",
  versionPlaceholder: "latest",
  cancel: "取消",
  install: "安装",
  installing: "安装中…",

  alphaWarning: "外部适配器处于 alpha 阶段。",
  alphaWarningDesc: "适配器插件系统正在积极开发中。API 和存储格式可能会变化。使用电源图标从智能体菜单中隐藏适配器，而无需移除它们。",

  externalAdapters: "外部适配器",
  noExternalAdapters: "未安装外部适配器",
  noExternalAdaptersDesc: "安装适配器包以扩展模型支持。",

  builtinAdapters: "内置适配器",
  noBuiltinAdapters: "未找到内置适配器。",

  // Adapter row
  external: "外部",
  builtin: "内置",
  overridesBuiltIn: "覆盖内置",
  overriddenBy: (name: string) => `被 ${name} 覆盖`,
  hiddenFromMenus: "从菜单中隐藏",
  overridePaused: "外部覆盖已暂停",
  showInMenus: "在智能体菜单中显示",
  hideFromMenus: "从智能体菜单中隐藏",
  removeAdapter: "移除适配器",
  reinstallAdapter: "重新安装适配器",
  reloadAdapter: "重新加载适配器",

  // Reinstall dialog
  reinstallTitle: "重新安装适配器",
  reinstallDesc: (pkg: string) =>
    `这将从 npm 拉取「${pkg}」的最新版本并热交换运行中的适配器模块。现有智能体将在下次运行时使用新版本。`,
  package: "包",
  current: "当前",
  latestNpm: "npm 最新",
  checking: "检查中…",
  unavailable: "不可用",
  upToDate: "已是最新版本。",
  reinstalling: "重新安装中…",
  reinstall: "重新安装",

  // Remove dialog
  removeTitle: "移除适配器",
  removeDesc: "确定要移除此适配器吗？它将被注销并从适配器存储中移除。",
  removeDescNpmCleanup: "npm 包将从磁盘清理。",
  removeDescCannotUndo: "此操作不可撤销。",
  removing: "移除中…",
  remove: "移除",

  // Toasts
  toastInstalled: "适配器已安装",
  toastInstallFailed: "安装失败",
  toastRemoved: "适配器已移除",
  toastRemovalFailed: "移除失败",
  toastReloaded: "适配器已重新加载",
  toastReloadFailed: "重新加载失败",
  toastReinstalled: "适配器已重新安装",
  toastReinstallFailed: "重新安装失败",

  // Titles
  titleReinstall: "重新安装适配器（从 npm 拉取最新）",
  titleReload: "重新加载适配器（热交换）",
  titleEnable: "在智能体菜单中显示",
  titleDisable: "从智能体菜单中隐藏",
  titlePauseOverride: "暂停外部覆盖",
  titleResumeOverride: "恢复外部覆盖",
  titleRemove: "移除适配器",
} as const;

/** SystemNotice 组件通用标签（tone 标签、详情按钮） */
export const systemNoticeLabels = {
  neutral: "系统通知",
  info: "系统通知",
  success: "系统通知",
  warning: "系统警告",
  danger: "系统警报",
  details: "详情",
  hideDetails: "隐藏详情",
} as const;

/** PropertiesPanel 右侧属性面板 */
export const propertiesPanelLabels = {
  title: "属性",
} as const;

/** 服务端元数据标题/标签中文映射（SystemNotice metadata 面板） */
export const systemNoticeMetaLabels: Record<string, string> = {
  "Required action": "所需操作",
  "Run evidence": "运行证据",
  "Recovery owner": "恢复负责人",
  "Source issue": "来源事务",
  "Recovery issue": "恢复事务",
  Assignee: "经办人",
  "Source assignee": "来源经办人",
  "Suggested action": "建议操作",
  "Missing disposition": "缺失事务处置",
  "Valid dispositions": "有效处置状态",
  "Successful run": "成功运行",
  "Run status": "运行状态",
  "Normalized cause": "归一化原因",
  "Detected progress": "检测到进展",
  "Automatic retry": "自动重试",
  "Source run": "来源运行",
  "Corrective handoff run": "修正交接运行",
  "Latest issue status": "最新事务状态",
  "Latest handoff run status": "最新交接运行状态",
  "clear_next_step": "明确下一步",
  "done, cancelled, in_review with an owner, blocked with blockers, delegated follow-up, or explicit continuation":
    "完成、取消、带负责人的评审中、带阻塞项的阻塞、委派后续工作，或明确继续",
  "one corrective handoff wake queued": "已排队 1 次修正交接唤醒",
  "successful_run_missing_state": "成功运行缺失状态",
  "choose and record a valid issue disposition without copying transcript content":
    "选择并记录有效的事务处置状态（不要复制转录内容）",
};

/** 与服务端 `summarizeRunFailureForIssueComment` 拼接的英文后缀一致（recovery / heartbeat） */
const SYSTEM_NOTICE_RUN_FAILURE_WITHHELD_EN =
  " Latest retry failure details were withheld from the issue thread; inspect the linked run for evidence.";
const SYSTEM_NOTICE_RUN_FAILURE_WITHHELD_ZH = "最新重试失败详情未写入事务讨论串，请查看关联运行取证。";
const SYSTEM_NOTICE_MOVE_BLOCKED_ZH = "已将该事务标为阻塞（`blocked`），便于人工介入。";

function assembleStrandedRecoveryNotice(mainZh: string, withheldSuffix: boolean): string {
  const mid = withheldSuffix ? SYSTEM_NOTICE_RUN_FAILURE_WITHHELD_ZH : "";
  return `${mainZh}${mid}${SYSTEM_NOTICE_MOVE_BLOCKED_ZH}`;
}

/** Markdown 或链路处理可能去掉状态码反引号；匹配时用统一形态 */
function normalizeSystemNoticeStatusBackticks(s: string): string {
  return s
    .replace(/`in_progress`/g, "in_progress")
    .replace(/`blocked`/g, "blocked")
    .replace(/`todo`/g, "todo");
}

/** `escalateStrandedAssignedIssue` 等在首段英文后追加 `- Recovery issue:` 等 Markdown 列表 */
function translateStrandedEscalationTail(tail: string): string {
  if (!tail.includes("- Recovery issue:")) return tail;
  let x = tail;
  x = x.replace(/\n\n- Recovery issue:/g, "\n\n- 恢复事务:");
  x = x.replace(/\n- Recovery owner:/g, "\n- 恢复负责人:");
  x = x.replace(/\n- Next action:/g, "\n- 建议下一步：");
  x = x.replace(
    "the recovery owner should either restore a live execution path or record the manual resolution, then mark the recovery issue done.",
    "恢复负责人应恢复在线执行路径，或记录人工处理结论，然后将恢复事务标为完成。",
  );
  x = x.replace(
    "none created because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
    "未创建恢复事务：回形针找不到可用的管理者、创建者或高管经办人（预算可用）。",
  );
  x = x.replace(
    "a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
    "看板操作者应指定可用的恢复负责人、修复智能体或运行时状态，或记录有意的人工处理结论。",
  );
  return x;
}

/** 事务处置提示 — 系统通知 body 中文映射 */
export const dispositionNotice = {
  requiredBody: "回形针需要在该事务上指定处置状态后才能继续。",
  exhaustedBody: "回形针无法自动解决缺失的处置状态。该事务已被恢复负责人阻塞。",
  missingDispositionTitle: "缺失事务处置",
  /** 将服务端返回的英文 body 映射为中文，不匹配则原样返回 */
  translateBody: (body: string) => {
    const t = body.trim();
    if (t === "Paperclip needs a disposition before this issue can continue.") return dispositionNotice.requiredBody;
    if (t === "Paperclip could not resolve this issue's missing disposition automatically. The issue is blocked on a recovery owner.") return dispositionNotice.exhaustedBody;
    if (t.startsWith("## This issue still needs a next step")) return "该事务仍需下一步操作。";
    if (t.startsWith("## Successful run missing issue disposition")) return "运行成功完成但缺少事务处置状态。";
    if (t.startsWith("## Run finished without a next step")) return "运行已完成但未指定下一步。";
    if (t.startsWith("Paperclip exhausted the bounded successful-run handoff correction")) return "回形针已耗尽有限的成功运行交接修正次数。";

    if (t === "Paperclip stopped automatic stranded-work recovery for this recovery issue.") {
      return "回形针已停止对本恢复事务的自动滞留作业恢复。";
    }

    const recoveryTailIdx = t.indexOf("\n\n- Recovery issue:");
    const headPart = recoveryTailIdx >= 0 ? t.slice(0, recoveryTailIdx).trim() : t;
    const recoveryTailPart = recoveryTailIdx >= 0 ? t.slice(recoveryTailIdx) : "";

    const withheldSuffix = headPart.includes(SYSTEM_NOTICE_RUN_FAILURE_WITHHELD_EN);
    const core = withheldSuffix
      ? headPart.replace(SYSTEM_NOTICE_RUN_FAILURE_WITHHELD_EN, "").trim()
      : headPart;
    const coreNorm = normalizeSystemNoticeStatusBackticks(core);

    const attachTail = (zh: string) => zh + translateStrandedEscalationTail(recoveryTailPart);

    if (
      coreNorm ===
      "Paperclip automatically retried continuation for this assigned in_progress issue and the retry made progress, but it still has no live execution path. Moving it to blocked so it is visible for intervention."
    ) {
      return attachTail(
        assembleStrandedRecoveryNotice(
          "回形针对该 `in_progress` 经办事务自动重试了延续执行，重试有进展但仍无在线执行路径。",
          false,
        ),
      );
    }

    const continuationDisappearedPrefix =
      "Paperclip automatically retried continuation for this assigned in_progress issue after its live execution disappeared, but it still has no live execution path.";
    const continuationDisappearedSuffix = " Moving it to blocked so it is visible for intervention.";
    if (coreNorm.startsWith(continuationDisappearedPrefix) && coreNorm.endsWith(continuationDisappearedSuffix)) {
      return attachTail(
        assembleStrandedRecoveryNotice(
          "回形针对该 `in_progress` 经办事务在其在线执行路径消失后自动重试了延续执行，但仍无在线执行路径。",
          withheldSuffix,
        ),
      );
    }

    const todoLostWakePrefix =
      "Paperclip automatically retried dispatch for this assigned todo issue after a lost wake/run, but it still has no live execution path.";
    const todoLostWakeSuffix = " Moving it to blocked so it is visible for intervention.";
    if (coreNorm.startsWith(todoLostWakePrefix) && coreNorm.endsWith(todoLostWakeSuffix)) {
      return attachTail(
        assembleStrandedRecoveryNotice(
          "回形针对该 `todo` 待办事务在唤醒或运行丢失后自动重试了派发，但仍无在线执行路径。",
          withheldSuffix,
        ),
      );
    }

    const todoTerminalPrefix =
      "Paperclip automatically retried dispatch for this assigned todo issue during terminal run recovery, but it still has no live execution path.";
    const todoTerminalSuffix = " Moving it to blocked so it is visible for intervention.";
    if (coreNorm.startsWith(todoTerminalPrefix) && coreNorm.endsWith(todoTerminalSuffix)) {
      return attachTail(
        assembleStrandedRecoveryNotice(
          "回形针对该 `todo` 待办事务在终端运行恢复流程中自动重试了派发，但仍无在线执行路径。",
          withheldSuffix,
        ),
      );
    }

    const inProgressTerminalPrefix =
      "Paperclip automatically retried continuation for this assigned in_progress issue during terminal run recovery, but it still has no live execution path.";
    const inProgressTerminalSuffix = " Moving it to blocked so it is visible for intervention.";
    if (coreNorm.startsWith(inProgressTerminalPrefix) && coreNorm.endsWith(inProgressTerminalSuffix)) {
      return attachTail(
        assembleStrandedRecoveryNotice(
          "回形针对该 `in_progress` 经办事务在终端运行恢复流程中自动重试了延续执行，但仍无在线执行路径。",
          withheldSuffix,
        ),
      );
    }

    return body;
  },
} as const;

/** IssueProperties 右侧属性面板 */
export const issuePropertiesPage = {
  // PropertyRow labels
  status: "状态",
  priority: "优先级",
  labels: "标签",
  assignee: "经办人",
  model: "模型",
  project: "项目",
  parent: "父事务",
  blockedBy: "阻塞于",
  blocking: "阻塞中",
  subIssues: "子事务",
  addSubIssue: "添加子事务",
  relatedTasks: "相关任务",
  reviewers: "审查者",
  approvers: "审批者",
  execution: "执行",
  scheduledRetry: "计划重试",
  monitor: "监控",
  depth: "深度",
  service: "服务",
  workspace: "工作区",
  viewWorkspace: "查看工作区",
  branch: "分支",
  folder: "文件夹",
  createdBy: "创建者",
  started: "开始于",
  completed: "已完成",
  created: "创建于",
  updated: "更新于",

  // Common button/tooltip
  copied: "已复制！",
  clickToCopy: "点击复制",
  noLabels: "无标签",
  addLabelAria: "添加标签",
  searchLabels: "搜索标签…",
  newLabelPlaceholder: "新标签名称",
  creatingLabel: "创建中…",
  createLabel: "创建标签",

  // Assignee
  unassigned: "未分配",
  noAssignee: "无经办人",
  assignToMe: "分配给我",
  assignTo: (name: string) => `分配给 ${name}`,
  searchAssignees: "搜索经办人…",
  requester: "请求者",

  // Project
  noProject: "无项目",
  searchProjects: "搜索项目…",

  // Parent issue
  noParent: "无父事务",
  searchIssues: "搜索事务…",

  // Blocked by
  noBlockers: "无阻塞",
  addBlocker: "添加阻塞",

  // Execution participants
  none: "无",
  user: "用户",
  runReviewNow: "立即执行审查",
  runApprovalNow: "立即执行审批",
  reviewStage: "审查",
  approvalStage: "审批",
  requestedChanges: "请求变更",
  bySeparator: " 由 ",
  pendingStatus: "待处理",
  withSeparator: " 与 ",
  searchReviewers: "搜索审查者…",
  searchApprovers: "搜索审批者…",
  noReviewers: "无审查者",
  noApprovers: "无审批者",

  // Monitor
  nextCheck: "下次检查",
  cleared: "已清除",
  lastTriggered: "最后触发",
  notScheduled: "未调度",
  monitorPlaceholder: "代理应重新检查什么？",
  externalServicePlaceholder: "外部服务",
  schedule: "调度",
  clear: "清除",

  /** 监控徽章：已成功触发次数（侧栏简短展示） */
  monitorAttemptBadge: (n: number) => `${n} 次触发`,

  // Retry — 事务侧栏「计划重试」展开文案
  attempt: "尝试",
  pendingSchedule: "等待调度",
  continuation: "继续执行",
  retry: "重试",
  dueNow: " 到期",
  scheduledContinuation: "计划继续执行",
  reason: "原因",
  nextAttempt: "下次尝试",
  replacesRun: "替换运行",
  agent: "智能体",
  lastError: "最后错误",
  retrying: "重试中…",
  retryNow: "立即重试",
  alreadyPromoted: "已提升",
  promoted: "已提升",
  promotingRetry: "提升计划重试中…",
  alreadyPromotedRunning: "已提升 — 运行启动中",
  promotedRunning: "已提升 — 运行启动中",
  pullContinuationForward: "立即提前继续执行",
  pullRetryForward: "立即提前重试",

  removeBlockerTitle: "移除阻塞？",
  removeBlockerDescription: (label: string) => `将 ${label} 从该事务的阻塞列表中移除。`,
  cancel: "取消",
  removeBlockerBtn: "移除阻塞",
} as const;

/** `IssueWorkspaceCard`：事务详情侧栏「执行工作区」卡片（下拉与说明） */
export const issueWorkspaceCardUi = {
  copied: "已复制！",
  copy: "复制",

  workspaceMode: {
    isolated_workspace: "隔离工作区",
    operator_branch: "操作者分支",
    cloud_sandbox: "云沙箱",
    adapter_managed: "适配器托管",
    fallback: "工作区",
  },

  configuredSelection: {
    projectDefault: "项目默认",
    newIsolated: "新建隔离工作区",
    reuseExisting: "复用已有工作区",
    existingIsolated: "已有隔离工作区",
  },

  workspaceStatusBadge: {
    active: "活跃",
    idle: "空闲",
    in_review: "审查中",
    archived: "已归档",
  },

  cancel: "取消",
  save: "保存",
  edit: "编辑",

  repoPrefix: "仓库：",
  environmentPrefix: "环境：",
  envNoteReusedWorkspace: " · 复用工作区的环境",
  envNoteProjectDefault: " · 项目默认",

  runHintFreshIsolated: "首次运行时会为此事务新建隔离工作区。",
  runHintReuse: "运行时将复用已有工作区。",
  runHintProjectDefault: "运行时将沿用项目的默认工作区配置。",

  reusingHeading: "复用：",

  viewDetails: "查看工作区详情",
  viewDetailsSuffix: " →",

  placeholderPickWorkspace: "请选择已有工作区…",

  envOptionNoBindingOnReuse: "复用的工作区未绑定环境",
  envOptionPickWorkspaceFirst: "请先选择已有工作区以查看其环境",
  envOptionProjectDefault: "项目默认环境",
  envOptionNone: "无环境",

  envLockedWhileReusingDetail:
    "正在复用工作区：环境不可改；下次运行将沿用该工作区已保存的环境绑定。",

  envPickWorkspaceFirstDetail: "请先选定要复用的工作区；其环境以工作区持久化配置为准。",

  currentHeading: "当前：",

  /** `Environment.driver` 下拉展示（名称后的类型徽记） */
  environmentDriverLabels: {
    local: "本地",
    ssh: "SSH",
    sandbox: "沙箱",
  },
} as const;

export function formatEnvironmentDriverLabel(driver: string): string {
  const map = issueWorkspaceCardUi.environmentDriverLabels as Record<string, string>;
  return map[driver] ?? driver;
}

export function formatExecutionWorkspaceBadgeStatus(status: string): string {
  const zh = issueWorkspaceCardUi.workspaceStatusBadge[status as keyof typeof issueWorkspaceCardUi.workspaceStatusBadge];
  if (zh) return zh;
  return status.replace(/_/g, " ");
}

/** 思考努力程度选项 */
export const thinkingEffortOptions = {
  default: "默认",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  /** 根据适配器类型返回选项数组 */
  forAdapter: (adapterType: string | null | undefined) => {
    const isCodex = adapterType?.includes("codex");
    const isOpenCode = adapterType === "opencode_local";
    const options: string[] = [thinkingEffortOptions.default];
    if (!isCodex) {
      // claude_local: low, medium, high
      options.push(thinkingEffortOptions.low, thinkingEffortOptions.medium, thinkingEffortOptions.high);
    } else {
      // codex_local: minimal, low, medium, high, xhigh
      options.push(thinkingEffortOptions.minimal, thinkingEffortOptions.low, thinkingEffortOptions.medium, thinkingEffortOptions.high, thinkingEffortOptions.xhigh);
    }
    if (isOpenCode) {
      // opencode_local 额外加 max
      options.push(thinkingEffortOptions.max);
    }
    return options;
  },
} as const;

/** assigneeOptions 触发器文案 */
export const assigneeOptionsLabels = {
  cheapModel: "廉价模型",
  custom: "自定义",
  adapterOptionsSuffix: " 适配器选项",
  primaryModel: "主模型",
  modelLane: "模型通道",
  primary: "主模型",
  cheap: "廉价",
  customLane: "自定义",
  sendsDesc: "发送",
  adapterDefault: "适配器默认",
  usesCheapProfile: "使用智能体配置的廉价档案",
  fallsBackPrimary: "未配置档案时回退到主模型",
  model: "模型",
  defaultModel: "默认模型",
  searchModels: "搜索模型…",
  noModelsFound: "未找到模型。",
  thinkingEffort: "思考努力程度",
  enableChrome: "启用 Chrome (--chrome)",
  noEditableOverrides: "该经办人的适配器未暴露可编辑的事务覆盖。",
  selectCompatibleAgent: "请选择兼容的代理人以编辑这些覆盖。",
  clearAdapterOptions: "清除适配器选项",
} as const;

/** Activity 活动页 */
export const activityPage = {
  breadcrumb: "活动",
  selectCompany: "请选择公司以查看活动。",
  filterPlaceholder: "按类型筛选",
  allTypes: "全部类型",
  noActivity: "暂无活动。",
  entityTypeLabels: {
    issue: "事务",
    agent: "智能体",
    project: "项目",
    goal: "目标",
    approval: "审批",
    heartbeat_run: "心跳运行",
    approval_run: "审批运行",
    routine: "例程",
    routine_trigger: "例程触发器",
    routine_run: "例程运行",
    environment: "环境",
    environment_lease: "环境租约",
    company: "公司",
    cost: "成本",
    heartbeat: "心跳",
    join_request: "加入请求",
  },
} as const;

/** ActivityRow 组件 */
export const activityRowLabels = {
  system: "系统",
  unknown: "未知",
  board: "面板",
} as const;

/** 运行状态标签 — 用于聊天卡片和活动页 */
export const runStatusLabels = {
  workedFor: (d: string) => `运行了 ${d}`,
  finishedWork: "运行完成",
  failedAfter: (d: string) => `${d} 后失败`,
  runFailed: "运行失败",
  timedOutAfter: (d: string) => `${d} 后超时`,
  runTimedOut: "运行超时",
  pausedByBoardAfter: (d: string) => `被面板暂停（运行了 ${d}）`,
  pausedByBoard: "被面板暂停",
  cancelledAfter: (d: string) => `${d} 后取消`,
  runCancelled: "运行已取消",
  queued: "排队中",
  working: "运行中…",
} as const;

/** Activity 动词映射 — 行级（简洁动词） */
export const activityVerbs: Record<string, string> = {
  "issue.created": "创建了",
  "issue.updated": "更新了",
  "issue.checked_out": "签出了",
  "issue.released": "释放了",
  "issue.comment_added": "评论了",
  "issue.comment_cancelled": "取消了排队的评论于",
  "issue.attachment_added": "上传了附件到",
  "issue.attachment_removed": "从…移除了附件",
  "issue.document_created": "为…创建了文档",
  "issue.document_updated": "更新了…的文档",
  "issue.document_deleted": "从…删除了文档",
  "issue.monitor_scheduled": "为…安排了监控",
  "issue.monitor_triggered": "触发了…的监控",
  "issue.monitor_cleared": "清除了…的监控",
  "issue.monitor_skipped": "跳过了…的监控",
  "issue.monitor_exhausted": "耗尽了…的监控",
  "issue.monitor_recovery_wake_queued": "排队监控恢复于",
  "issue.monitor_recovery_issue_created": "为…创建了监控恢复",
  "issue.monitor_escalated_to_board": "将…的监控升级到面板",
  "issue.commented": "评论了",
  "issue.deleted": "删除了",
  "issue.successful_run_handoff_required": "标记缺少下一步于",
  "issue.successful_run_handoff_resolved": "记录了已选择的下一步于",
  "issue.successful_run_handoff_escalated": "升级了缺少的下一步于",
  "agent.created": "创建了",
  "agent.updated": "更新了",
  "agent.paused": "暂停了",
  "agent.resumed": "恢复了",
  "agent.terminated": "终止了",
  "agent.key_created": "为…创建了 API 密钥",
  "agent.budget_updated": "更新了…的预算",
  "agent.runtime_session_reset": "重置了…的会话",
  "heartbeat.invoked": "调用了…的心跳",
  "heartbeat.cancelled": "取消了…的心跳",
  "approval.created": "请求了审批",
  "approval.approved": "批准了",
  "approval.rejected": "拒绝了",
  "project.created": "创建了",
  "project.updated": "更新了",
  "project.deleted": "删除了",
  "goal.created": "创建了",
  "goal.updated": "更新了",
  "goal.deleted": "删除了",
  "cost.reported": "上报了成本于",
  "cost.recorded": "记录了成本于",
  "company.created": "创建了公司",
  "company.updated": "更新了公司",
  "company.archived": "归档了公司",
  "company.budget_updated": "更新了公司的预算",
  "environment.created": "创建了环境",
  "environment.updated": "更新了环境",
  "environment.deleted": "删除了环境",
  "environment.probed": "探测了环境",
  "environment.lease_created": "创建了环境租约",
  "environment.lease_acquired": "获取了环境租约",
  "environment.lease_released": "释放了环境租约",
  "environment.lease_expired": "环境租约已过期",
  "environment.lease_failed": "环境租约失败",
};

/** Activity 标签 — 事务详情面板内使用（完整句子） */
export const activityLabels: Record<string, string> = {
  "issue.created": "创建了事务",
  "issue.updated": "更新了事务",
  "issue.checked_out": "签出了事务",
  "issue.released": "释放了事务",
  "issue.comment_added": "添加了一条评论",
  "issue.comment_cancelled": "取消了一条排队评论",
  "issue.feedback_vote_saved": "保存了对 AI 输出的反馈",
  "issue.attachment_added": "添加了一个附件",
  "issue.attachment_removed": "移除了一个附件",
  "issue.document_created": "创建了一个文档",
  "issue.document_updated": "更新了一个文档",
  "issue.document_deleted": "删除了一个文档",
  "issue.monitor_scheduled": "安排了一个监控",
  "issue.monitor_triggered": "触发了一个监控",
  "issue.monitor_cleared": "清除了一监控",
  "issue.monitor_skipped": "跳过了一个监控",
  "issue.monitor_exhausted": "耗尽了一个监控",
  "issue.monitor_recovery_wake_queued": "排队了一个监控恢复唤醒",
  "issue.monitor_recovery_issue_created": "创建了一个监控恢复事务",
  "issue.monitor_escalated_to_board": "将一个监控升级到面板",
  "issue.deleted": "删除了事务",
  "issue.successful_run_handoff_required": "运行完成但未明确下一步",
  "issue.successful_run_handoff_resolved": "已选择下一步",
  "issue.successful_run_handoff_escalated": "运行完成但未明确下一步 — 已恢复负责人处理",
  "agent.created": "创建了智能体",
  "agent.updated": "更新了智能体",
  "agent.paused": "暂停了智能体",
  "agent.resumed": "恢复了智能体",
  "agent.terminated": "终止了智能体",
  "heartbeat.invoked": "调用了一个心跳",
  "heartbeat.cancelled": "取消了一个心跳",
  "approval.created": "请求了审批",
  "approval.approved": "已批准",
  "approval.rejected": "已拒绝",
};

/** Activity 结构化变更文案 */
export const activityChangeLabels = {
  blocker: "阻塞",
  blockers: "阻塞项",
  reviewer: "审查者",
  reviewers: "审查者",
  approver: "审批者",
  approvers: "审批者",
  added: "添加了",
  removed: "移除了",
  updated: "更新了",
  changedStatusFrom: (from: string, to: string) => `状态从 ${from} 变更为 ${to} 于`,
  changedStatusTo: (to: string) => `状态变更为 ${to} 于`,
  changedPriorityFrom: (from: string, to: string) => `优先级从 ${from} 变更为 ${to} 于`,
  changedPriorityTo: (to: string) => `优先级变更为 ${to} 于`,
  changedTheStatusFrom: (from: string, to: string) => `状态从 ${from} 变更为 ${to}`,
  changedTheStatusTo: (to: string) => `状态变更为 ${to}`,
  changedThePriorityFrom: (from: string, to: string) => `优先级从 ${from} 变更为 ${to}`,
  changedThePriorityTo: (to: string) => `优先级变更为 ${to}`,
  assignedTo: (name: string) => `分配事务给 ${name}`,
  unassigned: "取消分配事务",
  updatedTitle: "更新了标题",
  updatedDescription: "更新了描述",
  agent: "智能体",
  board: "面板",
  you: "你",
  issue: "事务",
} as const;

/**
 * 事务详情讨论串 / 评论区（`IssueChatThread`）。
 * 流程见 docs/项目计划/最佳实践/011-实践-回形针UI页面汉化流程.md
 */
export const issueChatThreadUi = {
  authorAgent: "智能体",
  authorYou: "你",
  authorUser: "用户",
  authorSystem: "系统",
  authorBoard: "董事会",

  assigneeFallbackUnassigned: "未分配",

  pausedBudgetReason: "因预算硬停而暂停。",
  pausedSystemReason: "已由系统暂停。",
  pausedManualReason: "已手动暂停。",
  /** 接在经办人姓名后：「xxx」+ pausedAfterName + 具体原因句 */
  pausedAfterName: "已暂停。恢复前不会发起新的运行。",

  fallbackRendererErrorTitle: "讨论渲染遇到内部状态错误。",
  fallbackRendererErrorBody: "已改为安全回退视图，避免事务页崩溃。",
  fallbackNoMessageContent: "无消息内容。",

  humanizeNone: "无",

  runStatusTimedOut: "已超时",

  cotWorking: "进行中",
  cotWorked: "已完成",
  cotDurationFor: (duration: string) => `历时 ${duration}`,

  toolSummaryRanCommands: (n: number) => `执行了 ${n} 条命令`,
  toolSummaryCalledTools: (n: number) => `调用了 ${n} 个工具`,

  toolSectionInput: "输入",
  toolSectionResult: "结果",

  copy: "复制",
  copyMessage: "复制消息",
  copyMessageAriaLabel: "复制消息",
  copyLinkTitle: "复制链接",
  copyLinkAriaLabel: "复制指向系统通知的链接",
  copyNoticeTitle: "复制通知正文",
  copyNoticeAriaLabel: "复制系统通知",

  moreActionsTitle: "更多操作",
  moreActionsAriaLabel: "更多操作",

  queueBadgeDeferredWake: "暂缓唤醒",
  queueBadgeQueued: "排队中",
  badgeFollowUp: "跟进",
  interruptButton: "中断",
  interruptingButton: "正在中断…",
  cancelQueuedComment: "取消",
  sendingComment: "发送中…",

  assistantRunningBadge: "运行中",
  viewRun: "查看运行",

  stopRunDefault: "停止运行",
  stoppingRunDefault: "正在停止…",

  feedbackHelpful: "有帮助",
  feedbackNeedsWork: "仍需改进",
  feedbackDownvotePrompt: "哪里可以做得更好？",
  feedbackDownvotePlaceholder: "写一句简短备注",
  feedbackDismiss: "关闭",
  feedbackSaving: "保存中…",
  feedbackSaveNote: "保存备注",
  feedbackSharingDialogTitle: "保存反馈数据共享偏好",
  feedbackSharingDialogIntro:
    "选择是否允许将已投票的 AI 输出共享给 Paperclip Labs。该选择将作为之后点赞与点踩的默认偏好。",
  feedbackSharingLocalNote: "本次投票仍会保存在本地。",
  feedbackSharingChoices:
    "选择「始终允许」以共享本次及今后的投票及相关 AI 输出；选择「不允许」则本条及今后的投票均仅保存在本地。",
  feedbackSharingSettingsHint: "之后可在「实例设置 → 常规」中修改。",
  feedbackReadTerms: "阅读服务条款",
  feedbackDontAllow: "不允许",
  feedbackAlwaysAllow: "始终允许",

  composerDropTitle: "拖放以上传",
  composerDropHint: "图片会插入到本条回复；其他文件会作为本事务的附件添加。",
  composerReplyPlaceholder: "回复…",
  composerUploadingToIssue: "正在上传到事务",
  composerUploadFailed: "上传失败",
  composerInsertedInline: "已内联插入",
  composerAttachedToIssue: "已附加到事务",
  composerAttachFileTitle: "附加文件",
  composerMoreOptionsTitle: "更多输入选项",
  composerSwitchToStandard: "切换为标准模式",
  composerSwitchToPlanning: "切换为规划模式",
  composerPlanningModeTitle: "本次提交处于规划模式，点击可切回标准模式。",
  composerPlanningBadge: "规划",
  composerAssigneePlaceholder: "经办人",
  composerNoAssignee: "无经办人",
  composerSearchAssignees: "搜索经办人…",
  composerNoAssigneesFound: "未找到经办人",
  composerAssigneeTriggerEmpty: "经办人",
  composerPosting: "发送中…",
  composerSend: "发送",
  composerFileTypeNotAttachable: "无法在此附加该文件类型",

  expiredRowUpdatedTask: "更新了此事务",
  expiredRowHideConfirmation: "收起确认",
  expiredRowShowExpiredConfirmation: "已过期确认",

  emptyEmbeddedDefault: "尚无运行输出。",
  emptyFullDefault: "此事务暂无讨论，可在下方发送消息开始。",
  emptyEmbeddedWaitingOutput: "等待运行输出…",
  emptyEmbeddedNoOutput: "未捕获运行输出。",

  jumpToLatest: "跳到最新",

  staleDispositionNoExtraDetails: "暂无更多详情。",

  timelineEventUpdatedTaskVerb: "更新了此事务",
  timelineEventRequestedFollowUpVerb: "请求了跟进",
  timelineLabelStatus: "状态",
  timelineLabelAssignee: "经办人",
  timelineLabelWorkspace: "工作区",

  runRowVerbRun: "运行",

  toastNoAssigneeSelectedTitle: "未选择经办人",
  toastNoAssigneeSelectedBody: "请选择经办人，或再次点击「发送」以不设经办人直接发布。",
} as const;

/** 事务线程交互卡片：`IssueThreadInteractionCard`（建议任务 / 问答 / 确认含计划卡片） */
export const issueThreadInteractionCardUi = {
  actorBoard: "董事会",
  actorUnknown: "未知",

  statusPending: "待处理",
  statusAccepted: "已接受",
  statusRejected: "已拒绝",
  statusAnswered: "已作答",
  statusCancelled: "已取消",
  statusExpired: "已过期",
  statusFailed: "失败",

  kindSuggestTasks: "建议任务",
  kindAskQuestions: "向操作者提问",
  kindConfirmation: "确认请求",

  childTaskBadge: "子任务",
  includeDraftAriaLabel: (title: string) => `包含草稿「${title}」`,
  skipped: "已跳过",

  taskFieldAssignee: "经办人",
  taskFieldBilling: "计费编码",
  taskFieldProject: "项目",
  taskFieldLabel: "标签",
  hiddenFollowOnOne: "预览中另有 1 条后续任务已折叠",
  hiddenFollowOnMany: (n: number) => `预览中另有 ${n} 条后续任务已折叠`,

  suggestDraftIssuesOne: "1 个草稿事务",
  suggestDraftIssuesMany: (n: number) => `${n} 个草稿事务`,
  suggestDefaultParent: "默认父事务",

  resolutionSummaryTitle: "处理结果摘要",
  resolutionCreatedPartial: (created: number, skipped: number) =>
    `审核后已创建 ${created} 条草稿事务，跳过 ${skipped} 条。`,
  resolutionCreatedAll: (count: number) => `已创建全部 ${count} 条草稿事务。`,

  rejectionReasonTitle: "拒绝原因",
  noReasonProvided: "未填写原因。",

  suggestSelectionAllSelected: (total: number) => `已全选 ${total} 条草稿事务`,
  suggestSelectionPartial: (selected: number, total: number) =>
    `已选 ${selected} / ${total} 条草稿事务`,
  suggestSkippedOnAcceptSuffix: "若确认，未被选中的项将跳过。",

  accepting: "正在接受…",
  acceptDraftsAll: "接受全部草稿",
  acceptDraftsSelected: "接受所选草稿",
  reject: "拒绝",
  rejectingPlaceholder: "简要说明为何拒绝这组建议…",
  saving: "正在保存…",
  saveRejection: "保存拒绝",

  resetSelection: "重置选择",

  questionKindChip: "向操作者提问",
  questionCountOne: "1 个问题",
  questionCountMany: (n: number) => `${n} 个问题`,
  questionNumber: (n: number) => `问题 ${n}`,
  pickSingle: "单选",
  pickMulti: "多选",
  required: "必选",
  optional: "可选",
  /** 问答表单脚注 */
  submitFormHint: "完成全部题目后可一次性提交。",
  cancelQuestion: "取消提问",
  cancelling: "正在取消…",
  submitting: "正在提交…",
  submitAnswers: "提交回答",
  questionCancelledTitle: "提问已取消",
  noCancellationReason: "未记录作答。",
  noAnswerRecorded: "未记录回答。",
  answerFieldLabel: "回答",
  submittedSummaryTitle: "已提交的摘要",

  planDocumentChipPrefix: "计划",

  continuationWakeOnConfirm: "确认后唤醒",
  continuationWakeAssignee: "唤醒经办人",

  defaultTitleSuggestedTaskTree: "建议任务树",
  defaultTitleQuestionsOperator: "给操作者的问题",
  defaultTitleConfirmationRequested: "请求确认",

  footerProposedBy: (name: string) => `${name} 发起`,
  /** 接在 Tooltip 正文里：`创建于` + 日期时间（由调用方拼接） */
  tooltipCreatedPrefix: "创建于",

  /** 句式：「由 [name 高亮] 于 [日期] 处理」「由 [name] 处理」 */
  footerResolvedByPrefixWord: "由",
  footerResolvedAtWord: "于",
  footerResolvedVerb: "处理",

  requestConfirmationConfirmed: "已确认",
  requestConfirmationDeclined: "已拒绝",
  expiredByCommentTitle: "因评论失效",
  expiredByTargetTitle: "因目标变更失效",
  expiredByCommentBody: "在未处理前，看板留言已推翻并取代此确认请求。",
  expiredByTargetBody: "在未处理前，所请求的确认对象已发生变化。",
  jumpToComment: "跳到该评论",

  failedRequestBody: "此确认请求未能完成处理。请重试或发起新的请求。",

  confirming: "正在确认…",
  defaultConfirm: "确认",
  defaultDecline: "拒绝",
  /** 占位符：`acceptLabel` 为服务端英文 「Approve plan」 时仍可匹配专用文案 */
  declinePlaceholderApprovePlan: "选填：希望计划做哪些修订？",
  declinePlaceholderGeneric: "选填：告诉智能体你希望改什么。",

  declineReasonRequired: "拒绝时必须填写原因。",
  cancelDecline: "取消拒绝",
  tryAgainHint: "请重试",
} as const;
