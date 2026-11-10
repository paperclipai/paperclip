import { describe, expect, it } from "vitest";
import { DASHBOARD_MAX_WIDGETS, dashboardLayoutSchema, type DashboardLayout } from "@paperclipai/shared";
import {
  addWidget,
  buildDefaultLayout,
  effectiveColumnSpan,
  moveWidget,
  normalizeLayout,
  removeWidget,
  resizeWidget,
  setWidgetConfig,
  widgetSetting,
  type WidgetMeta,
} from "./dashboard-layout";

function meta(id: string, overrides: Partial<WidgetMeta> = {}): WidgetMeta {
  return {
    id,
    title: id,
    description: "",
    dataSource: "test",
    defaultSize: { w: 2, h: 2 },
    minSize: { w: 1, h: 1 },
    ...overrides,
  };
}

const catalog = new Map(
  [
    meta("metric-agents", { defaultSize: { w: 1, h: 1 } }),
    meta("recent-tasks", { minSize: { w: 2, h: 2 } }),
    meta("live-runs"),
    meta("agent-errors"),
    meta("pending-approvals"),
  ].map((item) => [item.id, item]),
);
const base = buildDefaultLayout(["metric-agents", "recent-tasks", "missing"], catalog);

describe("dashboard layout operations", () => {
  it("builds a valid default layout from known widgets only", () => {
    expect(base.widgets.map((widget) => widget.instanceId)).toEqual(["metric-agents", "recent-tasks"]);
    expect(dashboardLayoutSchema.safeParse(base).success).toBe(true);
  });

  it("adds widgets with unique instance ids and stops at the limit", () => {
    const twice = addWidget(addWidget(base, catalog.get("metric-agents")!), catalog.get("metric-agents")!);
    expect(twice.widgets.map((widget) => widget.instanceId)).toEqual(["metric-agents", "recent-tasks", "metric-agents-2", "metric-agents-3"]);
    expect(dashboardLayoutSchema.safeParse(twice).success).toBe(true);
    let full: DashboardLayout = base;
    for (let i = 0; i < DASHBOARD_MAX_WIDGETS + 5; i += 1) full = addWidget(full, catalog.get("live-runs")!);
    expect(full.widgets).toHaveLength(DASHBOARD_MAX_WIDGETS);
  });

  it("moves, removes and resizes within the widget limits", () => {
    expect(moveWidget(base, "recent-tasks", "metric-agents").widgets.map((widget) => widget.instanceId)).toEqual(["recent-tasks", "metric-agents"]);
    expect(moveWidget(base, "recent-tasks", "recent-tasks")).toBe(base);
    expect(removeWidget(base, "metric-agents").widgets).toHaveLength(1);
    expect(removeWidget(base, "nope")).toBe(base);
    expect(resizeWidget(base, "recent-tasks", { w: 0, h: 0 }, catalog).widgets[1]).toMatchObject({ w: 2, h: 2 });
    expect(resizeWidget(base, "recent-tasks", { w: 99, h: 99 }, catalog).widgets[1]).toMatchObject({ w: 4, h: 6 });
    expect(resizeWidget(base, "recent-tasks", { w: 2, h: 2 }, catalog)).toBe(base);
  });

  it("drops unknown widgets and clamps stored sizes when normalizing", () => {
    const stored: DashboardLayout = {
      ...base,
      widgets: [
        { instanceId: "gone", widgetId: "removed-widget", w: 1, h: 1 },
        { instanceId: "recent-tasks", widgetId: "recent-tasks", w: 1, h: 1 },
        base.widgets[0]!,
      ],
    };
    const normalized = normalizeLayout(stored, catalog);
    expect(normalized.widgets).toEqual([{ instanceId: "recent-tasks", widgetId: "recent-tasks", w: 2, h: 2 }, base.widgets[0]]);
    expect(normalizeLayout(base, catalog)).toBe(base);
  });

  it("stores and reads widget settings with bounds", () => {
    const limit = { key: "limit", label: "Rows", type: "number" as const, min: 3, max: 20, default: 10 };
    expect(widgetSetting(base.widgets[1]!, limit)).toBe(10);
    const configured = setWidgetConfig(base, "recent-tasks", "limit", 500);
    expect(widgetSetting(configured.widgets[1]!, limit)).toBe(20);
    expect(setWidgetConfig(configured, "recent-tasks", "limit", 500)).toBe(configured);
    expect(dashboardLayoutSchema.safeParse(configured).success).toBe(true);
  });

  it("limits column spans to the columns of the current breakpoint", () => {
    expect(effectiveColumnSpan(4, 1)).toBe(1);
    expect(effectiveColumnSpan(3, 2)).toBe(2);
    expect(effectiveColumnSpan(2, 4)).toBe(2);
  });
});
