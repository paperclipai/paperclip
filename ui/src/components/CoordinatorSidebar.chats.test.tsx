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
import { formatDateTime } from "@/lib/utils";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), openNewChat: vi.fn(), pathname: "/COO/issues", search: "", userId: "reviewer" as string | null, agents: [] as any[], chats: [] as any[],
  recentTasks: [] as Array<Record<string, unknown>>, taskSummaries: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), enableCases: false, enableResponsibilities: false }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: fixture.userId }) }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId, enabled: true, agents: { data: fixture.agents }, chats: { data: fixture.chats }, session: { isSuccess: true },
}), useOpenAgentChat: () => fixture.openNewChat }));
vi.mock("./AgentChatPicker", () => ({ AgentChatPicker: ({ open, onSelect, agents }: any) => open ? <button onClick={() => onSelect(agents[0])}>Choose agent</button> : null }));
vi.mock("./AgentConversationsSidebar", () => ({ AgentConversationsSidebar: ({ onConversationOpened }: { onConversationOpened?: () => void }) => <><a href="/chats/alex/old">Old conversation</a><button onClick={onConversationOpened}>Create from history</button></> }));
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
  it("starts a new chat and links recent conversations by their own id", async () => {
    fixture.agents = [{ id: "agent", companyId: "company", name: "Alex", urlKey: "alex", status: "idle" }];
    fixture.chats = [{ id: "chat-one", title: "First chat", conversationAgentId: "agent", updatedAt: "2026-10-20T12:00:00Z" }, { id: "chat-two", title: "Second chat", conversationAgentId: "agent", updatedAt: "2026-10-21T12:00:00Z" }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats/alex/chat-one"]')).not.toBeNull();
    expect(container.querySelector('a[href="/chats/alex/chat-two"]')).not.toBeNull();
    expect(container.querySelector('a[href="/chats/alex/chat-one"]')?.textContent).toContain("First chat");
    const date = container.querySelector('a[href="/chats/alex/chat-one"] [data-slot="chat-recent-date"]');
    expect(date?.className).toContain("font-mono");
    expect(date?.textContent).toBe(formatDateTime("2026-10-20T12:00:00Z"));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="All conversations"]')!.click());
    expect(document.querySelector('a[href="/chats/alex/old"]')).not.toBeNull();
    // On a phone the dialog starts below the top inset; its height leaves that room so the last row stays visible.
    const history = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')!.className.split(/\s+/);
    expect(history).toContain("h-(--sz-calc-18)");
    expect(history).not.toContain("h-full");
    await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Create from history")!.click());
    expect(document.querySelector('a[href="/chats/alex/old"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!.click());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Choose agent")!.click());
    expect(fixture.openNewChat).toHaveBeenCalledWith(fixture.agents[0]);
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
    // A recent chat row opens its own conversation.
    expect(links.slice(0, 4)).toEqual(["/projects/project-1/issues", "/projects/project-0/issues", "/issues/TASK-299", "/chats/agent-99/chat-99"]);
    expect(links.at(-1)).toBe("/issues/TASK-0");
    expect(new Set(links).size).toBe(links.length);
    expect(fixture.projectTasks).not.toHaveBeenCalled();
    expect(reads).toBeGreaterThanOrEqual(inputCount);
  });
});

describe("Coordinator pinned pages", () => {
  it("matches pinned and recent agent avatar dimensions to task status icons", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const chat = { id: "chat-cto", conversationAgentId: "cto", updatedAt: "2026-11-11T12:00:00Z", title: "CTO chat", createdAt: "2026-11-11T12:00:00Z", isUnreadForMe: false };
    fixture.chats = [chat];
    fixture.recentTasks = [{ id: "task", companyId: "company", identifier: "TASK-1", title: "Recent task", status: "todo", recordedAt: 1 }];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["agent-chat:company:cto"]));

    await renderSidebar();

    const avatars = [...container.querySelectorAll<HTMLImageElement>('a[href="/chats/cto"] [data-slot="agent-avatar"] img, a[href="/chats/cto/chat-cto"] [data-slot="agent-avatar"] img')];
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
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

