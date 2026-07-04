import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Gauge,
  Hash,
  LayoutDashboard,
  ListChecks,
  RotateCcw,
  Settings2,
  Target,
  Trash2,
  Users,
} from "lucide-react";
import type { Issue, IssueStatus, Project } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { sumIssueValuesWithDescendants } from "../lib/issue-rollups";

type MetricTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";
type DashboardMetricKey =
  | "open_items"
  | "human_tasks"
  | "initiatives"
  | "ai_issues"
  | "blocked_items"
  | "due_this_week"
  | "overdue"
  | "unassigned"
  | "story_points"
  | "estimate_hours"
  | "actual_human_hours"
  | "actual_ai_hours"
  | "completion_rate";
type DashboardWidgetScope = "all" | "human" | "ai" | "initiative";
type DashboardWidgetStatusScope = "all" | "open" | "done" | "blocked";
type DashboardWidgetSize = "compact" | "wide";

export type DashboardWidgetConfig = {
  id: string;
  metric: DashboardMetricKey;
  label?: string;
  scope: DashboardWidgetScope;
  statusScope: DashboardWidgetStatusScope;
  size: DashboardWidgetSize;
};

type MetricDefinition = {
  key: DashboardMetricKey;
  label: string;
  description: string;
  tone: MetricTone;
  icon: typeof LayoutDashboard;
};

type MetricResult = {
  value: string;
  detail: string;
  tone: MetricTone;
  progress: number | null;
};

const OPEN_STATUSES = new Set<IssueStatus>(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const DAY_MS = 24 * 60 * 60 * 1000;

const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    key: "open_items",
    label: "Open work",
    description: "Open scoped work items.",
    tone: "blue",
    icon: ListChecks,
  },
  {
    key: "human_tasks",
    label: "Human tasks",
    description: "Human-owned task volume.",
    tone: "blue",
    icon: Users,
  },
  {
    key: "initiatives",
    label: "Initiatives",
    description: "Bigger outcomes tracked above tasks.",
    tone: "violet",
    icon: Target,
  },
  {
    key: "ai_issues",
    label: "AI issues",
    description: "Agent execution lane volume.",
    tone: "violet",
    icon: Bot,
  },
  {
    key: "blocked_items",
    label: "Blocked",
    description: "Scoped work currently blocked.",
    tone: "red",
    icon: AlertCircle,
  },
  {
    key: "due_this_week",
    label: "Due this week",
    description: "Open work due in the next 7 days.",
    tone: "amber",
    icon: CalendarClock,
  },
  {
    key: "overdue",
    label: "Overdue",
    description: "Open work past the due date.",
    tone: "red",
    icon: Clock3,
  },
  {
    key: "unassigned",
    label: "Unassigned",
    description: "Work without a person or agent owner.",
    tone: "amber",
    icon: Users,
  },
  {
    key: "story_points",
    label: "Story points",
    description: "Sum of planning points.",
    tone: "green",
    icon: Hash,
  },
  {
    key: "estimate_hours",
    label: "Estimate hours",
    description: "Sum of rough estimates.",
    tone: "green",
    icon: Gauge,
  },
  {
    key: "actual_ai_hours",
    label: "AI hours",
    description: "Actual agent execution time.",
    tone: "violet",
    icon: Bot,
  },
  {
    key: "actual_human_hours",
    label: "Human hours",
    description: "Actual human work time.",
    tone: "blue",
    icon: Users,
  },
  {
    key: "completion_rate",
    label: "Completion",
    description: "Done work as a percentage of scoped work.",
    tone: "green",
    icon: CheckCircle2,
  },
];

const METRIC_BY_KEY = new Map(METRIC_DEFINITIONS.map((definition) => [definition.key, definition]));

