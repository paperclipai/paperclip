import type { BudgetPolicySummary } from "@paperclipai/shared";

type CostsCopyLocale = string | null | undefined;

const costsCopy = {
  en: {
    costs: "Costs",
    selectCompany: "Select a company to view costs.",
    pageDescription: "Inference spend, platform fees, credits, and live quota windows.",
    overview: "Overview",
    budgets: "Budgets",
    providers: "Providers",
    billers: "Billers",
    finance: "Finance",
    to: "to",
    selectRange: "Select a start and end date to load data.",
    allProviders: "All providers",
    allBillers: "All billers",
    inferenceSpend: "Inference spend",
    budget: "Budget",
    financeNet: "Finance net",
    financeEvents: "Finance events",
    open: "Open",
    noMonthlyCapConfigured: "No monthly cap configured",
    financeLedger: "Finance ledger",
    financeLedgerDescription: "Account-level charges that do not map to a single inference request.",
    debits: "Debits",
    credits: "Credits",
    net: "Net",
    estimated: "Estimated",
    inferenceLedger: "Inference ledger",
    inferenceLedgerDescription: "Request-scoped inference spend for the selected period.",
    unlimitedBudget: "Unlimited budget",
    usage: "usage",
    byAgent: "By agent",
    byAgentDescription: "What each agent consumed in the selected period.",
    noCostEventsYet: "No cost events yet.",
    byProject: "By project",
    byProjectDescription: "Run costs attributed through project-linked issues.",
    noProjectCostsYet: "No project-attributed run costs yet.",
    unattributed: "Unattributed",
    noFinanceEventsYet: "No finance events yet. Add account-level charges once biller invoices or credits land.",
    budgetControlPlane: "Budget control plane",
    budgetControlPlaneDescription:
      "Hard-stop spend limits for agents and projects. Provider subscription quota stays separate and appears under Providers.",
    activeIncidents: "Active incidents",
    activeIncidentsDescription: "Open soft or hard threshold crossings",
    pendingApprovals: "Pending approvals",
    pendingApprovalsDescription: "Budget override approvals awaiting board action",
    pausedAgents: "Paused agents",
    pausedAgentsDescription: "Agent heartbeats blocked by budget",
    pausedProjects: "Paused projects",
    pausedProjectsDescription: "Project execution blocked by budget",
    activeIncidentsHeading: "Active incidents",
    activeIncidentsBody: "Resolve hard stops here by raising the budget or explicitly keeping the scope paused.",
    noBudgetPoliciesYet:
      "No budget policies yet. Set agent and project budgets from their detail pages, or use the existing company monthly budget control.",
    companyBudgets: "Company budgets",
    companyBudgetsDescription: "Company-wide monthly policy.",
    agentBudgets: "Agent budgets",
    agentBudgetsDescription: "Recurring monthly spend policies for individual agents.",
    projectBudgets: "Project budgets",
    projectBudgetsDescription: "Lifetime spend policies for execution-bound projects.",
    noCostEventsInPeriod: "No cost events in this period.",
    noBillableEventsInPeriod: "No billable events in this period.",
    byBiller: "By biller",
    byBillerDescription: "Account-level financial events grouped by who charged or credited them.",
    budgetCardObserved: "Observed",
    budgetCardBudget: "Budget",
    budgetCardRemaining: "Remaining",
    budgetCardNoCapConfigured: "No cap configured",
    budgetCardDisabled: "Disabled",
    budgetCardUnlimited: "Unlimited",
    budgetCardPausedStatus: "Paused",
    budgetCardWarningStatus: "Warning",
    budgetCardHardStopStatus: "Hard stop",
    budgetCardHealthyStatus: "Healthy",
    budgetCardBudgetUsdLabel: "Budget (USD)",
    budgetCardUpdateBudget: "Update budget",
    budgetCardSetBudget: "Set budget",
    budgetCardSaving: "Saving...",
    budgetCardInvalidDollarAmount: "Enter a valid non-negative dollar amount.",
    lifetimeBudget: "Lifetime budget",
    monthlyUtcBudget: "Monthly UTC budget",
    budgetCardProjectPaused:
      "Execution is paused for this project until the budget is raised or the incident is dismissed.",
    budgetCardScopePaused:
      "Heartbeats are paused for this scope until the budget is raised or the incident is dismissed.",
  },
  "zh-CN": {
    costs: "成本",
    selectCompany: "请选择一个公司以查看成本。",
    pageDescription: "推理支出、平台费用、余额与实时配额窗口。",
    overview: "总览",
    budgets: "预算",
    providers: "提供方",
    billers: "计费方",
    finance: "财务",
    to: "至",
    selectRange: "请选择开始和结束日期以加载数据。",
    allProviders: "全部提供方",
    allBillers: "全部计费方",
    inferenceSpend: "推理支出",
    budget: "预算",
    financeNet: "财务净额",
    financeEvents: "财务事件",
    open: "未设上限",
    noMonthlyCapConfigured: "未设置月度上限",
    financeLedger: "财务台账",
    financeLedgerDescription: "无法映射到单次推理请求的账户级费用。",
    debits: "支出",
    credits: "收入",
    net: "净额",
    estimated: "预估",
    inferenceLedger: "推理台账",
    inferenceLedgerDescription: "所选时间范围内按请求统计的推理支出。",
    unlimitedBudget: "预算不限",
    usage: "用量",
    byAgent: "按 Agent",
    byAgentDescription: "所选时间范围内各 Agent 的消耗情况。",
    noCostEventsYet: "还没有成本事件。",
    byProject: "按项目",
    byProjectDescription: "通过关联项目的任务归属到项目的运行成本。",
    noProjectCostsYet: "还没有归属到项目的运行成本。",
    unattributed: "未归属",
    noFinanceEventsYet: "还没有财务事件。待计费方账单或返还额度落地后，这里会展示账户级费用。",
    budgetControlPlane: "预算控制台",
    budgetControlPlaneDescription: "Agent 与项目的硬性支出上限。供应商订阅配额会单独显示在“提供方”页签下。",
    activeIncidents: "活跃事件",
    activeIncidentsDescription: "仍待处理的软阈值或硬阈值超限",
    pendingApprovals: "待审批",
    pendingApprovalsDescription: "等待 board 处理的预算覆盖审批",
    pausedAgents: "已暂停 Agent",
    pausedAgentsDescription: "因预算限制而阻塞心跳的 Agent",
    pausedProjects: "已暂停项目",
    pausedProjectsDescription: "因预算限制而阻塞执行的项目",
    activeIncidentsHeading: "活跃事件",
    activeIncidentsBody: "在这里通过提高预算或明确保持暂停，来处理硬性停机事件。",
    noBudgetPoliciesYet: "还没有预算策略。可在 Agent 和项目详情页设置预算，也可继续使用现有的公司月度预算控制。",
    companyBudgets: "公司预算",
    companyBudgetsDescription: "公司级月度预算策略。",
    agentBudgets: "Agent 预算",
    agentBudgetsDescription: "面向单个 Agent 的周期性月度支出策略。",
    projectBudgets: "项目预算",
    projectBudgetsDescription: "面向执行项目的生命周期支出策略。",
    noCostEventsInPeriod: "该时间段内还没有成本事件。",
    noBillableEventsInPeriod: "该时间段内还没有计费事件。",
    byBiller: "按计费方",
    byBillerDescription: "按实际收费或返还额度的主体汇总账户级财务事件。",
    budgetCardObserved: "已用",
    budgetCardBudget: "预算",
    budgetCardRemaining: "剩余",
    budgetCardNoCapConfigured: "未设置上限",
    budgetCardDisabled: "未启用",
    budgetCardUnlimited: "不限",
    budgetCardPausedStatus: "已暂停",
    budgetCardWarningStatus: "警告",
    budgetCardHardStopStatus: "硬性停止",
    budgetCardHealthyStatus: "正常",
    budgetCardBudgetUsdLabel: "预算（USD）",
    budgetCardUpdateBudget: "更新预算",
    budgetCardSetBudget: "设置预算",
    budgetCardSaving: "保存中...",
    budgetCardInvalidDollarAmount: "请输入有效的非负美元金额。",
    lifetimeBudget: "生命周期预算",
    monthlyUtcBudget: "UTC 月度预算",
    budgetCardProjectPaused: "该项目的执行已暂停，需提高预算或处理该事件后才能恢复。",
    budgetCardScopePaused: "该范围的心跳已暂停，需提高预算或处理该事件后才能恢复。",
  },
} as const;

