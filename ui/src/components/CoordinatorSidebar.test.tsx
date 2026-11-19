// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionFeed, AttentionItem, IssueSummary, Project } from "@paperclipai/shared";
import { buildPinnedNavigationItems, CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey, coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), pathname: "/COO/issues", search: "", userId: "reviewer" as string | null, chats: [] as Array<{ id?: string; conversationAgentId?: string; updatedAt?: string; isUnreadForMe: boolean }>,
  recentTasks: [] as Array<Record<string, unknown>>, taskSummaries: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), enableCases: false, enableResponsibilities: false, agents: [] as Agent[] }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: fixture.userId }) }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId, agents: { data: fixture.agents }, chats: { data: fixture.chats }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: ({ pinnedTaskIds }: { pinnedTaskIds: string[] }) => ({
  entries: fixture.recentTasks, pinnedTasks: fixture.taskSummaries.filter(task => pinnedTaskIds.includes(String(task.id))),
}) }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: fixture.projectTasks } }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableCases: fixture.enableCases, enableResponsibilities: fixture.enableResponsibilities }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => fixture.projects } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: fixture.search }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z", activityAt: "2026-10-20T12:00:00Z" }) as AttentionItem;
function feed(items: AttentionItem[], mineCount = items.length): AttentionFeed {
  return { companyId: "company", generatedAt: "2026-10-27T12:00:00Z", totalCount: items.length, deskBadgeCount: mineCount,
    viewCounts: { mine: mineCount, unassigned: 0, company: 0, archived: 0, all: items.length }, nextCursor: null, countsBySourceKind: {} as AttentionFeed["countsBySourceKind"], items };
}

