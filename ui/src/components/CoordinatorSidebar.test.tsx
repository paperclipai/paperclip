// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ attention: vi.fn(), collapsed: false, userId: "reviewer" }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId, agents: { data: [] }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: fixture.collapsed, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/COO/decisions" }),
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

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.collapsed = false; fixture.userId = "reviewer";
  fixture.attention.mockResolvedValue(feed([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator pinned pages", () => {
  const pinnedPages = () => container.querySelector('[aria-label="Pinned pages"]');
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it("pins from More without navigating, restores after remount, and unpins from the sidebar", async () => {
    await renderSidebar();
    expect(pinnedPages()).toBeNull();
    await click("More workspace pages");
    expect(document.activeElement).toBe(document.querySelector('[data-slot="popover-content"]'));
    await click("Pin Projects");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pinnedPages()?.querySelector('a[href="/projects"]')?.textContent).toBe("Projects");
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPages()?.querySelector('a[href="/projects"]')).not.toBeNull();
    await click("Unpin Projects");
    expect(pinnedPages()).toBeNull();
  });

  it("keeps pins personal and only renders known destinations", async () => {
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["/projects", "/unknown", "https://example.com"]));
    await renderSidebar();
    expect(pinnedPages()?.querySelectorAll("a")).toHaveLength(1);
    fixture.userId = "other-user";
    await renderSidebar();
    expect(pinnedPages()).toBeNull();
    fixture.userId = "reviewer";
    await renderSidebar();
    expect(pinnedPages()?.textContent).toContain("Projects");
  });

  it("reflects pins changed in another browser tab", async () => {
    await renderSidebar();
    const key = "paperclip.coordinator.pinned-nav.v1:reviewer";
    await act(async () => {
      localStorage.setItem(key, JSON.stringify(["/agents/all"]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(pinnedPages()?.querySelector('a[href="/agents/all"]')?.textContent).toBe("Agents");
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("Coordinator Needs You badge", () => {
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).toHaveBeenCalledWith("company", { all: true });
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("updates after canonical attention refreshes and removes the badge once every decision is resolved", async () => {
    await renderSidebar();
    fixture.attention.mockResolvedValue(feed([pending("review")]));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    fixture.attention.mockResolvedValue(feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }, { id: "accepted-review" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(decisionLink().textContent).toBe("Needs You");
  });

  it("announces the full outstanding count when the sidebar is collapsed", async () => {
    fixture.collapsed = true;
    await renderSidebar();
    expect(decisionLink().getAttribute("aria-label")).toBe("Needs You, 2 decisions");
  });
});
