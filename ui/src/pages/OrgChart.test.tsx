// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { OrgChart } from "./OrgChart";
import { ToastProvider } from "../context/ToastContext";

const membershipListMock = vi.fn().mockResolvedValue({ starredAgentIds: [] });
const membershipUpdateMock = vi.fn().mockResolvedValue({ resourceId: "agent-1", state: "joined", starredAt: new Date() });
vi.mock("../api/resourceMemberships", () => ({ resourceMembershipsApi: {
  listMine: (...args: unknown[]) => membershipListMock(...args),
  updateAgent: (...args: unknown[]) => membershipUpdateMock(...args),
} }));
const navigateMock = vi.fn();
const orgMock = vi.fn();
const listMock = vi.fn();
const liveRunsMock = vi.fn().mockResolvedValue([]);
const summariesMock = vi.fn().mockResolvedValue([]);
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: (...args: unknown[]) => liveRunsMock(...args) } }));
vi.mock("../api/issues", () => ({ issuesApi: { summaries: (...args: unknown[]) => summariesMock(...args) } }));
const readTransform = (layer: HTMLElement) => layer.style.transform.match(/-?[\d.]+/g)!.map(Number);

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigateMock,
  useLocation: () => ({ pathname: window.location.pathname, search: window.location.search }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    org: () => orgMock(),
    list: () => listMock(),
  },
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const orgTree = [
  {
    id: "agent-1",
    name: "CEO",
    role: "ceo",
    status: "active",
    reports: [
      {
        id: "agent-2",
        name: "Engineer",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ],
  },
];

const agents = [
  {
    id: "agent-1",
    companyId: "company-1",
    name: "CEO",
    role: "ceo",
    title: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "briefcase",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "ceo",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
  {
    id: "agent-2",
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    title: null,
    status: "active",
    reportsTo: "agent-1",
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    contextMode: "thin",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    icon: "code",
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "engineer",
    pauseReason: null,
    pausedAt: null,
    permissions: null,
  },
];

function createTouchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    value: touches,
  });
  Object.defineProperty(event, "changedTouches", {
    value: touches,
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("OrgChart mobile gestures", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let viewportWidth: number;
  let viewportHeight: number;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    document.documentElement.style.setProperty("--org-card-width", "240px");
    document.documentElement.style.setProperty("--org-card-height", "336px");
    for (const [key, value] of Object.entries({ "leader-width": 280, "leader-height": 368, "manager-width": 232, "manager-height": 320, "member-width": 192, "member-height": 116, gap: 32, "level-gap": 72, padding: 48, "task-height": 32, "task-band-height": 64, "task-label-width": 208, "task-legend-height": 20, "toolbar-clearance": 88, "sparse-padding": 80, "fit-zoom-max": 1.25, "sparse-fit-zoom-max": 1 })) document.documentElement.style.setProperty(`--org-${key}`, `${value}px`);
    viewportWidth = 360;
    viewportHeight = 520;
    window.history.replaceState({}, "", "/");
    liveRunsMock.mockResolvedValue([]);
    summariesMock.mockResolvedValue([]);
    orgMock.mockResolvedValue(orgTree);
    listMock.mockResolvedValue(agents);

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportWidth : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.getAttribute("data-testid") === "org-chart-viewport" ? viewportHeight : 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      if (this.getAttribute("data-testid") === "org-chart-viewport") {
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: viewportWidth,
          bottom: viewportHeight,
          width: viewportWidth,
          height: viewportHeight,
          toJSON: () => ({}),
        };
      }
      return {
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      };
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root.unmount();
      });
    }
    container.remove();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    document.documentElement.style.removeProperty("--org-card-width");
    document.documentElement.style.removeProperty("--org-card-height");
    for (const key of ["leader-width", "leader-height", "manager-width", "manager-height", "member-width", "member-height", "gap", "level-gap", "padding", "task-height", "task-band-height", "task-label-width", "task-legend-height", "toolbar-clearance", "sparse-padding", "fit-zoom-max", "sparse-fit-zoom-max"]) document.documentElement.style.removeProperty(`--org-${key}`);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  async function renderOrgChart(enableTaskLayer = false, matchingAgentIds?: ReadonlySet<string>) {
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider><OrgChart enableTaskLayer={enableTaskLayer} matchingAgentIds={matchingAgentIds} /></ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return {
      viewport: container.querySelector('[data-testid="org-chart-viewport"]') as HTMLDivElement,
      layer: container.querySelector('[data-testid="org-chart-card-layer"]') as HTMLDivElement,
    };
  }

  it("centers two agents at natural size on a large viewport, including after Fit", async () => {
    viewportWidth = 1600;
    viewportHeight = 1000;
    const { layer } = await renderOrgChart();
    const assertCentered = () => {
      const [panX, panY, zoom] = readTransform(layer);
      expect(zoom).toBe(1);
      const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-org-card]"));
      const left = Math.min(...cards.map(card => parseFloat(card.style.left))) * zoom + panX;
      const right = Math.max(...cards.map(card => parseFloat(card.style.left) + parseFloat(card.style.width))) * zoom + panX;
      const top = Math.min(...cards.map(card => parseFloat(card.style.top))) * zoom + panY;
      const bottom = Math.max(...cards.map(card => parseFloat(card.style.top) + parseFloat(card.style.height))) * zoom + panY;
      expect((left + right) / 2).toBeCloseTo(viewportWidth / 2);
      expect((top + bottom) / 2).toBeCloseTo(viewportHeight / 2);
      expect(top).toBeGreaterThan(200);
      expect(left).toBeGreaterThan(500);
    };
    assertCentered();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click());
    expect(readTransform(layer)[2]).toBeGreaterThan(1);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Fit chart to screen"]')!.click());
    assertCentered();
  });

  it("pans the chart with one-finger touch drag", async () => {
    const { viewport, layer } = await renderOrgChart();
    const before = readTransform(layer);

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    const after = readTransform(layer);
    expect(after[0]).toBeCloseTo(before[0] + 30);
    expect(after[1]).toBeCloseTo(before[1] + 45);
    expect(after[2]).toBeCloseTo(before[2]);
  });

  it("suppresses card navigation after a touch pan", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [{ clientX: 130, clientY: 145 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("allows card navigation after a touch tap without movement", async () => {
    const { viewport } = await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLDivElement;

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [{ clientX: 100, clientY: 100 }]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
      card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
  });
  it("pinch-zooms toward the touch center", async () => {
    const { viewport, layer } = await renderOrgChart();
    const before = readTransform(layer);

    await act(async () => {
      viewport.dispatchEvent(createTouchEvent("touchstart", [
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchmove", [
        { clientX: 75, clientY: 100 },
        { clientX: 225, clientY: 100 },
      ]));
      viewport.dispatchEvent(createTouchEvent("touchend", []));
    });

    const after = readTransform(layer);
    expect(after[2]).toBeCloseTo(before[2] * 1.5);
    expect(after[0]).toBeCloseTo(150 - 1.5 * (150 - before[0]));
    expect(after[1]).toBeCloseTo(100 - 1.5 * (100 - before[1]));
  });

  it("does not produce a negative zoom while the viewport has no usable height", async () => {
    viewportHeight = 2;
    const { layer } = await renderOrgChart();

    expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");

    await act(async () => {
      (container.querySelector('[aria-label="Fit chart to screen"]') as HTMLButtonElement).click();
    });

    expect(layer.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("dims reporting connections when either endpoint is filtered while preserving navigation", async () => {
    await renderOrgChart(false, new Set(["agent-1"]));
    const edge = () => container.querySelector(".org-reporting-edge")!;
    expect(edge().getAttribute("data-filter-match")).toBe("false");
    for (const ids of [["agent-2"], ["agent-1", "agent-2"]]) {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><ToastProvider><OrgChart matchingAgentIds={new Set(ids)} /></ToastProvider></QueryClientProvider>));
      expect(edge().getAttribute("data-filter-match")).toBe(ids.length === 2 ? "true" : "false");
    }
    await act(async () => (container.querySelector('[aria-label="Open Engineer overview"]') as HTMLElement).click());
    expect(navigateMock).toHaveBeenCalledWith("/agents/engineer");
  });

  it("uses live characters only for the two leadership tiers and keeps contributors static", async () => {
    orgMock.mockResolvedValue([{ ...orgTree[0], reports: [{ ...orgTree[0].reports[0], reports: [{ id: "agent-3", name: "Contributor", role: "engineer", status: "idle", reports: [] }] }] }]);
    await renderOrgChart();
    const cards = container.querySelectorAll("[data-org-card]");
    expect(cards).toHaveLength(3);
    expect(cards[0].querySelector(".org-card-live-character")).not.toBeNull();
    expect(cards[1].querySelector(".org-card-live-character")).not.toBeNull();
    expect(cards[2].querySelector(".org-card-live-character")).toBeNull();
    expect(cards[2].querySelector("img")?.getAttribute("src")).toContain("view=portrait");
    expect(cards[0].querySelector(".org-card-status")?.textContent).toBe("Idle");
  });

  it("stars a leader without opening its overview, including keyboard activation", async () => {
    await renderOrgChart();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Star CEO"]')!;
    await act(async () => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    await flushReact();
    expect(membershipUpdateMock).toHaveBeenCalledWith("company-1", "agent-1", { state: undefined, starred: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("shows the custom title, configured model label, and effort on each portrait card", async () => {
    listMock.mockResolvedValue([
      { ...agents[0], title: "Team lead", adapterType: "claude_local", adapterConfig: { model: "claude-opus-5-5", effort: "max" } },
      { ...agents[1], adapterConfig: { model: "custom-company-model", modelReasoningEffort: "xhigh" } },
    ]);
    await renderOrgChart();
    const cards = container.querySelectorAll("[data-org-card]");
    expect(cards[0].textContent).toContain("Team lead");
    expect(cards[0].querySelector(".org-card-model")?.textContent).toBe("Opus 5.5 Max");
    expect(cards[0].textContent).toContain("Max");
    expect(cards[1].textContent).toContain("custom-company-model");
    expect(cards[1].textContent).toContain("Extra High");
  });

  it("omits unknown model and effort labels and opens a focused card with Enter", async () => {
    await renderOrgChart();
    const card = container.querySelector("[data-org-card]") as HTMLElement;
    expect(card.querySelector(".org-card-model")).toBeNull();
    expect(card.textContent).not.toContain("Codex");
    expect(card.textContent).not.toContain("Harness default");
    expect(card.tabIndex).toBe(0);
    await act(async () => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(navigateMock).toHaveBeenCalledWith("/agents/ceo");
  });

  it("loads live task associations only when Tasks is enabled and deduplicates shared tasks", async () => {
    liveRunsMock.mockResolvedValue([
      { id: "r1", status: "running", agentId: "agent-1", issueId: "task-1" },
      { id: "r2", status: "running", agentId: "agent-2", issueId: "task-1" },
      { id: "r3", status: "succeeded", agentId: "agent-2", issueId: "task-2" },
    ]);
    summariesMock.mockResolvedValue([{ id: "task-1", title: "Review the launch", identifier: "PAP-1" }]);
    const { layer } = await renderOrgChart(true);
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    const transform = layer.style.transform;
    const cardStyles = [...container.querySelectorAll("[data-org-card]")].map(card => card.getAttribute("style"));
    expect(liveRunsMock).not.toHaveBeenCalled();
    const toggle = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Tasks")!;
    await act(() => toggle.click()); await flushReact(); await flushReact();
    expect(container.querySelectorAll("[data-org-task]")).toHaveLength(1);
    expect(container.querySelectorAll(".org-task-edge")).toHaveLength(2);
    expect(container.querySelector("[data-org-task]")?.getAttribute("href")).toBe("/issues/PAP-1");
    expect(container.textContent).toContain("Review the launch");
    expect(layer.style.transform).toBe(transform);
    expect([...container.querySelectorAll("[data-org-card]")].map(card => card.getAttribute("style"))).toEqual(cardStyles);
    expect(layer.querySelector("[data-org-task]")).toBeNull();
    await act(() => toggle.click());
    expect(container.querySelectorAll("[data-org-task]")).toHaveLength(0);
    expect(layer.style.transform).toBe(transform);
  });

  it("shows a task-layer failure without hiding the organization", async () => {
    liveRunsMock.mockRejectedValue(new Error("Task service unavailable"));
    await renderOrgChart(true);
    const toggle = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Tasks")!;
    await act(() => toggle.click());
    await flushReact();
    await flushReact();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Task service unavailable");
    expect(container.querySelectorAll("[data-org-card]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-org-task]")).toHaveLength(0);
  });

  it("keeps task layering hidden on product surfaces even with the demo URL", async () => {
    viewportWidth = 1200;
    window.history.replaceState({}, "", "/?orgTasks=demo");
    await renderOrgChart();
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Tasks")).toBe(false);
    expect(container.textContent).not.toContain("simulated running tasks");
    expect(container.querySelectorAll("[data-org-task]")).toHaveLength(0);
    expect(container.querySelectorAll("a[data-org-task]")).toHaveLength(0);
    expect(container.querySelectorAll(".org-task-edge")).toHaveLength(0);
    expect(liveRunsMock).not.toHaveBeenCalled();
    expect(summariesMock).not.toHaveBeenCalled();
  });

  it("shows both portability buttons on self-hosted instances", async () => {
    await renderOrgChart();

    expect(container.textContent).toContain("Import organization");
    expect(container.textContent).toContain("Export organization");
  });

  it("hides the Import button but keeps Export on a Cloud-managed instance", async () => {
    queryClient.setQueryData(queryKeys.health, { status: "ok", cloud: { managed: true } });
    await renderOrgChart();

    expect(container.textContent).not.toContain("Import organization");
    expect(container.textContent).toContain("Export organization");
  });
});