function summary(items: AttentionItem[], mineCount = items.length) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items, mineCount);
  return counts;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.userId = "reviewer"; fixture.pathname = "/COO/issues"; fixture.search = "";
  fixture.chats = []; fixture.recentTasks = []; fixture.taskSummaries = []; fixture.projects = []; fixture.enableCases = false; fixture.enableResponsibilities = false; fixture.agents = [];
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("shows opened parent and child tasks as independent rows in recent order", async () => {
    fixture.recentTasks = [
      { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 2 },
      { id: "child", companyId: "company", identifier: "TASK-2", title: "Opened child", status: "todo", recordedAt: 2, parentId: "parent", isUnreadForMe: true },
    ];
    fixture.projectTasks.mockResolvedValue([
      { ...fixture.recentTasks[1] },
      { id: "unopened", companyId: "company", identifier: "TASK-3", title: "Unopened child", status: "todo", parentId: "parent" },
    ]);
    await renderSidebar();
    const region = container.querySelector('[aria-label="Recents"]')!;
    const links = [...region.querySelectorAll("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual(["/issues/TASK-2", "/issues/TASK-1"]);
    expect(links[0]!.parentElement?.parentElement).toBe(links[1]!.parentElement?.parentElement);
    expect(links[0]!.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(links[1]!.querySelector('[aria-label="Unread"]')).toBeNull();
    expect(region.querySelector('button[aria-expanded]')).toBeNull();
    expect(fixture.projectTasks).not.toHaveBeenCalled();
  });
  it("keeps hundreds of mixed recent rows in visit order with bounded input reads", async () => {
    const baseTime = Date.parse("2026-11-18T08:00:00Z");
    const tasks = Array.from({ length: 300 }, (_, index) => ({
      id: `task-${index}`, companyId: "company", identifier: `TASK-${index}`, title: `Recent task ${index}`,
      status: "todo", recordedAt: baseTime + 2 * index,
      parentId: index > 0 ? `task-${index - 1}` : null, subtaskCount: 1,
    }));
    const agents = Array.from({ length: 100 }, (_, index) => ({
      id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}`, role: "engineer", status: "idle",
    } as Agent));
    const chats = agents.map((agent, index) => ({
      id: `chat-${index}`, conversationAgentId: agent.id,
      updatedAt: new Date(baseTime + 6 * index + 3).toISOString(), isUnreadForMe: false,
    }));
    const projects = Array.from({ length: 60 }, (_, index) => ({
      id: `project-${index}`, companyId: "company", name: `Project ${index}`, urlKey: `project-${index}`,
    }));
    const inputCount = tasks.length + agents.length + chats.length + projects.length;
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * inputCount) {
          throw new Error("Recents scans growing lists repeatedly");
        }
        return Reflect.get(target, property, receiver);
      } });
    }

    fixture.projects = bounded(projects);
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime + 601);
    try {
      fixture.pathname = "/COO/projects/project-0";
      await renderSidebar();
      now.mockReturnValue(baseTime + 602);
      fixture.pathname = "/COO/projects/project-1";
      await renderSidebar();
    } finally {
      now.mockRestore();
    }

    fixture.recentTasks = bounded(tasks);
    fixture.agents = bounded(agents);
    fixture.chats = bounded(chats);
    await renderSidebar();

    const region = container.querySelector('[role="region"][aria-label="Recents"]')!;
    const links = Array.from(region.querySelectorAll("a"), link => link.getAttribute("href"));
    expect(links).toHaveLength(tasks.length + chats.length + 2);
    expect(links.slice(0, 4)).toEqual(["/projects/project-1/issues", "/projects/project-0/issues", "/issues/TASK-299", "/chats/agent-99"]);
    expect(links.at(-1)).toBe("/issues/TASK-0");
    expect(new Set(links).size).toBe(links.length);
    expect(fixture.projectTasks).not.toHaveBeenCalled();
    expect(reads).toBeGreaterThanOrEqual(inputCount);
  });
  it("moves the child ahead of newer rows when reopened", async () => {
    const parent = { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 1 };
    const child = { id: "child", companyId: "company", identifier: "TASK-2", title: "Child", status: "todo", recordedAt: 2, parentId: parent.id };
    const other = { id: "other", companyId: "company", identifier: "TASK-3", title: "Other", status: "todo", recordedAt: 3 };
    fixture.recentTasks = [other, child, parent];
    fixture.projectTasks.mockResolvedValue([child]);
    await renderSidebar();
    const order = () => Array.from(container.querySelectorAll('[aria-label="Recents"] a'), link => link.getAttribute("href"));
    expect(order()).toEqual(["/issues/TASK-3", "/issues/TASK-2", "/issues/TASK-1"]);
    fixture.pathname = "/COO/issues/TASK-2";
    fixture.recentTasks = [{ ...child, recordedAt: 4 }, other, parent];
    await renderSidebar();
    expect(order()).toEqual(["/issues/TASK-2", "/issues/TASK-3", "/issues/TASK-1"]);
  });
  it("opens global search from the organization header", async () => {
    await renderSidebar();
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      const button = container.querySelector<HTMLButtonElement>('.design-sidebar-brand button[aria-label="Global search"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ key: "k", metaKey: true }));
    } finally { document.removeEventListener("keydown", listener); }
  });
  it("opens the task form from New task above Chat", async () => {
    await renderSidebar();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    const chat = container.querySelector('a[href="/chats"]');
    expect(button).not.toBeNull();
    expect(chat).not.toBeNull();
    expect(button!.compareDocumentPosition(chat!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(fixture.openNewIssue).not.toHaveBeenCalled();
    await act(async () => button!.click());
    expect(fixture.openNewIssue).toHaveBeenCalledOnce();
  });
});

describe("Coordinator pinned pages", () => {
  it("pins tasks, chats, and projects from Recents and restores them above More in saved order", async () => {
    const task = { id: "e4acf42d-422f-44b8-84b8-9d678f8b7c7c", companyId: "company", identifier: "TASK-1", title: "Release task", status: "todo", recordedAt: 1 };
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    fixture.chats = [{ id: "chat", conversationAgentId: "cto", updatedAt: "2026-11-11T12:00:00Z", isUnreadForMe: false }];
    fixture.projects = [{ id: "project", companyId: "company", name: "Launch", urlKey: "launch" }];
    fixture.pathname = "/COO/projects/launch";
    fixture.taskSummaries = [task];
    fixture.recentTasks = [task];
    await renderSidebar();
    const recents = container.querySelector('[aria-label="Recents"]')!;
    const pinnedLinks = () => Array.from(navigation().querySelectorAll(".group\\/coordinator-pin a"), link => link.getAttribute("href"));
    for (const label of ["Release task", "CTO", "Launch"]) {
      const button = recents.querySelector<HTMLButtonElement>(`button[aria-label="Pin ${label}"]`)!;
      expect(button).not.toBeNull();
      expect(button.closest("a")).toBeNull();
      await act(async () => button.click());
      expect(button.getAttribute("aria-pressed")).toBe("true");
    }
    expect(pinnedLinks()).toEqual(["/issues/TASK-1", "/chats/cto", "/projects/launch/issues"]);
    fixture.pathname = "/COO/issues";
    fixture.recentTasks = [];
    fixture.chats = [];
    fixture.taskSummaries = [{ ...task, title: "Renamed release task" }];
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(container.querySelector('[aria-label="Recents"]')).toBeNull();
    expect(pinnedLinks()).toEqual(["/issues/TASK-1", "/chats/cto", "/projects/launch/issues"]);
    expect(pinnedPage("/issues/TASK-1")?.textContent).toContain("Renamed release task");
    await click("Unpin Renamed release task");
    expect(pinnedLinks()).toEqual(["/chats/cto", "/projects/launch/issues"]);
  });
  it("matches pinned and recent agent avatar dimensions to task status icons", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const chat = { id: "chat-cto", conversationAgentId: "cto", updatedAt: "2026-11-11T12:00:00Z", isUnreadForMe: false };
    fixture.chats = [chat];
    fixture.recentTasks = [{ id: "task", companyId: "company", identifier: "TASK-1", title: "Recent task", status: "todo", recordedAt: 1 }];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["agent-chat:company:cto"]));

    await renderSidebar();

    const avatars = [...container.querySelectorAll<HTMLImageElement>('a[href="/chats/cto"] [data-slot="agent-avatar"] img')];
    const taskIcon = container.querySelector('a[href="/issues/TASK-1"] [data-slot="sidebar-nav-icon"] svg');
    expect(avatars).toHaveLength(2);
    expect(taskIcon).not.toBeNull();
    const width = Number(taskIcon!.getAttribute("width"));
    const height = Number(taskIcon!.getAttribute("height"));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.width).toBe(width);
      expect(avatar.height).toBe(height);
    }
  });
  it("builds hundreds of mixed pins with input reads proportional to list size", () => {
    const agents = Array.from({ length: 200 }, (_, index) => ({ id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}` } as Agent));
    const tasks = Array.from({ length: 200 }, (_, index): IssueSummary => ({ id: `task-${index}`, companyId: "company", title: `Task ${index}`, identifier: `TASK-${index}`, status: "todo", updatedAt: new Date(0), externalConversationState: null }));
    const projects = Array.from({ length: 200 }, (_, index) => ({ id: `project-${index}`, companyId: "company", name: `Project ${index}`, urlKey: `project-${index}` } as Project));
    const pins = agents.flatMap((agent, index) => [`agent-chat:company:${agent.id}`, `project:company:${projects[index]!.id}`, `task:company:${tasks[index]!.id}`]).reverse();
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * pins.length) throw new Error("Pin construction scans growing lists repeatedly");
        return Reflect.get(target, property, receiver);
      } });
    }
    const items = buildPinnedNavigationItems(bounded(pins), bounded(agents), [], bounded(tasks), bounded(projects));
    expect(items.map(item => item.key)).toEqual(pins);
    expect(reads).toBeLessThanOrEqual(4 * pins.length);
    expect(items.slice(0, 3).map(item => item.to)).toEqual(["/issues/TASK-199", "/projects/project-199/issues", "/chats/agent-199"]);
  });
  it("keeps mixed pins above More in stored order and prevents native link dragging", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const saved = ["agent-chat:company:cto", "agent-chat:another-company:hidden", "/artifacts", "/dashboard"];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(saved));
    await renderSidebar();
    const links = [...navigation().querySelectorAll<HTMLAnchorElement>("a")].slice(3);
    expect(links.map(link => link.textContent)).toEqual(["CTO", "Artifacts", "Dashboard"]);
    const more = navigation().querySelector('button[aria-label="More workspace pages"]')!;
    expect(links.at(-1)!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(JSON.parse(localStorage.getItem("paperclip.coordinator.pinned-nav.v1:reviewer")!)).toEqual(saved);
    const nativeDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => links[1].dispatchEvent(nativeDrag));
    expect(nativeDrag.defaultPrevented).toBe(true);
  });
  it("reorders mixed pins with the keyboard while preserving hidden slots and saved order", async () => {
    const storageKey = "paperclip.coordinator.pinned-nav.v1:reviewer";
    const saved = ["/artifacts", "agent-chat:another-company:hidden", "/dashboard"];
    localStorage.setItem(storageKey, JSON.stringify(saved));
    await renderSidebar();
    const order = () => [...navigation().querySelectorAll(".group\\/coordinator-pin a")].map(link => link.getAttribute("href"));
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      const index = rows.indexOf(this);
      if (index < 0) return nativeRect.call(this);
      const top = index * 40;
      return { x: 0, y: top, top, bottom: top + 40, left: 0, right: 240, width: 240, height: 40, toJSON() {} };
    });
    const key = async (target: Element, code: string) => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    };
    try {
      const handle = navigation().querySelector<HTMLButtonElement>('[aria-label="Reorder pinned Artifacts"]')!;
      handle.focus();
      await key(handle, "Space");
      await key(handle, "ArrowDown");
      await key(handle, "Escape");
      expect(order()).toEqual(["/artifacts", "/dashboard"]);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
      await key(handle, "Space");
      await key(handle, "ArrowDown");
      await key(handle, "Space");
      expect(order()).toEqual(["/dashboard", "/artifacts"]);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([saved[2], saved[1], saved[0]]);
      await act(async () => root.unmount()); root = createRoot(container);
      await renderSidebar();
      expect(order()).toEqual(["/dashboard", "/artifacts"]);
    } finally { rect.mockRestore(); }
  });
  it.each([false, true])("keeps Cases reachable in More only when enabled (%s)", async enabled => {
    fixture.enableCases = enabled;
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/cases"]') !== null).toBe(enabled);
  });
  it("announces unread chat totals", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
  });
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it("keeps pins above More without a separate section, restores and unpins", async () => {
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    await click("More workspace pages");
    expect(document.activeElement).toBe(document.querySelector('[data-slot="popover-content"]'));
    await click("Pin Projects");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
    expect(navigation().querySelector('[aria-label="Pinned pages"]')).toBeNull();
    expect(navigation().querySelector('[data-slot="sidebar-group-label"]')).toBeNull();
    const more = navigation().querySelector('button[aria-label="More workspace pages"]')!;
    expect(pinnedPage("/projects")!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPage("/projects")).not.toBeNull();
    await click("Unpin Projects");
    expect(pinnedPage("/projects")).toBeNull();
  });

  it("keeps pins personal and only renders known destinations", async () => {
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["/routines", "/projects", "/unknown", "https://example.com"]));
    await renderSidebar();
    expect(Array.from(navigation().querySelectorAll("a")).map(link => link.getAttribute("href")))
      .toEqual(["/chats", "/issues", "/decisions", "/routines", "/projects"]);
    fixture.userId = "other-user";
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    fixture.userId = "reviewer";
    await renderSidebar();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
  });

  it("reflects pins changed in another browser tab", async () => {
    await renderSidebar();
    const key = "paperclip.coordinator.pinned-nav.v1:reviewer";
    await act(async () => {
      localStorage.setItem(key, JSON.stringify(["/agents/all"]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(pinnedPage("/agents/all")?.textContent).toBe("Agents");
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("Coordinator Inbox badge", () => {
  it("counts outstanding decisions for you even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company", "reviewer", "mine"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("counts only For you, excluding other people, unassigned cards and company alerts", async () => {
    fixture.summary.mockResolvedValue(summary([
      pending("for-reviewer"), pending("for-someone-else"), pending("unassigned"), pending("company-alert"),
    ], 1));
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
  });

  it("hides the badge when only other people's decisions remain", async () => {
    fixture.summary.mockResolvedValue(summary([pending("for-someone-else")], 0));
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("never reuses another account's count when the signed-in user changes", async () => {
    for (const [userId, mineCount] of [["reviewer", 2], ["other-user", 1]] as const) {
      const key = coordinatorAttentionSummaryQueryKey("company", userId);
      client.setQueryDefaults(key, { staleTime: Infinity });
      client.setQueryData(key, summary([pending("one"), pending("two")], mineCount));
    }
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
    fixture.userId = "other-user";
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    expect(fixture.summary).not.toHaveBeenCalled();
  });

  it("waits for the signed-in user before reading or displaying a count", async () => {
    fixture.userId = null;
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("updates after canonical attention refreshes and removes the badge once every decision is resolved", async () => {
    await renderSidebar();
    fixture.summary.mockResolvedValue(summary([pending("review")]));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    fixture.summary.mockResolvedValue(summary([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }, { id: "accepted-review" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(decisionLink().textContent).toBe("Inbox");
  });

  it("announces only your outstanding count", async () => {
    fixture.summary.mockResolvedValue(summary([pending("for-reviewer"), pending("for-someone-else")], 1));
    await renderSidebar();
    expect(decisionLink().querySelector('[aria-label="1 decisions"]')).not.toBeNull();
  });
});


describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company", "reviewer");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company", "reviewer");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });

  it("reuses the page-owned complete feed on Inbox without a second summary read", async () => {
    fixture.pathname = "/COO/decisions";
    const key = coordinatorAttentionQueryKey("company", "reviewer", "mine");
    client.setQueryData(key, feed([pending("review"), pending("review-evidence")], 1));
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(key, feed([])));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("reuses your count from the Tasks attention index without counting everyone", async () => {
    fixture.search = "?view=needs_attention";
    const key = coordinatorAttentionTasksQueryKey("company", "reviewer");
    client.setQueryData(key, { ...summary([pending("for-reviewer"), pending("for-someone-else")], 1), taskIds: [] });
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(key, { ...summary([pending("for-someone-else")], 0), taskIds: [] }));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("Coordinator task status glyphs (BUG-07)", () => {
  const covered = {
    state: "covered", reason: "active_child", unresolvedBlockerCount: 1, coveredBlockerCount: 1,
    attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: "ONB-3", sampleStalledBlockerIdentifier: null,
  };
  const glyph = (href: string) => container.querySelector<SVGElement>(`a[href="${href}"] svg[role="img"]`);

  it("shows a covered-blocked recent task with the same queued glyph and label as the task pane", async () => {
    fixture.recentTasks = [{ id: "task-1", companyId: "company", identifier: "ONB-1", title: "Paperclip onboarding",
      status: "blocked", displayStatus: "blocked", externalConversationState: null, blockerAttention: covered, recordedAt: 1 }];
    await renderSidebar();
    expect(glyph("/issues/ONB-1")?.style.color).toBe("var(--status-task-icon-in_queue)");
    expect(glyph("/issues/ONB-1")?.getAttribute("aria-label")).toBe("Blocked · waiting on active sub-task ONB-3");
  });

  it("opens a recent project on Tasks and keeps its task query lazy", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.pathname = "/COO/projects/onboarding";
    await renderSidebar();
    const region = container.querySelector('[aria-label="Recents"]')!;
    expect(region.querySelector('a[href="/projects/onboarding/issues"]')?.textContent).toBe("Onboarding");
    expect(region.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(fixture.projectTasks).not.toHaveBeenCalled();
  });
});

describe("Coordinator project tasks", () => {
  async function projectRow(pinned: boolean) {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    if (pinned) {
      localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["project:company:project-1"]));
    } else {
      fixture.pathname = "/COO/projects/onboarding/configuration";
    }
    await renderSidebar();
    return container.querySelector(pinned ? ".group\\/coordinator-pin" : '[aria-label="Recents"]')!;
  }

  it.each([false, true])("opens Tasks and expands tasks beneath the project (pinned: %s)", async pinned => {
    const task = { id: "project-task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch",
      status: "in_progress", displayStatus: "monitoring", isUnreadForMe: true };
    fixture.projectTasks.mockResolvedValue([task]);
    const row = await projectRow(pinned);
    expect(row.querySelector('a[href="/projects/onboarding/issues"]')?.textContent).toBe("Onboarding");
    expect(fixture.projectTasks).not.toHaveBeenCalled();
    const expand = row.querySelector<HTMLButtonElement>('button[aria-label="Expand Onboarding"]')!;
    expect(expand.closest("a")).toBeNull();
    await act(async () => expand.click());
    await flush();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    const tasks = document.getElementById(expand.getAttribute("aria-controls")!)!;
    expect(tasks.querySelector('a[href="/issues/TASK-42"]')?.textContent).toContain("Prepare launch");
    expect(tasks.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(tasks.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Monitoring");
    expect(fixture.projectTasks).toHaveBeenCalledWith("company", {
      projectId: "project-1", includeReadState: true, limit: 12, sortField: "updated", sortDir: "desc",
    }, { signal: expect.any(AbortSignal) });
    if (pinned) {
      expect(row.querySelector('[aria-label="Reorder pinned Onboarding"]')?.parentElement)
        .toBe(row.querySelector('[aria-label="Unpin Onboarding"]')?.parentElement);
    }
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
  });

  it("keeps an expanded project's task links when it is pinned and unpinned", async () => {
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch", status: "todo" }]);
    const recent = await projectRow(false);
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Pin Onboarding"]')!.click());
    const pinned = container.querySelector(".group\\/coordinator-pin")!;
    await act(async () => pinned.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(pinned.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
    await act(async () => pinned.querySelector<HTMLButtonElement>('[aria-label="Unpin Onboarding"]')!.click());
    expect(container.querySelector(".group\\/coordinator-pin")).toBeNull();
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
  });

  it("shows loading followed by the empty state", async () => {
    let resolve!: (tasks: never[]) => void;
    fixture.projectTasks.mockReturnValue(new Promise<never[]>(done => { resolve = done; }));
    const row = await projectRow(true);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    expect(row.querySelector('[role="status"]')?.textContent).toBe("Loading tasks…");
    await act(async () => resolve([]));
    await flush();
    expect(row.textContent).toContain("No tasks yet.");
  });

  it("reorders an expanded pinned project with the keyboard and keeps its tasks underneath", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch", status: "todo" }]);
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["project:company:project-1", "/artifacts"]));
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      const index = rows.indexOf(this);
      if (index < 0) return nativeRect.call(this);
      const top = index * 80;
      return { x: 0, y: top, top, bottom: top + 80, left: 0, right: 240, width: 240, height: 80, toJSON() {} };
    });
    try {
      const handle = container.querySelector<HTMLButtonElement>('[aria-label="Reorder pinned Onboarding"]')!;
      handle.focus();
      for (const code of ["Space", "ArrowDown", "Space"]) {
        await act(async () => {
          handle.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true, cancelable: true }));
          await new Promise(resolve => setTimeout(resolve, 0));
        });
      }
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      expect(rows.map(row => row.querySelector("a")?.getAttribute("href"))).toEqual(["/artifacts", "/projects/onboarding/issues"]);
      expect(rows[1]!.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
      expect(rows[1]!.querySelector('[aria-label="Collapse Onboarding"]')).not.toBeNull();
    } finally { rect.mockRestore(); }
  });

  it("shows a failed task read without removing project navigation", async () => {
    fixture.projectTasks.mockRejectedValue(new Error("Forbidden"));
    const row = await projectRow(true);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(row.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t load tasks.");
    expect(row.querySelector('a[href="/projects/onboarding/issues"]')).not.toBeNull();
  });

  it("does not reuse another person's expanded task cache", async () => {
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "First person's task", status: "todo" }]);
    const row = await projectRow(false);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(row.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
    fixture.userId = "another-person";
    fixture.projectTasks.mockResolvedValue([]);
    await renderSidebar();
    const recent = container.querySelector('[aria-label="Recents"]')!;
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
    expect(recent.textContent).toContain("No tasks yet.");
  });
});

describe("Coordinator with Responsibilities", () => {
  const primaryLinks = () =>
    [...container.querySelectorAll('nav[aria-label="Workspace navigation"] .design-sidebar-primary.my-2 > a, nav[aria-label="Workspace navigation"] .design-sidebar-primary.my-2 > div > a')]
      .map(link => link.getAttribute("href"));
  it("leads Chat, Tasks and Inbox with the Responsibilities home, named Dashboard, and leaves the classic dashboard out of More", async () => {
    fixture.enableResponsibilities = true;
    await renderSidebar();
    expect(primaryLinks()).toEqual(["/responsibilities", "/chats", "/issues", "/decisions"]);
    expect(container.querySelector('a[href="/responsibilities"] svg')?.classList.contains("lucide-compass")).toBe(true);
    expect(container.querySelector('a[href="/responsibilities"]')?.textContent).toBe("Dashboard");
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/projects"]')).not.toBeNull();
    expect(document.querySelector('a[href="/dashboard"]')).toBeNull();
  });
  it("keeps Chat first with no Responsibilities row while the flag is off", async () => {
    await renderSidebar();
    expect(primaryLinks()).toEqual(["/chats", "/issues", "/decisions"]);
    expect(container.querySelector('a[href="/responsibilities"]')).toBeNull();
  });
});
