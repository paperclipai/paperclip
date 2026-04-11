import { issueStatusLegendLabel } from "./dashboard-copy";

type RoutinesCopyLocale = string | null | undefined;

const routinesCopy = {
  en: {
    routines: "Routines",
    recentRuns: "Recent Runs",
    selectCompany: "Select a company to view routines.",
    description: "Recurring work definitions that materialize into auditable execution issues.",
    createRoutine: "Create routine",
    group: "Grouping",
    project: "Project",
    agent: "Agent",
    none: "None",
    newRoutine: "New routine",
    setupHint: "Define the recurring work first. Trigger setup comes next on the detail page.",
    cancel: "Cancel",
    routineTitle: "Routine title",
    for: "For",
    assignee: "Assignee",
    noAssignee: "No assignee",
    searchAssignees: "Search assignees...",
    noAssigneesFound: "No assignees found.",
    in: "in",
    projectPlaceholder: "Project",
    noProject: "No project",
    searchProjects: "Search projects...",
    noProjectsFound: "No projects found.",
    addInstructions: "Add instructions...",
    advancedDeliverySettings: "Advanced delivery settings",
    advancedDeliveryHint: "Keep policy controls secondary to the work definition.",
    concurrency: "Concurrency",
    catchUp: "Catch-up",
    creationHint: "After creation, Paperclip takes you straight to trigger setup for schedules, webhooks, or internal runs.",
    creating: "Creating...",
    failedCreateRoutine: "Failed to create routine",
    failedLoadRoutines: "Failed to load routines",
    noRoutinesYet: "No routines yet. Use Create routine to define the first recurring workflow.",
    archived: "Archived",
    paused: "paused",
    unknownProject: "Unknown project",
    unknownAgent: "Unknown agent",
    never: "Never",
    on: "On",
    off: "Off",
    edit: "Edit",
    running: "Running...",
    runNow: "Run now",
    pause: "Pause",
    enable: "Enable",
    restore: "Restore",
    archive: "Archive",
    routineCreated: "Routine created",
    firstTriggerHint: "Add the first trigger to turn it into a live workflow.",
    routineUpdateFailed: "Failed to update routine",
    routineUpdateFailedBody: "Paperclip could not update the routine.",
    routineRunFailed: "Routine run failed",
    routineRunFailedBody: "Paperclip could not start the routine run.",
    disablePrefix: "Disable",
    enablePrefix: "Enable",
    moreActionsPrefix: "More actions for",
  },
  "zh-CN": {
    routines: "例行任务",
    recentRuns: "最近运行",
    selectCompany: "请选择一个公司以查看例行任务。",
    description: "定义会周期性执行的工作，并沉淀为可审计的执行任务。",
    createRoutine: "创建例行任务",
    group: "分组",
    project: "项目",
    agent: "Agent",
    none: "无",
    newRoutine: "新建例行任务",
    setupHint: "先定义重复工作本身，触发器配置会在详情页继续完成。",
    cancel: "取消",
    routineTitle: "例行任务标题",
    for: "给",
    assignee: "负责人",
    noAssignee: "未分配",
    searchAssignees: "搜索负责人…",
    noAssigneesFound: "没有找到负责人。",
    in: "在",
    projectPlaceholder: "项目",
    noProject: "无项目",
    searchProjects: "搜索项目…",
    noProjectsFound: "没有找到项目。",
    addInstructions: "补充说明…",
    advancedDeliverySettings: "高级投递设置",
    advancedDeliveryHint: "把策略控制放在次要位置，优先定义工作内容。",
    concurrency: "并发",
    catchUp: "补跑策略",
    creationHint: "创建完成后，Paperclip 会直接带你进入触发器配置，用于定时、Webhook 或内部运行。",
    creating: "创建中…",
    failedCreateRoutine: "创建例行任务失败",
    failedLoadRoutines: "加载例行任务失败",
    noRoutinesYet: "还没有例行任务。使用“创建例行任务”来定义第一个重复工作流。",
    archived: "归档",
    paused: "已暂停",
    unknownProject: "未知项目",
    unknownAgent: "未知 Agent",
    never: "从未运行",
    on: "开启",
    off: "关闭",
    edit: "编辑",
    running: "运行中…",
    runNow: "立即运行",
    pause: "暂停",
    enable: "启用",
    restore: "恢复",
    archive: "归档",
    routineCreated: "已创建例行任务",
    firstTriggerHint: "继续添加第一个触发器，把它变成真正运行的工作流。",
    routineUpdateFailed: "更新例行任务失败",
    routineUpdateFailedBody: "Paperclip 无法更新这个例行任务。",
    routineRunFailed: "例行任务运行失败",
    routineRunFailedBody: "Paperclip 无法启动这次例行任务运行。",
    disablePrefix: "停用",
    enablePrefix: "启用",
    moreActionsPrefix: "",
  },
} as const;