export const DEFAULT_WORK_HUB_WIDGETS: DashboardWidgetConfig[] = [
  { id: "open-human", metric: "open_items", scope: "human", statusScope: "open", size: "compact" },
  { id: "story-points", metric: "story_points", scope: "human", statusScope: "open", size: "compact" },
  { id: "estimate-hours", metric: "estimate_hours", scope: "human", statusScope: "open", size: "compact" },
  { id: "human-hours", metric: "actual_human_hours", scope: "human", statusScope: "all", size: "compact" },
  { id: "blocked", metric: "blocked_items", scope: "all", statusScope: "all", size: "compact" },
  { id: "initiatives", metric: "initiatives", scope: "initiative", statusScope: "all", size: "compact" },
  { id: "ai-hours", metric: "actual_ai_hours", scope: "ai", statusScope: "all", size: "compact" },
  { id: "due-week", metric: "due_this_week", scope: "human", statusScope: "open", size: "compact" },
  { id: "completion", metric: "completion_rate", scope: "human", statusScope: "all", size: "compact" },
];

export const DEFAULT_PROJECT_DASHBOARD_WIDGETS: DashboardWidgetConfig[] = [
  { id: "project-open", metric: "open_items", scope: "all", statusScope: "open", size: "compact" },
  { id: "project-completion", metric: "completion_rate", scope: "all", statusScope: "all", size: "compact" },
  { id: "project-points", metric: "story_points", scope: "human", statusScope: "open", size: "compact" },
  { id: "project-estimate", metric: "estimate_hours", scope: "human", statusScope: "open", size: "compact" },
  { id: "project-human-hours", metric: "actual_human_hours", scope: "human", statusScope: "all", size: "compact" },
  { id: "project-blocked", metric: "blocked_items", scope: "all", statusScope: "all", size: "compact" },
  { id: "project-ai", metric: "ai_issues", scope: "ai", statusScope: "all", size: "compact" },
  { id: "project-due", metric: "due_this_week", scope: "all", statusScope: "open", size: "compact" },
  { id: "project-ai-hours", metric: "actual_ai_hours", scope: "ai", statusScope: "all", size: "compact" },
];

function startOfLocalDay(input: Date | string): number {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function isOpenIssue(issue: Issue): boolean {
  return OPEN_STATUSES.has(issue.status);
}

function isHumanIssue(issue: Issue): boolean {
  return issue.workItemType === "human_task" || Boolean(issue.assigneeUserId);
}

function isAiIssue(issue: Issue): boolean {
  return issue.workItemType === "ai_task" || Boolean(issue.assigneeAgentId);
}

function isInitiative(issue: Issue): boolean {
  return issue.workItemType === "initiative";
}

function scopeMatches(issue: Issue, scope: DashboardWidgetScope): boolean {
  if (scope === "human") return isHumanIssue(issue);
  if (scope === "ai") return isAiIssue(issue);
  if (scope === "initiative") return isInitiative(issue);
  return true;
}

function statusMatches(issue: Issue, statusScope: DashboardWidgetStatusScope): boolean {
  if (statusScope === "open") return isOpenIssue(issue);
  if (statusScope === "done") return issue.status === "done";
  if (statusScope === "blocked") return issue.status === "blocked";
  return true;
}

function scopedIssues(issues: Issue[], widget: DashboardWidgetConfig): Issue[] {
  return issues.filter((issue) => scopeMatches(issue, widget.scope) && statusMatches(issue, widget.statusScope));
}

function dueThisWeek(issue: Issue): boolean {
  if (!issue.dueDate || !isOpenIssue(issue)) return false;
  const due = startOfLocalDay(issue.dueDate);
  const today = startOfLocalDay(new Date());
  return due >= today && due <= today + 7 * DAY_MS;
}

function overdue(issue: Issue): boolean {
  if (!issue.dueDate || !isOpenIssue(issue)) return false;
  return startOfLocalDay(issue.dueDate) < startOfLocalDay(new Date());
}

function storyPoints(issue: Issue): number {
  if (typeof issue.storyPoints !== "number" || !Number.isFinite(issue.storyPoints)) return 0;
  return Math.max(0, issue.storyPoints);
}

function estimateHours(issue: Issue): number {
  if (typeof issue.estimateHours !== "number" || !Number.isFinite(issue.estimateHours)) return 0;
  return Math.max(0, issue.estimateHours);
}

function actualAiHours(issue: Issue): number {
  if (typeof issue.actualAiSeconds !== "number" || !Number.isFinite(issue.actualAiSeconds)) return 0;
  return Math.max(0, issue.actualAiSeconds / 3600);
}

function actualHumanHours(issue: Issue): number {
  if (typeof issue.actualHumanSeconds !== "number" || !Number.isFinite(issue.actualHumanSeconds)) return 0;
  return Math.max(0, issue.actualHumanSeconds / 3600);
}

function formatDecimal(value: number, digits = 1): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(digits);
}