function resolveLocale(locale: CostsCopyLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

export function getCostsCopy(locale: CostsCopyLocale) {
  return costsCopy[resolveLocale(locale)];
}

export function costsPresetLabel(
  preset: "mtd" | "7d" | "30d" | "ytd" | "all" | "custom",
  locale: CostsCopyLocale,
) {
  if (locale === "zh-CN") {
    return {
      mtd: "本月至今",
      "7d": "最近 7 天",
      "30d": "最近 30 天",
      ytd: "年初至今",
      all: "全部时间",
      custom: "自定义",
    }[preset];
  }
  return {
    mtd: "Month to date",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    ytd: "Year to date",
    all: "All time",
    custom: "Custom",
  }[preset];
}

export function formatFinanceEventCount(eventCount: number, locale: CostsCopyLocale) {
  if (locale === "zh-CN") {
    return `区间内共 ${eventCount} 条事件`;
  }
  return `${eventCount} total event${eventCount === 1 ? "" : "s"} in range`;
}

export function formatInferenceSpendSubtitle(totalTokens: string, locale: CostsCopyLocale) {
  return locale === "zh-CN"
    ? `${totalTokens} Tokens（按请求事件统计）`
    : `${totalTokens} tokens across request-scoped events`;
}

export function formatBudgetPausedSummary(pausedAgents: number, pausedProjects: number, locale: CostsCopyLocale) {
  return locale === "zh-CN"
    ? `${pausedAgents} 个 Agent 已暂停 · ${pausedProjects} 个项目已暂停`
    : `${pausedAgents} agents paused · ${pausedProjects} projects paused`;
}

export function formatFinanceDebitCreditSummary(debits: string, credits: string, locale: CostsCopyLocale) {
  return locale === "zh-CN"
    ? `${debits} 支出 · ${credits} 收入`
    : `${debits} debits · ${credits} credits`;
}

export function formatEstimatedInRange(amount: string, locale: CostsCopyLocale) {
  return locale === "zh-CN" ? `区间内预估 ${amount}` : `${amount} estimated in range`;
}

export function formatBudgetAmountLabel(amount: string, locale: CostsCopyLocale) {
  return locale === "zh-CN" ? `预算 ${amount}` : `Budget ${amount}`;
}

export function formatBudgetUtilizationMessage(percent: number, locale: CostsCopyLocale) {
  return locale === "zh-CN"
    ? `该时间范围已消耗月度预算的 ${percent}%。`
    : `${percent}% of monthly budget consumed in this range.`;
}

export function formatSpendOfBudget(spend: string, budget: string, locale: CostsCopyLocale) {
  return locale === "zh-CN" ? `已用 ${spend} / ${budget}` : `${spend} of ${budget}`;
}

export function formatRunBillingMix(apiRuns: number, subscriptionRuns: number, locale: CostsCopyLocale) {
  if (locale === "zh-CN") {
    return `${apiRuns} 次 API · ${subscriptionRuns} 次订阅`;
  }
  return `${apiRuns} api · ${subscriptionRuns} subscription`;
}

export function formatTokenUsage(totalTokens: string, locale: CostsCopyLocale) {
  return locale === "zh-CN" ? `${totalTokens} Tokens` : `${totalTokens} tok`;
}

export function formatInOutUsage(inputTokens: string, outputTokens: string, locale: CostsCopyLocale) {
  return locale === "zh-CN"
    ? `输入 ${inputTokens} · 输出 ${outputTokens}`
    : `in ${inputTokens} · out ${outputTokens}`;
}

export function formatScopeBudgetHeading(
  scopeType: BudgetPolicySummary["scopeType"],
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  return {
    company: copy.companyBudgets,
    agent: copy.agentBudgets,
    project: copy.projectBudgets,
  }[scopeType];
}

export function formatScopeBudgetDescription(
  scopeType: BudgetPolicySummary["scopeType"],
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  return {
    company: copy.companyBudgetsDescription,
    agent: copy.agentBudgetsDescription,
    project: copy.projectBudgetsDescription,
  }[scopeType];
}

export function formatBudgetPolicyWindowLabel(
  windowKind: BudgetPolicySummary["windowKind"],
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  return windowKind === "lifetime" ? copy.lifetimeBudget : copy.monthlyUtcBudget;
}

export function formatBudgetPolicyLimitSubtitle(
  amount: number,
  utilizationPercent: number,
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  if (amount <= 0) return copy.budgetCardNoCapConfigured;
  return locale === "zh-CN" ? `已使用上限的 ${utilizationPercent}%` : `${utilizationPercent}% of limit`;
}

function formatBudgetPauseReason(pauseReason: string | null | undefined, locale: CostsCopyLocale) {
  if (!pauseReason) return null;
  if (locale === "zh-CN") {
    if (pauseReason === "budget") return "预算";
    return pauseReason.replaceAll("_", " ");
  }
  return pauseReason.replaceAll("_", " ");
}

export function formatBudgetPolicySoftAlertSummary(
  warnPercent: number,
  pauseReason: string | null | undefined,
  locale: CostsCopyLocale,
) {
  const reason = formatBudgetPauseReason(pauseReason, locale);
  if (locale === "zh-CN") {
    return reason ? `软警戒线：${warnPercent}% · 因${reason}暂停` : `软警戒线：${warnPercent}%`;
  }
  return reason ? `Soft alert at ${warnPercent}% · ${reason} pause` : `Soft alert at ${warnPercent}%`;
}

export function formatBudgetPolicyScopeTypeLabel(
  scopeType: BudgetPolicySummary["scopeType"],
  locale: CostsCopyLocale,
) {
  if (locale === "zh-CN") {
    return {
      company: "公司",
      agent: "Agent",
      project: "项目",
    }[scopeType];
  }
  return {
    company: "Company",
    agent: "Agent",
    project: "Project",
  }[scopeType];
}

export function formatBudgetPolicyStatusLabel(
  status: BudgetPolicySummary["status"],
  paused: boolean,
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  if (paused) return copy.budgetCardPausedStatus;
  if (status === "warning") return copy.budgetCardWarningStatus;
  if (status === "hard_stop") return copy.budgetCardHardStopStatus;
  return copy.budgetCardHealthyStatus;
}

export function formatBudgetPolicyPausedDescription(
  scopeType: BudgetPolicySummary["scopeType"],
  locale: CostsCopyLocale,
) {
  const copy = getCostsCopy(locale);
  return scopeType === "project" ? copy.budgetCardProjectPaused : copy.budgetCardScopePaused;
}
