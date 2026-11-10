import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { SHOW_TASK_PRIORITY_UI } from "@/lib/ui-flags";
import type { WidgetCatalog, WidgetMeta } from "./lib/dashboard-layout";
import { LIVE_LIST_LIMIT_SETTING, RECENT_TASKS_LIMIT_SETTING } from "./widgets/settings";
import type { DashboardWidgetProps } from "./widgets/WidgetParts";

export interface WidgetDefinition extends WidgetMeta {
  Component: LazyExoticComponent<ComponentType<DashboardWidgetProps>>;
}

type WidgetModule = Record<string, ComponentType<DashboardWidgetProps>>;

function lazyWidget<TModule>(load: () => Promise<TModule>, name: keyof TModule & string) {
  return lazy(() => load().then((module) => ({ default: (module as unknown as WidgetModule)[name]! })));
}

const metrics = () => import("./widgets/MetricWidgets");
const charts = () => import("./widgets/ChartWidgets");
const lists = () => import("./widgets/ListWidgets");
const live = () => import("./widgets/LiveWidgets");

const DEFINITIONS: WidgetDefinition[] = [
  {
    id: "active-agents",
    title: "Agents",
    description: "Recent and running agent runs with their linked tasks.",
    dataSource: "Company live runs",
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    Component: lazyWidget(lists, "ActiveAgentsWidget"),
  },
  {
    id: "metric-agents",
    title: "Agents Enabled",
    description: "Enabled agents with running, paused and error counts.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    Component: lazyWidget(metrics, "AgentsMetricWidget"),
  },
  {
    id: "metric-tasks",
    title: "Tasks In Progress",
    description: "Tasks in progress with open and blocked counts.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    Component: lazyWidget(metrics, "TasksMetricWidget"),
  },
  {
    id: "metric-spend",
    title: "Month Spend",
    description: "Spend this month against the organization budget.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    Component: lazyWidget(metrics, "SpendMetricWidget"),
  },
  {
    id: "metric-approvals",
    title: "Pending Approvals (count)",
    description: "How many approvals wait for the board.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 1, h: 1 },
    minSize: { w: 1, h: 1 },
    Component: lazyWidget(metrics, "ApprovalsMetricWidget"),
  },
  {
    id: "chart-run-activity",
    title: "Run Activity",
    description: "Runs per day for the last 14 days.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 2 },
    Component: lazyWidget(charts, "RunActivityWidget"),
  },
  {
    id: "chart-tasks-by-status",
    title: "Tasks by Status",
    description: "Tasks created in the last 14 days by status.",
    dataSource: "Company tasks",
    defaultSize: { w: 1, h: 2 },
    minSize: { w: 1, h: 2 },
    Component: lazyWidget(charts, "TasksByStatusWidget"),
  },
  {
    id: "chart-success-rate",
    title: "Success Rate",
    description: "Share of successful runs for the last 14 days.",
    dataSource: "Dashboard summary",
    defaultSize: { w: 1, h: 2 },
    minSize: { w: 1, h: 2 },
    Component: lazyWidget(charts, "SuccessRateWidget"),
  },
  ...(SHOW_TASK_PRIORITY_UI
    ? [{
        id: "chart-tasks-by-priority",
        title: "Tasks by Priority",
        description: "Tasks created in the last 14 days by priority.",
        dataSource: "Company tasks",
        defaultSize: { w: 1, h: 2 },
        minSize: { w: 1, h: 2 },
        Component: lazyWidget(charts, "TasksByPriorityWidget"),
      } satisfies WidgetDefinition]
    : []),
  {
    id: "recent-activity",
    title: "Recent Activity",
    description: "The latest activity in the organization.",
    dataSource: "Activity log",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 1, h: 2 },
    Component: lazyWidget(lists, "RecentActivityWidget"),
  },
  {
    id: "recent-tasks",
    title: "Recent Tasks",
    description: "The most recently updated tasks.",
    dataSource: "Company tasks",
    defaultSize: { w: 2, h: 4 },
    minSize: { w: 1, h: 2 },
    settings: [RECENT_TASKS_LIMIT_SETTING],
    Component: lazyWidget(lists, "RecentTasksWidget"),
  },
  {
    id: "live-runs",
    title: "Live Runs",
    description: "Runs that are queued or running right now.",
    dataSource: "Company live runs",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
    settings: [LIVE_LIST_LIMIT_SETTING],
    Component: lazyWidget(live, "LiveRunsWidget"),
  },
  {
    id: "agent-errors",
    title: "Agent Errors",
    description: "Agents that are in error and why.",
    dataSource: "Company agents",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
    settings: [LIVE_LIST_LIMIT_SETTING],
    Component: lazyWidget(live, "AgentErrorsWidget"),
  },
  {
    id: "pending-approvals",
    title: "Pending Approvals",
    description: "Approvals that wait for a board decision.",
    dataSource: "Pending approvals",
    defaultSize: { w: 2, h: 3 },
    minSize: { w: 1, h: 2 },
    settings: [LIVE_LIST_LIMIT_SETTING],
    Component: lazyWidget(live, "PendingApprovalsWidget"),
  },
];

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = DEFINITIONS;

export const WIDGET_REGISTRY: ReadonlyMap<string, WidgetDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
);

export const WIDGET_CATALOG: WidgetCatalog = WIDGET_REGISTRY;

export const DEFAULT_WIDGET_IDS: readonly string[] = [
  "active-agents",
  "metric-agents",
  "metric-tasks",
  "metric-spend",
  "metric-approvals",
  "chart-run-activity",
  ...(SHOW_TASK_PRIORITY_UI ? ["chart-tasks-by-priority"] : []),
  "chart-tasks-by-status",
  "chart-success-rate",
  "recent-activity",
  "recent-tasks",
];