function formatHours(value: number): string {
  return `${formatDecimal(value)}h`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function metricResult(widget: DashboardWidgetConfig, issues: Issue[]): MetricResult {
  const scoped = scopedIssues(issues, widget);
  const allInWidgetScope = issues.filter((issue) => scopeMatches(issue, widget.scope));
  const definition = METRIC_BY_KEY.get(widget.metric);
  const tone = definition?.tone ?? "neutral";
  const scopeDetail = `${scoped.length} scoped item${scoped.length === 1 ? "" : "s"}`;

  if (widget.metric === "open_items") {
    const count = scoped.filter(isOpenIssue).length;
    return { value: String(count), detail: `${scopeDetail} currently visible`, tone, progress: null };
  }
  if (widget.metric === "human_tasks") {
    const count = scoped.filter(isHumanIssue).length;
    return { value: String(count), detail: `${scoped.filter(isOpenIssue).length} open human item${count === 1 ? "" : "s"}`, tone, progress: null };
  }
  if (widget.metric === "initiatives") {
    const count = scoped.filter(isInitiative).length;
    return { value: String(count), detail: `${scoped.filter(isOpenIssue).length} active initiative${count === 1 ? "" : "s"}`, tone, progress: null };
  }
  if (widget.metric === "ai_issues") {
    const count = scoped.filter(isAiIssue).length;
    return { value: String(count), detail: `${scoped.filter(isOpenIssue).length} open execution item${count === 1 ? "" : "s"}`, tone, progress: null };
  }
  if (widget.metric === "blocked_items") {
    const count = scoped.filter((issue) => issue.status === "blocked").length;
    return { value: String(count), detail: `${scopeDetail} checked for blockers`, tone: count > 0 ? "red" : "green", progress: null };
  }
  if (widget.metric === "due_this_week") {
    const count = scoped.filter(dueThisWeek).length;
    return { value: String(count), detail: "Open items due in the next 7 days", tone: count > 0 ? "amber" : "green", progress: null };
  }
  if (widget.metric === "overdue") {
    const count = scoped.filter(overdue).length;
    return { value: String(count), detail: "Open items past their due date", tone: count > 0 ? "red" : "green", progress: null };
  }
  if (widget.metric === "unassigned") {
    const count = scoped.filter((issue) => !issue.assigneeAgentId && !issue.assigneeUserId).length;
    return { value: String(count), detail: `${scopeDetail} checked for ownership`, tone: count > 0 ? "amber" : "green", progress: null };
  }
  if (widget.metric === "story_points") {
    const total = scoped.reduce((sum, issue) => sum + storyPoints(issue), 0);
    return { value: String(total), detail: `${scoped.filter(isOpenIssue).length} open item${scoped.length === 1 ? "" : "s"} carrying points`, tone, progress: null };
  }
  if (widget.metric === "estimate_hours") {
    const total = scoped.reduce((sum, issue) => sum + estimateHours(issue), 0);
    return { value: formatHours(total), detail: `${scopeDetail} with rough hour estimates`, tone, progress: null };
  }
  if (widget.metric === "actual_ai_hours") {
    const total = sumIssueValuesWithDescendants(scoped, issues, actualAiHours);
    return { value: formatHours(total), detail: "Recorded agent execution time, including sub-issues", tone, progress: null };
  }
  if (widget.metric === "actual_human_hours") {
    const total = sumIssueValuesWithDescendants(scoped, issues, actualHumanHours);
    return { value: formatHours(total), detail: "Recorded human work time, including sub-issues", tone, progress: null };
  }
  if (widget.metric === "completion_rate") {
    const base = allInWidgetScope.filter((issue) => widget.statusScope === "all" || statusMatches(issue, widget.statusScope));
    const done = base.filter((issue) => issue.status === "done").length;
    const percent = base.length > 0 ? (done / base.length) * 100 : 0;
    return {
      value: formatPercent(percent),
      detail: `${done} done / ${base.length} total`,
      tone: percent >= 80 ? "green" : percent >= 40 ? "amber" : "neutral",
      progress: percent,
    };
  }

  return { value: "0", detail: scopeDetail, tone, progress: null };
}

function readDashboardWidgets(storageKey: string, defaults: DashboardWidgetConfig[]): DashboardWidgetConfig[] {
  if (typeof window === "undefined") return defaults;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaults;
    const normalized = parsed.flatMap((value): DashboardWidgetConfig[] => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<DashboardWidgetConfig>;
      if (!candidate.id || !candidate.metric || !METRIC_BY_KEY.has(candidate.metric)) return [];
      return [{
        id: String(candidate.id),
        metric: candidate.metric,
        label: typeof candidate.label === "string" ? candidate.label : undefined,
        scope: candidate.scope === "human" || candidate.scope === "ai" || candidate.scope === "initiative" ? candidate.scope : "all",
        statusScope: candidate.statusScope === "open" || candidate.statusScope === "done" || candidate.statusScope === "blocked" ? candidate.statusScope : "all",
        size: candidate.size === "wide" ? "wide" : "compact",
      }];
    });
    return normalized.length > 0 ? normalized : defaults;
  } catch {
    return defaults;
  }
}

