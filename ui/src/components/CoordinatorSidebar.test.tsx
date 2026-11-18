// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { buildPinnedNavigationItems, CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey, coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), pathname: "/COO/issues", search: "", userId: "reviewer" as string | null, chats: [] as Array<{ isUnreadForMe: boolean }>,
  recentTasks: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), enableCases: false, enableResponsibilities: false, agents: [] as Agent[] }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: fixture.userId }) }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId, agents: { data: fixture.agents }, chats: { data: fixture.chats }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: fixture.recentTasks }) }));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: fixture.projectTasks } }));
const taskPrefetch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/issueDetailCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/issueDetailCache")>(),
  prefetchIssueDetailForNavigation: taskPrefetch,
}));
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
  fixture.chats = []; fixture.recentTasks = []; fixture.projects = []; fixture.enableCases = false; fixture.enableResponsibilities = false; fixture.agents = [];
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("shows every task once in a four-level recent chain", async () => {
    fixture.recentTasks = ["a", "b", "c", "d"].map((id, index) => ({
      id, companyId: "company", identifier: `TASK-${id}`, title: `Task ${id}`, status: "todo", recordedAt: index,
      parentId: index ? ["a", "b", "c"][index - 1] : null, subtaskCount: index < 3 ? 1 : 0,
    }));
    fixture.projectTasks.mockImplementation(async (_company, filters) => fixture.recentTasks.filter(task => task.parentId === filters.parentId));
    await renderSidebar();
    const region = container.querySelector('[aria-label="Recents"]')!;
    expect(region.querySelectorAll("a")).toHaveLength(4);
    for (const id of ["a", "b", "c", "d"]) expect(region.querySelectorAll(`a[href="/issues/TASK-${id}"]`)).toHaveLength(1);
  });
  it("nests recent children once, limits the first page to ten, and keeps folding separate from read state", async () => {
    fixture.recentTasks = [
      { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 14, unreadSubtaskCount: 12, isUnreadForMe: false },
      { id: "child-00", companyId: "company", identifier: "TASK-2", title: "Child 0", status: "todo", recordedAt: 2, parentId: "parent", isUnreadForMe: true },
    ];
    fixture.projectTasks.mockImplementation(async (_company, filters) => Array.from({ length: filters.afterId ? 4 : 10 }, (_, index) => ({
      id: `child-${String(index + (filters.afterId ? 10 : 0)).padStart(2, "0")}`, companyId: "company", parentId: "parent",
      identifier: `CHILD-${index + (filters.afterId ? 10 : 0)}`, title: `Child ${index + (filters.afterId ? 10 : 0)}`, status: "todo", isUnreadForMe: true,
    })));
    await renderSidebar();
    const region = () => container.querySelector('[aria-label="Recents"]')!;
    expect(region().querySelectorAll("a")).toHaveLength(11);
    expect(region().textContent?.match(/Child 0/g)).toHaveLength(1);
    const collapse = region().querySelector<HTMLButtonElement>('[aria-label="Collapse subtasks of Parent"]')!;
    await act(async () => collapse.click());
    expect(region().querySelectorAll("a")).toHaveLength(1);
    expect(region().textContent).toContain("12 unread");
    await act(async () => region().querySelector<HTMLButtonElement>('[aria-label="Expand subtasks of Parent"]')!.click());
    await act(async () => Array.from(region().querySelectorAll("button")).find(button => button.textContent?.includes("Show more"))!.click());
    await flush();
    expect(region().querySelectorAll("a")).toHaveLength(15);
    expect(region().textContent).toContain("Show less");
    expect(fixture.projectTasks).toHaveBeenCalledWith("company", expect.objectContaining({ parentId: "parent", limit: 10, afterId: "child-09", includeReadState: true }), expect.anything());
  });
  it("keeps the selected child beyond ten visible within the ten-row preview", async () => {
    fixture.pathname = "/COO/issues/TASK-12";
    fixture.recentTasks = [
      { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 14 },
      { id: "child-12", companyId: "company", identifier: "TASK-12", title: "Selected child", status: "todo", recordedAt: 2, parentId: "parent", isUnreadForMe: true },
    ];
    fixture.projectTasks.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      id: `child-${index}`, companyId: "company", parentId: "parent", identifier: `PAGE-${index}`, title: `Page child ${index}`, status: "todo",
    })));
    await renderSidebar();
    expect(container.querySelectorAll('[role="group"][aria-label="Subtasks of Parent"] a')).toHaveLength(10);
    expect(container.querySelector('a[href="/issues/TASK-12"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/TASK-12"] [aria-label="Unread"]')).not.toBeNull();
    expect(container.querySelector('a[href="/issues/TASK-1"] [aria-label="Unread"]')).toBeNull();
  });
  it("keeps the parent link on a failed child read and retries without navigation", async () => {
    fixture.recentTasks = [{ id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 1 }];
    fixture.projectTasks.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce([
      { id: "child", companyId: "company", parentId: "parent", identifier: "CHILD", title: "Recovered child", status: "todo" },
    ]);
    await renderSidebar();
    expect(container.querySelector('a[href="/issues/TASK-1"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry")!.click());
    await flush();
    expect(container.textContent).toContain("Recovered child");
    expect(fixture.pathname).toBe("/COO/issues");
  });
  it("keeps cached children visible during a temporary refetch failure", async () => {
    fixture.recentTasks = [{ id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 1 }];
    fixture.projectTasks.mockResolvedValue([{ id: "child", companyId: "company", parentId: "parent", identifier: "CHILD", title: "Cached child", status: "todo" }]);
    await renderSidebar();
    fixture.projectTasks.mockRejectedValue(Object.assign(new Error("Gateway unavailable"), { status: 503 }));
    await act(async () => { await client.invalidateQueries({ queryKey: ["issues", "company", "recent-subtasks"] }); });
    expect(container.textContent).toContain("Cached child");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('a[href="/issues/CHILD"]')).not.toBeNull();
  });
  it("keeps every recent entry below the section header instead of truncating at twelve", async () => {
    fixture.recentTasks = Array.from({ length: 20 }, (_, index) => ({
      id: `task-${index}`, companyId: "company", identifier: `TASK-${index}`, title: `Recent task ${index}`, status: "todo", recordedAt: index,
    }));
    await renderSidebar();
    const region = container.querySelector('[role="region"][aria-label="Recents"]')!;
    expect(region.querySelectorAll("a")).toHaveLength(20);
    expect(region.textContent).not.toContain("Recents");
    expect(region.querySelector('a[href="/issues/TASK-0"]')).not.toBeNull();
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
  it("builds hundreds of agent pins with input reads proportional to list size", () => {
    const agents = Array.from({ length: 500 }, (_, index) => ({ id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}` } as Agent));
    const pins = agents.map(agent => `agent-chat:company:${agent.id}`).reverse();
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * agents.length) throw new Error("Pin construction scans growing lists repeatedly");
        return Reflect.get(target, property, receiver);
      } });
    }
    const items = buildPinnedNavigationItems(bounded(pins), bounded(agents), []);
    expect(items.map(item => item.key)).toEqual(pins);
    expect(reads).toBeLessThanOrEqual(4 * agents.length);
    expect(items[0].to).toBe("/chats/agent-499");
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

  it("shows project tasks with their full status presentation", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.projectTasks.mockResolvedValue([
      { id: "task-1", identifier: "ONB-1", title: "Blocked parent", status: "blocked", displayStatus: "blocked", blockerAttention: covered },
      { id: "task-3", identifier: "ONB-3", title: "Waiting review", status: "in_review", displayStatus: "in_review", externalConversationState: "waiting" },
    ]);
    fixture.pathname = "/COO/projects/onboarding";
    await renderSidebar();
    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand Onboarding"]');
    expect(expand).not.toBeNull();
    await act(async () => expand!.click());
    await flush();
    expect(fixture.projectTasks).toHaveBeenCalledWith("company", expect.objectContaining({ projectId: "project-1", projection: "rows" }));
    expect(glyph("/issues/ONB-1")?.style.color).toBe("var(--status-task-icon-in_queue)");
    expect(glyph("/issues/ONB-3")?.getAttribute("aria-label")).toBe("Idle");
    // A press on a project task warms its chat like a task list row does.
    const link = container.querySelector<HTMLAnchorElement>('a[href="/issues/ONB-3"]');
    taskPrefetch.mockClear();
    await act(async () => link!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    expect(taskPrefetch).toHaveBeenCalledWith(expect.anything(), "ONB-3", expect.objectContaining({ history: true }));
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
