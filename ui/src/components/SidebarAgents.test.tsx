// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarAgents } from "./SidebarAgents";

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

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
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
    .map((anchor) => anchor.textContent?.trim())
    .filter(Boolean);
}

describe("SidebarAgents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
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
    localStorage.clear();
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    vi.clearAllMocks();
  });

  async function renderSidebarAgents() {
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