function writeDashboardWidgets(storageKey: string, widgets: DashboardWidgetConfig[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(widgets));
  } catch {
    // Ignore storage failures, the in-memory builder still works.
  }
}

function newWidgetId(metric: DashboardMetricKey): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${metric}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createWidgetForMetric(metric: DashboardMetricKey): DashboardWidgetConfig {
  return {
    id: newWidgetId(metric),
    metric,
    scope: "all",
    statusScope: "all",
    size: "compact",
  };
}

function useDashboardWidgets(storageKey: string, defaults: DashboardWidgetConfig[]) {
  const [widgets, setWidgets] = useState<DashboardWidgetConfig[]>(() => readDashboardWidgets(storageKey, defaults));

  useEffect(() => {
    setWidgets(readDashboardWidgets(storageKey, defaults));
  }, [defaults, storageKey]);

  const saveWidgets = useCallback((next: DashboardWidgetConfig[]) => {
    setWidgets(next);
    writeDashboardWidgets(storageKey, next);
  }, [storageKey]);

  return [widgets, saveWidgets] as const;
}

function toneClasses(tone: MetricTone): string {
  if (tone === "blue") return "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300";
  if (tone === "green") return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300";
  if (tone === "amber") return "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300";
  if (tone === "red") return "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300";
  if (tone === "violet") return "bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300";
  return "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
}

function scopeLabel(scope: DashboardWidgetScope): string {
  if (scope === "human") return "Human";
  if (scope === "ai") return "AI";
  if (scope === "initiative") return "Initiatives";
  return "All work";
}

function statusScopeLabel(statusScope: DashboardWidgetStatusScope): string {
  if (statusScope === "open") return "Open";
  if (statusScope === "done") return "Done";
  if (statusScope === "blocked") return "Blocked";
  return "All statuses";
}