function resolveLocale(locale: RoutinesCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getRoutinesCopy(locale: RoutinesCopyLocale) {
  return routinesCopy[resolveLocale(locale)];
}

export function formatRoutineProjectGroupLabel(
  key: string,
  projectById: Map<string, { name: string }>,
  locale: RoutinesCopyLocale,
): string {
  const copy = getRoutinesCopy(locale);
  if (key === "__no_project") return copy.noProject;
  return projectById.get(key)?.name ?? copy.unknownProject;
}

export function formatRoutineAssigneeGroupLabel(
  key: string,
  agentById: Map<string, { name: string }>,
  locale: RoutinesCopyLocale,
): string {
  const copy = getRoutinesCopy(locale);
  if (key === "__unassigned") return copy.noAssignee;
  return agentById.get(key)?.name ?? copy.unknownAgent;
}

export function formatRoutineCount(count: number, locale: RoutinesCopyLocale): string {
  if (locale === "zh-CN") {
    return `${count} 个例行任务`;
  }
  return `${count} routine${count === 1 ? "" : "s"}`;
}

export function formatRoutineToggleAriaLabel(title: string, enabled: boolean, locale: RoutinesCopyLocale): string {
  const copy = getRoutinesCopy(locale);
  return `${enabled ? copy.disablePrefix : copy.enablePrefix} ${title}`;
}

export function formatRoutineMoreActionsLabel(title: string, locale: RoutinesCopyLocale): string {
  const copy = getRoutinesCopy(locale);
  return locale === "zh-CN" ? `${title} 的更多操作` : `${copy.moreActionsPrefix} ${title}`;
}

export function formatRoutineToggleState(isArchived: boolean, enabled: boolean, locale: RoutinesCopyLocale): string {
  const copy = getRoutinesCopy(locale);
  if (isArchived) return copy.archived;
  return enabled ? copy.on : copy.off;
}

export function formatRoutineRowStatus(isArchived: boolean, locale: RoutinesCopyLocale): string {
  const copy = getRoutinesCopy(locale);
  return isArchived ? copy.archived : copy.paused;
}

export function formatRoutineRunStatus(status: string | null | undefined, locale: RoutinesCopyLocale): string | null {
  if (!status) return null;
  return issueStatusLegendLabel(status, locale);
}

export function routinePolicyLabel(policy: string, locale: RoutinesCopyLocale): string {
  if (locale === "zh-CN") {
    return (
      {
        coalesce_if_active: "运行中时合并",
        always_enqueue: "始终入队",
        skip_if_active: "运行中时跳过",
        skip_missed: "跳过错过的窗口",
        enqueue_missed_with_cap: "限量补跑错过的窗口",
      }[policy] ?? policy.replaceAll("_", " ")
    );
  }
  return (
    {
      coalesce_if_active: "Coalesce if active",
      always_enqueue: "Always enqueue",
      skip_if_active: "Skip if active",
      skip_missed: "Skip missed windows",
      enqueue_missed_with_cap: "Catch up missed windows (capped)",
    }[policy] ?? policy.replaceAll("_", " ")
  );
}

export function routinePolicyDescription(policy: string, locale: RoutinesCopyLocale): string {
  if (locale === "zh-CN") {
    return (
      {
        coalesce_if_active: "如果已有运行在进行中，只保留一个后续待运行任务。",
        always_enqueue: "即使例行任务仍在运行，也为每次触发都创建排队任务。",
        skip_if_active: "当已有运行仍在进行时，丢弃新的触发。",
        skip_missed: "调度器或例行任务暂停期间错过的时间窗口将被忽略。",
        enqueue_missed_with_cap: "恢复后按上限分批补跑错过的调度窗口。",
      }[policy] ?? policy
    );
  }
  return (
    {
      coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
      always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
      skip_if_active: "Drop new trigger occurrences while a run is still active.",
      skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
      enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
    }[policy] ?? policy
  );
}
