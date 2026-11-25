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
  recentTasks: [] as Array<Record<string, unknown>>, taskSummaries: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), preferenceError: null as Error | null, preferenceRetry: vi.fn(), recentLimit: 10000, warmup: vi.fn(), enableCases: false, enableResponsibilities: false, agents: [] as Agent[] }));
vi.mock("@/hooks/useRecentItemsLimit", () => ({ useRecentItemsLimit: () => ({ limit: fixture.recentLimit, loaded: !fixture.preferenceError, error: fixture.preferenceError, retry: fixture.preferenceRetry }) }));
vi.mock("@/hooks/useRecentTaskOpenWarmup", () => ({ useRecentTaskOpenWarmup: fixture.warmup }));
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
  vi.clearAllMocks(); fixture.preferenceError = null; fixture.recentLimit = 10000; localStorage.clear(); fixture.userId = "reviewer"; fixture.pathname = "/COO/issues"; fixture.search = "";
  fixture.chats = []; fixture.recentTasks = []; fixture.taskSummaries = []; fixture.projects = []; fixture.enableCases = false; fixture.enableResponsibilities = false; fixture.agents = [];
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("explains a failed first preference read and lets the person retry", async () => {
    fixture.recentLimit = 0;
    fixture.preferenceError = new Error("Preferences unavailable");
    await renderSidebar();
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    const retry = alert?.querySelector("button");
    expect(retry?.textContent).toContain("Retry");
    await act(async () => retry?.click());
    expect(fixture.preferenceRetry).toHaveBeenCalledTimes(1);
  });

  it("bounds the combined Recents list and warms only displayed tasks", async () => {
    fixture.recentLimit = 5;
    fixture.agents = [{ id: "agent", companyId: "company", name: "Alex", urlKey: "alex", status: "idle" } as Agent];
    fixture.chats = Array.from({ length: 100 }, (_, i) => ({ id: `chat-${i}`, conversationAgentId: "agent", updatedAt: new Date(10000 + i).toISOString(), isUnreadForMe: false }));
    fixture.recentTasks = Array.from({ length: 100 }, (_, i) => ({ id: `task-${i}`, companyId: "company", title: `Task ${i}`, identifier: null, status: "todo", recordedAt: i }));
    await renderSidebar();
    expect(container.querySelectorAll('[aria-label="Recents"] a')).toHaveLength(5);
    expect(fixture.warmup.mock.lastCall?.[0].tasks).toHaveLength(0);
    fixture.recentLimit = 0;
    await renderSidebar();
    expect(container.querySelector('[aria-label="Recents"]')).toBeNull();
    expect(fixture.warmup.mock.lastCall?.[0].tasks).toHaveLength(0);
  });

});

afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