function WidgetCard({ widget, issues }: { widget: DashboardWidgetConfig; issues: Issue[] }) {
  const definition = METRIC_BY_KEY.get(widget.metric) ?? METRIC_DEFINITIONS[0];
  const result = metricResult(widget, issues);
  const Icon = definition.icon;
  const label = widget.label?.trim() || definition.label;

  return (
    <div
      className={cn(
        "min-h-[9.25rem] rounded-lg border border-border bg-background p-4 shadow-sm",
        widget.size === "wide" && "sm:col-span-2",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-3 text-3xl font-semibold leading-none tracking-tight text-foreground">{result.value}</div>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md", toneClasses(result.tone))}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      {result.progress !== null ? (
        <div className="mt-4 h-1.5 overflow-hidden rounded bg-muted">
          <div
            className="h-full rounded bg-foreground"
            style={{ width: `${Math.max(2, Math.min(100, Math.round(result.progress)))}%` }}
          />
        </div>
      ) : null}
      <div className="mt-3 text-xs leading-5 text-muted-foreground">{result.detail}</div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {scopeLabel(widget.scope)}
        </span>
        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {statusScopeLabel(widget.statusScope)}
        </span>
      </div>
    </div>
  );
}

function updateWidget(
  widgets: DashboardWidgetConfig[],
  id: string,
  patch: Partial<DashboardWidgetConfig>,
): DashboardWidgetConfig[] {
  return widgets.map((widget) => widget.id === id ? { ...widget, ...patch } : widget);
}

function moveWidget(widgets: DashboardWidgetConfig[], id: string, direction: -1 | 1): DashboardWidgetConfig[] {
  const index = widgets.findIndex((widget) => widget.id === id);
  if (index < 0) return widgets;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= widgets.length) return widgets;
  const next = [...widgets];
  const [item] = next.splice(index, 1);
  next.splice(nextIndex, 0, item);
  return next;
}

