// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), openNewChat: vi.fn(), pathname: "/COO/issues", collapsed: false, userId: "reviewer", agents: [] as any[], chats: [] as any[], recentTasks: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, projectTasks: vi.fn(), enableCases: false }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({ companyId: "company", userId: fixture.userId, enabled: true, agents: { data: fixture.agents }, chats: { data: fixture.chats }, session: { isSuccess: true } }), useOpenAgentChat: () => fixture.openNewChat }));
vi.mock("./AgentChatPicker", () => ({ AgentChatPicker: ({ open, onSelect, agents }: any) => open ? <button onClick={() => onSelect(agents[0])}>Choose agent</button> : null }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: fixture.recentTasks }) }));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: fixture.projectTasks } }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: fixture.collapsed, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableCases: fixture.enableCases }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => fixture.projects } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z", activityAt: "2026-10-20T12:00:00Z" }) as AttentionItem;
function feed(items: AttentionItem[]): AttentionFeed {
  return { companyId: "company", generatedAt: "2026-10-27T12:00:00Z", totalCount: items.length, deskBadgeCount: 0,
    nextCursor: null, countsBySourceKind: {} as AttentionFeed["countsBySourceKind"], items };
}

function summary(items: AttentionItem[]) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items);
  return counts;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.collapsed = false; fixture.userId = "reviewer"; fixture.pathname = "/COO/issues";
  fixture.chats = []; fixture.agents = []; fixture.recentTasks = []; fixture.projects = []; fixture.enableCases = false;
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("starts a new chat and links recent conversations by their own id", async () => {
    fixture.agents = [{ id: "agent", companyId: "company", name: "Alex", urlKey: "alex", status: "idle" }];
    fixture.chats = [{ id: "chat-one", conversationAgentId: "agent", updatedAt: "2026-10-20T12:00:00Z" }, { id: "chat-two", conversationAgentId: "agent", updatedAt: "2026-10-21T12:00:00Z" }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats/alex/chat-one"]')).not.toBeNull();
    expect(container.querySelector('a[href="/chats/alex/chat-two"]')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!.click());
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Choose agent")!.click());
    expect(fixture.openNewChat).toHaveBeenCalledWith(fixture.agents[0]);
  });
  it.each([false, true])("opens global search from the organization header when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
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
  it.each([false, true])("opens the task form from New task above Chat when collapsed is %s", async (collapsed) => {
    fixture.collapsed = collapsed;
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
  it.each([false, true])("keeps Cases reachable in More only when enabled (%s)", async enabled => {
    fixture.enableCases = enabled;
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/cases"]') !== null).toBe(enabled);
  });
  it("announces unread chat totals in expanded and collapsed navigation", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
    fixture.collapsed = true;
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"]')?.getAttribute("aria-label")).toBe("Chat, 2 unread chats");
  });
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it.each([false, true])("keeps pins above More without a separate section, restores and unpins when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
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
    if (collapsed) await click("More workspace pages");
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
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
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

  it("announces the full outstanding count when the sidebar is collapsed", async () => {
    fixture.collapsed = true;
    await renderSidebar();
    expect(decisionLink().getAttribute("aria-label")).toBe("Inbox, 2 decisions");
  });
});


describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });

  it("reuses the page-owned complete feed on Inbox without a second summary read", async () => {
    fixture.pathname = "/COO/decisions";
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([pending("review")]));
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(coordinatorAttentionQueryKey("company"), feed([])));
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
  });
});
