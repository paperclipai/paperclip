// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, ResourceMemberships } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAgents } from "./SidebarAgents";
import { queryKeys } from "../lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateAgent: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({ collapsed: false, peeking: false }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/PAP/dashboard", search: "", hash: "", state: null }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewAgent: mockOpenNewAgent,
  }),
  useDialogActions: () => ({
    openNewAgent: mockOpenNewAgent,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
    collapsed: mockSidebarState.collapsed,
    peeking: mockSidebarState.peeking,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function openAgentMenu(label = "Open actions for Alpha") {
  const trigger = document.body.querySelector(`button[aria-label="${label}"]`);
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function openAgentsSectionMenu() {
  const trigger = document.body.querySelector('button[aria-label="Agents section actions"]');
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function chooseSortMode(label: string) {
  const item = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-radio-item"]'))
    .find((element) => element.textContent?.includes(label));
  expect(item).toBeTruthy();

  await act(async () => {
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

function agentLinkLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a[href^="/agents/"]'))
    .filter((anchor) => anchor.getAttribute("href") !== "/agents/all")
    .map((anchor) => anchor.textContent?.trim())
    .filter(Boolean);
}

function seeAllAgentsLink(container: HTMLElement) {
  return (
    Array.from(container.querySelectorAll('a[href="/agents/all"]')).find((anchor) =>
      anchor.textContent?.includes("See all agents"),
    ) ?? null
  );
}

describe("SidebarAgents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;
  let memberships: ResourceMemberships;

  beforeEach(() => {
    mockSidebarState.collapsed = false;
    mockSidebarState.peeking = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockAgentsApi.list.mockResolvedValue([makeAgent({})]);
    mockAgentsApi.pause.mockResolvedValue(makeAgent({ status: "paused" }));
    mockAgentsApi.resume.mockResolvedValue(makeAgent({}));
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1" },
    });
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    memberships = {
      projectMemberships: {},
      agentMemberships: {},
      updatedAt: null,
    };
    mockResourceMembershipsApi.listMine.mockImplementation(() => Promise.resolve(memberships));
    mockResourceMembershipsApi.updateAgent.mockImplementation((_companyId, agentId, data) => {
      const previousState = memberships.agentMemberships[agentId] ?? "joined";
      const nextState = data.starred === true ? "joined" : data.state ?? previousState;
      const starredAgentIds = memberships.starredAgentIds ?? [];
      const nextStarredAgentIds = data.starred === true
        ? starredAgentIds.includes(agentId) ? starredAgentIds : [agentId, ...starredAgentIds]
        : data.starred === false || nextState === "left"
          ? starredAgentIds.filter((id) => id !== agentId)
          : starredAgentIds;
      memberships = {
        ...memberships,
        agentMemberships: {
          ...memberships.agentMemberships,
          [agentId]: nextState,
        },
        starredAgentIds: nextStarredAgentIds,
        updatedAt: new Date(),
      };
      return Promise.resolve({
        resourceType: "agent",
        resourceId: agentId,
        state: nextState,
        starredAt: data.starred === true ? new Date() : null,
      });
    });
    localStorage.clear();
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    vi.useRealTimers();
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  async function renderSidebarAgents(streamlined = true) {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents streamlined={streamlined} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function renderSidebarAgentsWithDefaultProps() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function renderSidebarAgentsWithFakeTimers() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarAgents streamlined />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function renderRailSidebarAgents() {
    mockSidebarState.collapsed = true;
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <SidebarAgents streamlined />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders icon-only agent rows with tooltips and no row actions in the rail", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" })]);

    await renderRailSidebarAgents();

    // The agent name is preserved in the a11y tree but kept in flow (zero-width,
    // clipped) so the row stays 1:1 tall with the expanded state (PAP-10676); the
    // row links become tooltip triggers and the per-row actions dropdown is dropped.
    const nameSpan = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Alpha");
    expect(nameSpan?.className).not.toContain("sr-only");
    expect(nameSpan?.className).toContain("w-0");
    expect(nameSpan?.className).toContain("overflow-hidden");
    const agentLink = container.querySelector('a[href^="/agents/"]:not([href="/agents/all"])');
    expect(agentLink?.parentElement?.getAttribute("data-slot")).toBe("tooltip-trigger");
    expect(container.querySelector('button[aria-label="Open actions for Alpha"]')).toBeNull();

    // The section header collapses to a divider (no caret / section menu).
    expect(container.querySelector('button[aria-label="Agents section actions"]')).toBeNull();
  });

  it("pins starred agents at the top without subheadings and dedupes them from the recent list", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
    ]);
    memberships = {
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: ["agent-b"],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: new Date(),
    };

    await renderSidebarAgents();

    expect(container.textContent).not.toContain("Starred");
    expect(container.textContent).not.toContain("Recently active");
    // Bravo is starred -> shown once at the top, deduped from recent.
    const labels = agentLinkLabels(container);
    expect(labels.filter((label) => label === "Bravo")).toHaveLength(1);
    expect(labels).toContain("Alpha");
    // Starred order lands the starred agent first.
    expect(labels[0]).toBe("Bravo");

    // The starred row offers an explicit "Remove from starred" menu action.
    await openAgentMenu("Open actions for Bravo");
    expect(document.body.textContent).toContain("Remove from starred");
  });

  it("offers star agent from an unstarred sidebar agent menu", async () => {
    await renderSidebarAgents();
    await openAgentMenu();

    const starItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Star agent"));
    expect(starItem).toBeTruthy();

    await act(async () => {
      starItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockResourceMembershipsApi.updateAgent).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      { state: undefined, starred: true },
    );
    expect(document.body.querySelector('button[aria-label="Unstar Alpha"]')).not.toBeNull();
  });

  it("keeps the agent starred and toasts when an unstar request fails", async () => {
    mockAgentsApi.list.mockResolvedValue([makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" })]);
    memberships = {
      projectMemberships: {},
      agentMemberships: { "agent-b": "joined" },
      starredProjectIds: [],
      starredAgentIds: ["agent-b"],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: new Date(),
    };
    mockResourceMembershipsApi.updateAgent.mockRejectedValue(new Error("nope"));

    await renderSidebarAgents();

    const unstar = document.body.querySelector('button[aria-label="Unstar Bravo"]');
    expect(unstar).not.toBeNull();

    await act(async () => {
      unstar?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    // Optimistic unstar is rolled back → the row stays in the starred group.
    expect(document.body.querySelector('button[aria-label="Unstar Bravo"]')).not.toBeNull();
    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error" }),
    );
  });

  it("keeps top mode in stored org-aware order", async () => {
    localStorage.setItem("paperclip.agentOrder:company-1:user-1", JSON.stringify(["agent-b", "agent-a", "agent-c"]));
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
    ]);

    await renderSidebarAgents();

    expect(agentLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);
  });

  it("uses the heading for section menu and the plus button for agent creation", async () => {
    await renderSidebarAgents();

    const sectionMenuTrigger = container.querySelector('button[aria-label="Agents section actions"]');
    expect(sectionMenuTrigger?.textContent).toContain("Agents");
    expect(sectionMenuTrigger?.querySelector("svg")).toBeNull();

    const newAgentButton = container.querySelector('button[aria-label="New agent"]');
    expect(newAgentButton).toBeTruthy();
    await act(async () => {
      newAgentButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockOpenNewAgent).toHaveBeenCalledTimes(1);

    await openAgentsSectionMenu();

    const newAgentItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("New agent"));
    expect(newAgentItem).toBeFalsy();
    const browseLink = Array.from(document.body.querySelectorAll("a"))
      .find((element) => element.textContent?.includes("Browse agents"));
    expect(browseLink?.getAttribute("href")).toBe("/agents/all");
  });

  it("sorts alphabetically and persists the selected mode per company and user", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
    ]);

    await renderSidebarAgents();
    await openAgentsSectionMenu();
    await chooseSortMode("Alphabetical");

    expect(agentLinkLabels(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(localStorage.getItem("paperclip.agentSortMode:company-1:user-1")).toBe("alphabetical");
  });

  it("sorts recent agents by heartbeat, updated time, and created time descending", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-a",
        name: "Alpha",
        urlKey: "alpha",
        lastHeartbeatAt: null,
        updatedAt: new Date("2026-01-20T00:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
      makeAgent({
        id: "agent-b",
        name: "Bravo",
        urlKey: "bravo",
        lastHeartbeatAt: new Date("2026-01-10T00:00:00Z"),
        updatedAt: new Date("2026-01-02T00:00:00Z"),
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
      makeAgent({
        id: "agent-c",
        name: "Charlie",
        urlKey: "charlie",
        lastHeartbeatAt: null,
        updatedAt: new Date("2026-01-20T00:00:00Z"),
        createdAt: new Date("2026-01-03T00:00:00Z"),
      }),
    ]);

    await renderSidebarAgents();
    await openAgentsSectionMenu();
    await chooseSortMode("Recent");

    expect(agentLinkLabels(container)).toEqual(["Bravo", "Charlie", "Alpha"]);
  });

  it("filters left agents only after membership state loads", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-2", name: "Beta", urlKey: "beta" }),
    ]);
    let resolveMemberships!: (value: unknown) => void;
    mockResourceMembershipsApi.listMine.mockReturnValue(new Promise((resolve) => {
      resolveMemberships = resolve;
    }));

    await renderSidebarAgents();
    expect(agentLinkLabels(container)).toEqual(["Alpha", "Beta"]);

    await act(async () => {
      resolveMemberships({
        projectMemberships: {},
        agentMemberships: { "agent-1": "left" },
        updatedAt: null,
      });
    });
    await flushReact();

    expect(agentLinkLabels(container)).toEqual(["Beta"]);
  });

  it("shows edit and pause actions for an active sidebar agent", async () => {
    await renderSidebarAgents();
    await openAgentMenu();

    const editLink = Array.from(document.body.querySelectorAll("a"))
      .find((element) => element.textContent?.includes("Edit agent"));
    expect(editLink?.getAttribute("href")).toBe("/agents/alpha/configuration");
    expect(document.body.textContent).toContain("Pause agent");

    const pauseItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(pauseItem).toBeTruthy();

    await act(async () => {
      pauseItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.pause).toHaveBeenCalledWith("agent-1", "company-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Agent paused" }));
  });

  it("offers leave agent from each sidebar agent menu", async () => {
    await renderSidebarAgents();
    await openAgentMenu();

    const leaveItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Leave agent"));
    expect(leaveItem).toBeTruthy();

    await act(async () => {
      leaveItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockResourceMembershipsApi.updateAgent).toHaveBeenCalledWith(
      "company-1",
      "agent-1",
      { state: "left" },
    );
    expect(agentLinkLabels(container)).toEqual([]);
  });

  it("shows resume for paused sidebar agents", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ status: "paused", pauseReason: "manual", pausedAt: new Date("2026-01-02T00:00:00Z") }),
    ]);

    await renderSidebarAgents();
    await openAgentMenu();

    const resumeItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Resume agent"));
    expect(resumeItem).toBeTruthy();

    await act(async () => {
      resumeItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.resume).toHaveBeenCalledWith("agent-1", "company-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Agent resumed" }));
  });

  it("only shows updating state for the agent currently being changed", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-1", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-2", name: "Beta", urlKey: "beta" }),
    ]);
    mockAgentsApi.pause.mockImplementation(() => new Promise(() => {}));

    await renderSidebarAgents();
    await openAgentMenu();

    const pauseItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(pauseItem).toBeTruthy();

    await act(async () => {
      pauseItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
    await openAgentMenu("Open actions for Beta");

    const betaPauseItem = Array.from(
      document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    )
      .find((element) => element.textContent?.includes("Pause agent"));
    expect(betaPauseItem).toBeTruthy();
    expect(document.body.textContent).not.toContain("Updating...");
  });

  it("shows only active agents when any agent has a live run", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-b", status: "running" },
    ]);

    await renderSidebarAgents();

    const labels = agentLinkLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Bravo");
    // PAP-76: the full-list entry point stays visible even when only active
    // agents are shown.
    expect(seeAllAgentsLink(container)?.getAttribute("href")).toBe("/agents/all");
  });

  it("keeps formerly live agents visible for the streamlined linger window", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
      makeAgent({ id: "agent-d", name: "Delta", urlKey: "delta" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-a", status: "running" },
    ]);

    await renderSidebarAgentsWithFakeTimers();

    let labels = agentLinkLabels(container);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain("Alpha");
    expect(labels[0]).toContain("1 live");

    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    await act(async () => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    labels = agentLinkLabels(container);
    expect(labels).toEqual(["Alpha"]);
    expect(labels.join(" ")).not.toContain("live");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(agentLinkLabels(container)).toEqual(["Alpha"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("expires staggered lingering agents without unrelated sidebar updates", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
      makeAgent({ id: "agent-d", name: "Delta", urlKey: "delta" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-a", status: "running" },
    ]);

    await renderSidebarAgentsWithFakeTimers();
    expect(agentLinkLabels(container)[0]).toContain("Alpha");

    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    await act(async () => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container)).toEqual(["Alpha"]);

    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-2", agentId: "agent-b", status: "running" },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), [
        { id: "run-2", agentId: "agent-b", status: "running" },
      ]);
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container).join(" ")).toContain("Bravo");

    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    await act(async () => {
      queryClient.setQueryData(queryKeys.liveRuns("company-1"), []);
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container)).toEqual(["Alpha", "Bravo"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_005);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container)).toEqual(["Bravo"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_005);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(agentLinkLabels(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("shows up to 3 recently-active agents plus a See all link when none are running", async () => {
    mockAgentsApi.list.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) =>
        makeAgent({
          id: `agent-${index}`,
          name: `Agent ${index}`,
          urlKey: `agent-${index}`,
        }),
      ),
    );
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);

    await renderSidebarAgents();

    expect(agentLinkLabels(container)).toHaveLength(3);
    expect(seeAllAgentsLink(container)?.getAttribute("href")).toBe("/agents/all");
  });

  it("classic mode (flag OFF) shows all agents and no See all link even when one is running", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "agent-a", name: "Alpha", urlKey: "alpha" }),
      makeAgent({ id: "agent-b", name: "Bravo", urlKey: "bravo" }),
      makeAgent({ id: "agent-c", name: "Charlie", urlKey: "charlie" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      { id: "run-1", agentId: "agent-b", status: "running" },
    ]);

    await renderSidebarAgents(false);

    // Show-all: every agent is listed regardless of live-run state. (Bravo's
    // label includes its live-run badge text, so match by prefix.)
    const labels = agentLinkLabels(container);
    expect(labels).toHaveLength(3);
    expect(labels[0]).toBe("Alpha");
    expect(labels[1]).toContain("Bravo");
    expect(labels[2]).toBe("Charlie");
    // No recent-5 truncation, so no "See all agents" link in classic mode.
    expect(seeAllAgentsLink(container)).toBeNull();
  });

  it("classic mode (flag OFF) shows more than 5 agents without truncation", async () => {
    mockAgentsApi.list.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) =>
        makeAgent({
          id: `agent-${index}`,
          name: `Agent ${index}`,
          urlKey: `agent-${index}`,
        }),
      ),
    );
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);

    await renderSidebarAgents(false);

    expect(agentLinkLabels(container)).toHaveLength(7);
    expect(seeAllAgentsLink(container)).toBeNull();
  });

  it("defaults to classic mode when rendered outside the Sidebar flag path", async () => {
    mockAgentsApi.list.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) =>
        makeAgent({
          id: `agent-${index}`,
          name: `Agent ${index}`,
          urlKey: `agent-${index}`,
        }),
      ),
    );
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);

    await renderSidebarAgentsWithDefaultProps();

    expect(agentLinkLabels(container)).toHaveLength(7);
    expect(seeAllAgentsLink(container)).toBeNull();
  });

  it("does not offer sidebar resume for budget-paused agents", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        status: "paused",
        pauseReason: "budget",
        pausedAt: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);

    await renderSidebarAgents();
    await openAgentMenu();

    const budgetPausedItem = Array.from(
      document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'),
    )
      .find((element) => element.textContent?.includes("Budget paused"));
    expect(budgetPausedItem).toBeTruthy();

    await act(async () => {
      budgetPausedItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockAgentsApi.resume).not.toHaveBeenCalled();
  });
});