function BuilderRow({
  widget,
  index,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
}: {
  widget: DashboardWidgetConfig;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onChange: (patch: Partial<DashboardWidgetConfig>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  const definition = METRIC_BY_KEY.get(widget.metric) ?? METRIC_DEFINITIONS[0];
  const Icon = definition.icon;

  return (
    <div className="rounded-lg border border-border bg-background p-3" role="group" aria-label={`Shown metric ${index + 1}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className={cn("mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md", toneClasses(definition.tone))}>
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{widget.label?.trim() || definition.label}</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {scopeLabel(widget.scope)}
              </span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {statusScopeLabel(widget.statusScope)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{definition.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon-xs" disabled={isFirst} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" disabled={isLast} onClick={() => onMove(1)}>
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-xs" onClick={onRemove}>
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>

      <details className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Options</summary>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">Scope</span>
            <select
              value={widget.scope}
              onChange={(event) => onChange({ scope: event.target.value as DashboardWidgetScope })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All work</option>
              <option value="human">Human tasks</option>
              <option value="ai">AI issues</option>
              <option value="initiative">Initiatives</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">Status</span>
            <select
              value={widget.statusScope}
              onChange={(event) => onChange({ statusScope: event.target.value as DashboardWidgetStatusScope })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">Size</span>
            <select
              value={widget.size}
              onChange={(event) => onChange({ size: event.target.value as DashboardWidgetSize })}
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="compact">Compact</option>
              <option value="wide">Wide</option>
            </select>
          </label>
        </div>
        <label className="mt-2 block space-y-1">
          <span className="text-[11px] font-medium text-muted-foreground">Custom label</span>
          <input
            value={widget.label ?? ""}
            onChange={(event) => onChange({ label: event.target.value })}
            placeholder={definition.label}
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-xs"
          />
        </label>
      </details>
    </div>
  );
}

export function CustomDashboardBuilder({
  storageKey,
  title,
  subtitle,
  issues,
  projects,
  defaultWidgets,
  isLoading = false,
}: {
  storageKey: string;
  title: string;
  subtitle: string;
  issues: Issue[];
  projects?: Project[];
  defaultWidgets: DashboardWidgetConfig[];
  isLoading?: boolean;
}) {
  const [customizing, setCustomizing] = useState(false);
  const [widgets, saveWidgets] = useDashboardWidgets(storageKey, defaultWidgets);
  const activeProjects = useMemo(
    () => (projects ?? []).filter((project) => !project.archivedAt).length,
    [projects],
  );
  const selectedMetricKeys = useMemo(() => new Set(widgets.map((widget) => widget.metric)), [widgets]);

  const setWidget = useCallback((id: string, patch: Partial<DashboardWidgetConfig>) => {
    saveWidgets(updateWidget(widgets, id, patch));
  }, [saveWidgets, widgets]);

  const toggleMetric = useCallback((metric: DashboardMetricKey, checked: boolean) => {
    if (checked) {
      if (widgets.some((widget) => widget.metric === metric)) return;
      saveWidgets([...widgets, createWidgetForMetric(metric)]);
      return;
    }
    saveWidgets(widgets.filter((widget) => widget.metric !== metric));
  }, [saveWidgets, widgets]);

  const resetWidgets = useCallback(() => {
    saveWidgets(defaultWidgets);
  }, [defaultWidgets, saveWidgets]);

  return (
    <section className="rounded-lg border border-border bg-background shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {issues.length} issues
          </span>
          {projects ? (
            <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
              {activeProjects} projects
            </span>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => setCustomizing((open) => !open)}>
            <Settings2 className="h-4 w-4" />
            {customizing ? "Done" : "Metrics"}
          </Button>
        </div>
      </div>

      {customizing ? (
        <div className="border-b border-border bg-muted/20 px-4 py-4">
          <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="text-xs text-muted-foreground">
              Choose the metrics to show. Reorder the selected metrics below and open Options only when a metric needs a narrower scope.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={resetWidgets}>
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {METRIC_DEFINITIONS.map((definition) => {
                const checked = selectedMetricKeys.has(definition.key);
                const Icon = definition.icon;
                return (
                  <label
                    key={definition.key}
                    className={cn(
                      "flex min-h-[5rem] cursor-pointer items-start gap-3 rounded-lg border bg-background p-3 transition-colors",
                      checked ? "border-foreground/40 ring-1 ring-foreground/20" : "border-border hover:border-foreground/20",
                    )}
                  >
                    <input
                      type="checkbox"
                      value={definition.key}
                      checked={checked}
                      onChange={(event) => toggleMetric(definition.key, event.currentTarget.checked)}
                      className="mt-1 h-4 w-4"
                      aria-label={`Show ${definition.label}`}
                    />
                    <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md", toneClasses(definition.tone))}>
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-foreground">{definition.label}</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">{definition.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Shown metrics</div>
                <span className="rounded-md bg-muted px-2 py-1 text-xs tabular-nums text-muted-foreground">
                  {widgets.length}
                </span>
              </div>
              {widgets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-background px-4 py-8 text-center text-sm text-muted-foreground">
                  Pick metrics from the left to build this dashboard.
                </div>
              ) : widgets.map((widget, index) => (
                <BuilderRow
                  key={widget.id}
                  widget={widget}
                  index={index}
                  isFirst={index === 0}
                  isLast={index === widgets.length - 1}
                  onChange={(patch) => setWidget(widget.id, patch)}
                  onMove={(direction) => saveWidgets(moveWidget(widgets, widget.id, direction))}
                  onRemove={() => saveWidgets(widgets.filter((item) => item.id !== widget.id))}
                />
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="p-4">
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {widgets.slice(0, 4).map((widget) => (
              <div key={widget.id} className="h-[9.25rem] animate-pulse rounded-lg border border-border bg-muted/40" />
            ))}
          </div>
        ) : widgets.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Add a widget to build this dashboard.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {widgets.map((widget) => (
              <WidgetCard key={widget.id} widget={widget} issues={issues} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
