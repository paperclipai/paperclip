// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_LAYOUT_SAVE_DEBOUNCE_MS } from "@/hooks/useUiLayout";

const uiLayoutsApi = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), reset: vi.fn() }));

vi.mock("@/api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("../../api/uiLayouts", () => ({ uiLayoutsApi }));
vi.mock("./registry", async () => {
  const { lazy } = await import("react");
  const widget = (id: string, title: string, size = { w: 1, h: 1 }) => ({
    id,
    title,
    description: `${title} description`,
    dataSource: "test",
    defaultSize: size,
    minSize: { w: 1, h: 1 },
    Component: lazy(async () => ({ default: () => <div data-testid={`content-${id}`}>{title}</div> })),
  });
  const definitions = [
    widget("metric-agents", "Agents Enabled"),
    widget("recent-tasks", "Recent Tasks", { w: 2, h: 2 }),
    widget("live-runs", "Live Runs", { w: 2, h: 3 }),
    widget("agent-errors", "Agent Errors", { w: 2, h: 3 }),
    widget("pending-approvals", "Pending Approvals", { w: 2, h: 3 }),
  ];
  const registry = new Map(definitions.map((definition) => [definition.id, definition]));
  return {
    WIDGET_DEFINITIONS: definitions,
    WIDGET_REGISTRY: registry,
    WIDGET_CATALOG: registry,
    DEFAULT_WIDGET_IDS: ["metric-agents", "recent-tasks"],
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let DashboardGrid: typeof import("./DashboardGrid").DashboardGrid;

beforeAll(async () => {
  ({ DashboardGrid } = await import("./DashboardGrid"));
}, 120_000);

beforeEach(() => {
  for (const fn of Object.values(uiLayoutsApi)) fn.mockReset();
  uiLayoutsApi.get.mockResolvedValue({ surface: "dashboard", schemaVersion: null, layout: null, updatedAt: null });
  uiLayoutsApi.save.mockImplementation(async (_companyId: string, surface: string, layout: unknown) => ({
    surface, schemaVersion: 1, layout, updatedAt: null,
  }));
  uiLayoutsApi.reset.mockResolvedValue({ surface: "dashboard", schemaVersion: null, layout: null, updatedAt: null });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DashboardGrid companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function waitForSave() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, UI_LAYOUT_SAVE_DEBOUNCE_MS + 50));
  });
  await settle();
}

function widgetIds(): string[] {
  return [...host.querySelectorAll('[data-testid="dashboard-widget"]')].map((element) => element.getAttribute("data-widget-id")!);
}

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

describe("DashboardGrid", () => {
  it("renders the default layout when nothing is saved and does not save it", async () => {
    await render();
    expect(widgetIds()).toEqual(["metric-agents", "recent-tasks"]);
    expect(host.querySelector('[data-testid="content-recent-tasks"]')?.textContent).toBe("Recent Tasks");
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
  });

  it("falls back to the default layout when the saved layout is invalid", async () => {
    uiLayoutsApi.get.mockResolvedValue({
      surface: "dashboard", schemaVersion: 7, updatedAt: null,
      layout: { schemaVersion: 7, widgets: "broken" },
    });
    await render();
    expect(widgetIds()).toEqual(["metric-agents", "recent-tasks"]);
  });

  it("restores a saved layout, migrates an unversioned one and drops unknown widgets", async () => {
    uiLayoutsApi.get.mockResolvedValue({
      surface: "dashboard", schemaVersion: null, updatedAt: null,
      layout: {
        widgets: [
          { instanceId: "recent-tasks", widgetId: "recent-tasks", w: 4, h: 2 },
          { instanceId: "old", widgetId: "retired-widget", w: 1, h: 1 },
          { instanceId: "metric-agents", widgetId: "metric-agents", w: 1, h: 1 },
        ],
      },
    });
    await render();
    expect(widgetIds()).toEqual(["recent-tasks", "metric-agents"]);
  });

  it("supports removing, resizing, adding and restoring in edit mode and saves one debounced layout", async () => {
    await render();
    expect(() => button("Remove Agents Enabled", host)).toThrow();
    await act(async () => button("Customize", host).click());
    await act(async () => button("Remove Agents Enabled", host).click());
    expect(widgetIds()).toEqual(["recent-tasks"]);
    await act(async () => button("Increase Recent Tasks width", host).click());
    await act(async () => button("Add widget", host).click());
    await act(async () => button("Add Agent Errors").click());
    expect(widgetIds()).toEqual(["recent-tasks", "agent-errors"]);

    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(uiLayoutsApi.save).toHaveBeenCalledWith("company-1", "dashboard", {
      schemaVersion: 1,
      contextualRules: {},
      widgets: [
        { instanceId: "recent-tasks", widgetId: "recent-tasks", w: 3, h: 2 },
        { instanceId: "agent-errors", widgetId: "agent-errors", w: 2, h: 3 },
      ],
    }, { signal: expect.any(AbortSignal) });
  });

  it("shows a failed save and sends the same layout again from the notice", async () => {
    uiLayoutsApi.save.mockRejectedValueOnce(new Error("Layout is not valid"));
    await render();
    await act(async () => button("Customize", host).click());
    await act(async () => button("Remove Agents Enabled", host).click());
    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Your latest dashboard layout changes are not saved yet.");

    await act(async () => button("Retry saving", host).click());
    await settle();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
    expect(uiLayoutsApi.save.mock.calls[1]![2]).toEqual(uiLayoutsApi.save.mock.calls[0]![2]);
    expect(host.textContent).not.toContain("are not saved yet");
    expect(widgetIds()).toEqual(["recent-tasks"]);
  });

  it("restores the default layout through the reset endpoint", async () => {
    uiLayoutsApi.get.mockResolvedValue({
      surface: "dashboard", schemaVersion: 1, updatedAt: null,
      layout: { schemaVersion: 1, contextualRules: {}, widgets: [{ instanceId: "live-runs", widgetId: "live-runs", w: 2, h: 3 }] },
    });
    let releaseReset!: () => void;
    uiLayoutsApi.reset.mockImplementation(() =>
      new Promise((resolve) => {
        releaseReset = () => resolve({ surface: "dashboard", schemaVersion: null, layout: null, updatedAt: null });
      }));
    await render();
    expect(widgetIds()).toEqual(["live-runs"]);
    await act(async () => button("Customize", host).click());
    await act(async () => button("Restore default", host).click());
    await settle();
    expect(button("Restore default", host).disabled).toBe(true);
    await act(async () => releaseReset());
    await settle();
    expect(button("Restore default", host).disabled).toBe(false);
    expect(widgetIds()).toEqual(["metric-agents", "recent-tasks"]);
    expect(uiLayoutsApi.reset).toHaveBeenCalledWith("company-1", "dashboard");
    await waitForSave();
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
  });

  it("does not overwrite the saved layout when it failed to load, and saves again after a successful retry", async () => {
    uiLayoutsApi.get.mockRejectedValueOnce(new Error("network down"));
    await render();
    expect(widgetIds()).toEqual(["metric-agents", "recent-tasks"]);
    expect(host.textContent).toContain("Your saved dashboard layout could not be loaded. Changes are not saved.");

    await act(async () => button("Customize", host).click());
    expect(button("Restore default", host).disabled).toBe(true);
    await act(async () => button("Remove Agents Enabled", host).click());
    expect(widgetIds()).toEqual(["recent-tasks"]);
    await waitForSave();
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();
    expect(uiLayoutsApi.reset).not.toHaveBeenCalled();

    uiLayoutsApi.get.mockResolvedValue({
      surface: "dashboard", schemaVersion: 1, updatedAt: null,
      layout: { schemaVersion: 1, contextualRules: {}, widgets: [{ instanceId: "live-runs", widgetId: "live-runs", w: 2, h: 3 }] },
    });
    await act(async () => button("Retry", host).click());
    await settle();
    expect(widgetIds()).toEqual(["live-runs"]);
    expect(host.textContent).not.toContain("could not be loaded");
    await act(async () => button("Increase Live Runs width", host).click());
    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(uiLayoutsApi.save.mock.calls[0]![2].widgets).toEqual([{ instanceId: "live-runs", widgetId: "live-runs", w: 3, h: 3 }]);
  });

  it("does not overwrite a saved layout from a newer version until the user chooses to replace it", async () => {
    uiLayoutsApi.get.mockResolvedValue({
      surface: "dashboard", schemaVersion: 7, updatedAt: null,
      layout: { schemaVersion: 7, widgets: [{ instanceId: "future", widgetId: "future-widget", w: 9, h: 9 }] },
    });
    await render();
    expect(host.textContent).toContain("Your saved dashboard layout cannot be read by this version. Changes are not saved.");
    await act(async () => button("Customize", host).click());
    await act(async () => button("Remove Agents Enabled", host).click());
    await waitForSave();
    expect(uiLayoutsApi.save).not.toHaveBeenCalled();

    await act(async () => button("Replace saved layout", host).click());
    expect(host.textContent).not.toContain("cannot be read");
    await act(async () => button("Increase Recent Tasks width", host).click());
    await waitForSave();
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(1);
    expect(uiLayoutsApi.save.mock.calls[0]![2].widgets).toEqual([{ instanceId: "recent-tasks", widgetId: "recent-tasks", w: 3, h: 2 }]);
  });

  it("sends one save at a time and lets the latest layout win when a save is slow", async () => {
    const releases: Array<() => void> = [];
    const order: string[] = [];
    uiLayoutsApi.save.mockImplementation((_companyId: string, surface: string, layout: { widgets: Array<{ w: number }> }) =>
      new Promise((resolve) => {
        const label = `w${layout.widgets[1]!.w}`;
        order.push(`start ${label}`);
        releases.push(() => {
          order.push(`end ${label}`);
          resolve({ surface, schemaVersion: 1, layout, updatedAt: null });
        });
      }));
    await render();
    await act(async () => button("Customize", host).click());
    await act(async () => button("Increase Recent Tasks width", host).click());
    await waitForSave();
    expect(order).toEqual(["start w3"]);

    await act(async () => button("Increase Recent Tasks width", host).click());
    await waitForSave();
    await act(async () => button("Decrease Recent Tasks width", host).click());
    await act(async () => button("Decrease Recent Tasks width", host).click());
    await waitForSave();
    expect(order).toEqual(["start w3"]);

    await act(async () => releases[0]!());
    await settle();
    await settle();
    expect(order).toEqual(["start w3", "end w3", "start w2"]);
    await act(async () => releases[1]!());
    await settle();
    await waitForSave();
    expect(order).toEqual(["start w3", "end w3", "start w2", "end w2"]);
    expect(uiLayoutsApi.save).toHaveBeenCalledTimes(2);
  }, 30_000);
});
