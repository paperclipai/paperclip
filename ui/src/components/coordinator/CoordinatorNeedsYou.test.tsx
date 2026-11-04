// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "./CoordinatorNeedsYou";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ pending: [] as AttentionItem[], byView: {} as Record<string, AttentionItem[]>, viewCounts: undefined as undefined | Record<string, number>, listCalls: [] as unknown[], claim: vi.fn(async () => ({})), close: vi.fn(async (..._args: unknown[]) => ({ until: null })), retryTask: vi.fn(async (..._args: unknown[]) => ({ accepted: true, requestId: "r", stale: false, presentation: null })), history: [] as DecisionHistoryItem[], url: "/decisions", mobile: false, partial: false, historyFail: false, feedFail: false, openPanel: vi.fn(), closePanel: vi.fn(), setPanelVisible: vi.fn(), navigate: vi.fn(), breadcrumbs: vi.fn(), boardAccess: null as null | Record<string, unknown>, historyByScope: {} as Record<string, DecisionHistoryItem[]>, historyCalls: [] as Array<Record<string, unknown>>, resolveIncident: vi.fn(async (..._args: unknown[]) => ({})) }));
const dismissals = vi.hoisted(() => ({ restore: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("@/api/inboxDismissals", () => ({ inboxDismissalsApi: { restore: dismissals.restore, dismiss: vi.fn() } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ openPanel: fixture.openPanel, closePanel: fixture.closePanel, setPanelVisible: fixture.setPanelVisible }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: fixture.mobile }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "reviewer" }) }));
vi.mock("@/lib/router", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/router")>(), useNavigate: () => fixture.navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: {
  listUserDirectory: async () => ({ users: [{ principalId: "dotta", status: "active", user: { name: "Dotta" } }] }),
  getCurrentBoardAccess: async () => { if (!fixture.boardAccess) throw new Error("No board access"); return fixture.boardAccess; },
} }));
vi.mock("@/api/issues", () => ({ issuesApi: { retryTask: fixture.retryTask } }));
vi.mock("@/api/budgets", () => ({ budgetsApi: { resolveIncident: fixture.resolveIncident } }));
vi.mock("@/api/attention", () => ({ attentionApi: {
  claim: fixture.claim,
  close: fixture.close,
  list: async (_companyId: string, options: { view?: string }) => {
    fixture.listCalls.push(options);
    if (fixture.feedFail) throw new Error("Feed unavailable");
    return { items: [...(fixture.byView[options.view ?? ""] ?? fixture.pending)], viewCounts: fixture.viewCounts };
  },
  history: async (_companyId: string, options: Record<string, unknown> = {}) => {
    fixture.historyCalls.push(options);
    if (fixture.historyFail) throw new Error("History unavailable");
    return { items: [...(fixture.historyByScope[String(options.scope)] ?? fixture.history)], nextCursor: null };
  },
} }));
vi.mock("motion/react", () => ({
  LayoutGroup: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  motion: { article: ({ children, className }: { children: ReactNode; className: string }) => <article className={className}>{children}</article>, div: ({ children, id, tabIndex }: { children: ReactNode; id?: string; tabIndex?: number }) => <div id={id} tabIndex={tabIndex}>{children}</div> },
}));
vi.mock("@/components/PropertiesPanel", () => ({ PROPERTIES_PANE_HEADER_SLOT_ID: "test-sidebar" }));
vi.mock("@/components/DecisionResolver", () => ({ DecisionResolver: () => null }));
vi.mock("@/components/StalledReviewActions", () => ({ StalledReviewActions: ({ issueId, approveLabel, reviewPolicy, onResolved }: { issueId: string; approveLabel: string; reviewPolicy: string; onResolved: () => void }) => <button data-review-policy={reviewPolicy} onClick={() => {
  fixture.pending = fixture.pending.filter((item) => item.subject.id !== issueId);
  onResolved();
}}>{approveLabel}</button> }));
vi.mock("@/components/AttentionInteractionResolver", () => ({ AttentionInteractionResolver: ({ issueId, interactionId, footerSlot, onResolved }: { issueId: string; interactionId: string; footerSlot?: ReactNode; onResolved: (interaction: { status: string }) => void }) => <>{footerSlot}<button data-issue-id={issueId} onClick={() => {
  if (fixture.partial) { onResolved({ status: "pending" }); return; }
  fixture.pending = fixture.pending.filter((item) => item.subject.id !== interactionId);
  fixture.history.push({ id: `issue_thread_interaction:${interactionId}`, sourceKind: "issue_thread_interaction", sourceId: interactionId,
    issueId: `task-${interactionId}`, issueIdentifier: `PAP-${interactionId}`, issueTitle: `Task ${interactionId}`, title: "Decision", label: interactionId === "3" ? "Answers recorded" : "Approved", outcome: interactionId === "3" ? "answered" : "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: `/PAP/issues/PAP-${interactionId}#interaction-${interactionId}`, target: null });
  onResolved({ status: "answered" });
}}>Resolve {interactionId}</button></> }));

function Location() { return <output data-location>{useLocation().search}</output>; }

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  fixture.pending = ["1", "2", "3"].map((id) => ({ id, sourceKind: "issue_thread_interaction", inlineResolvable: true, subject: { id, kind: "interaction", title: `Review ${id}`, metadata: { issueId: `task-${id}` } }, relatedIssue: { id: `task-${id}`, identifier: `PAP-${id}`, title: `Task ${id}`, href: `/PAP/issues/PAP-${id}` }, activityAt: new Date().toISOString() } as unknown as AttentionItem));
  fixture.history = []; fixture.url = "/decisions"; vi.clearAllMocks();
  fixture.byView = {}; fixture.viewCounts = undefined; fixture.listCalls = []; fixture.boardAccess = null; fixture.historyByScope = {}; fixture.historyCalls = [];
  fixture.historyFail = false; fixture.feedFail = false; fixture.partial = false; fixture.mobile = false;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
  expect(button, text).toBeTruthy();
  await act(async () => button!.click()); await flush();
}
async function renderPage(url = fixture.url) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
  return client;
}
describe("Coordinator Needs You — Archived view and history filters (PAP-749 task 2e)", () => {
  const hidden = (id: string, kind: "dismiss" | "snooze", snoozedUntil: string | null = null) => ({
    id, sourceKind: "issue_thread_interaction", inlineResolvable: false, dismissalKey: `attention:${id}`, changeFingerprint: `${id}.me`,
    closeModes: ["withdraw", "archive", "snooze"], obligationKey: null, obligationLeadId: null, audience: { kind: "user", userId: "reviewer", reason: "addressee" },
    dismissal: { kind, dismissedAt: "2026-10-29T12:00:00.000Z", snoozedUntil, isActive: true },
    subject: { id: `${id}-interaction`, kind: "interaction", title: `Hidden ${id}`, href: `/PAP/issues/PAP-9#${id}`, metadata: {} },
    relatedIssue: null, activityAt: new Date().toISOString(),
  }) as unknown as AttentionItem;

  it("lists your archived cards with their date and a Snoozed group, and restores one", async () => {
    fixture.byView = { archived: [hidden("arch", "dismiss"), hidden("snz", "snooze", "2026-10-31T09:00:00.000Z")] };
    fixture.viewCounts = { mine: 2, unassigned: 0, company: 0, archived: 2 };
    const client = await renderPage("/decisions?view=archived");
    expect(fixture.listCalls).toContainEqual(expect.objectContaining({ view: "archived", all: true }));
    // Focus (PAP-770): Archived opens from the View menu, not a persistent tab;
    // a quiet label names the current view.
    expect(container.querySelector("[data-attention-view-menu]")).not.toBeNull();
    expect(container.textContent).toContain("Showing");
    const archivedCard = container.querySelector<HTMLElement>('[data-attention-card="arch"]')!;
    expect(archivedCard.querySelector('[data-attention-hidden="archived"]')?.textContent).toMatch(/^Archived /);
    const group = container.querySelector<HTMLElement>("[data-attention-snoozed-group]")!;
    expect(group.textContent).toContain("Snoozed (1)");
    expect(group.querySelector('[data-attention-card="snz"] [data-attention-hidden="snoozed"]')).not.toBeNull();
    expect(group.querySelector('[data-attention-card="arch"]')).toBeNull();

    const trigger = archivedCard.querySelector<HTMLElement>("[data-attention-close-menu]")!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.querySelector('[data-attention-close-mode="archive"]')).toBeNull();
    await act(async () => document.body.querySelector<HTMLElement>('[data-attention-close-mode="restore"]')!.click());
    await flush();
    expect(dismissals.restore).toHaveBeenCalledWith("company", "attention:arch");
    expect(container.querySelector('[data-attention-card="arch"]')).toBeNull();
    client.clear();
  });

  it("shows the Archived empty state", async () => {
    fixture.byView = { archived: [] };
    const client = await renderPage("/decisions?view=archived");
    expect(container.textContent).toContain("Nothing archived. Cards you archive or snooze for yourself show here.");
    client.clear();
  });

  it("filters history by Withdrawn, Expired and Closed with task, and names who withdrew and why", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    fixture.history = [{ id: "approval:appr", sourceKind: "approval", sourceId: "appr", issueId: null, issueIdentifier: null, issueTitle: null,
      title: "Hire a designer", label: "Withdrawn by user", outcome: "cancelled", resultOutcome: "withdrawn", reason: "Budget moved to Q1",
      resolvedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), resolvedByUserId: "dotta", resolvedByAgentId: null,
      agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/approvals/appr", target: null }];
    const historySpy = vi.spyOn(await import("@/api/attention").then((module) => module.attentionApi), "history");
    const client = await renderPage();
    await click("Decision history");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const outcome = dialog.querySelector<HTMLSelectElement>('[aria-label="Filter decision outcomes"]')!;
    const labels = [...outcome.options].map((option) => option.textContent);
    expect(labels).toEqual(expect.arrayContaining(["Withdrawn", "Expired", "Closed with task", "Handled for me"]));
    expect(dialog.textContent).toContain("Withdrawn by @Dotta");
    expect(dialog.textContent).toContain("Reason: Budget moved to Q1");
    expect(dialog.textContent).toContain("Approval · Hire a designer");
    await act(async () => {
      outcome.value = "issue_closed";
      outcome.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(historySpy).toHaveBeenCalledWith("company", expect.objectContaining({ outcome: "issue_closed" }));
    client.clear();
  });

  const historyEntry = (id: string, issueTitle: string, resolvedByUserId: string) => ({ id: `issue_thread_interaction:${id}`, sourceKind: "issue_thread_interaction",
    sourceId: id, issueId: `task-${id}`, issueIdentifier: `NEE-${id}`, issueTitle, title: "Confirm", label: "Approved", outcome: "accepted",
    action: { outcome: "approved", detail: null }, resolvedAt: new Date(Date.now() - 60_000).toISOString(), resolvedByUserId, resolvedByAgentId: null,
    agentId: null, agentName: null, projectId: null, projectName: null, href: `/NEE/issues/NEE-${id}`, target: null }) as DecisionHistoryItem;
  const choose = async (root: ParentNode, label: string, value: string) => {
    const select = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
    expect(select, label).not.toBeNull();
    await act(async () => { select!.value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    return select!;
  };

  it("opens Decision history and Recent Decisions on Handled by me or for me, with Everyone one choice away (PAP-768)", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    const mineEntry = historyEntry("1", "Dotta's launch checklist", "reviewer");
    const othersEntry = historyEntry("2", "Scott: task you created", "scott");
    fixture.historyByScope = { mine: [mineEntry], all: [mineEntry, othersEntry] };
    const client = await renderPage();
    expect(fixture.historyCalls).toContainEqual(expect.objectContaining({ scope: "mine", limit: 100 }));
    const recent = () => container.querySelector<HTMLElement>('[aria-label="Recent Decisions"]')!;
    expect(recent().textContent).toContain("NEE-1 · Dotta's launch checklist");
    expect(recent().textContent).not.toContain("Scott: task you created");
    await choose(recent(), "Whose recent decisions", "all");
    expect(fixture.historyCalls).toContainEqual(expect.objectContaining({ scope: "all", limit: 100 }));
    expect(recent().textContent).toContain("NEE-2 · Scott: task you created");

    await click("Decision history");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const scope = dialog.querySelector<HTMLSelectElement>('select[aria-label="Whose decision history"]')!;
    expect(scope.value).toBe("mine");
    expect([...scope.options].map((option) => option.textContent)).toEqual(["Handled by me or for me", "Everyone"]);
    expect(dialog.textContent).not.toContain("Scott: task you created");
    await choose(dialog, "Whose decision history", "all");
    expect(dialog.textContent).toContain("NEE-2 · Scott: task you created");
    // An outcome filter applies within the chosen scope.
    await choose(dialog, "Filter decision outcomes", "accepted");
    expect(fixture.historyCalls).toContainEqual(expect.objectContaining({ scope: "all", outcome: "accepted", limit: 40 }));
    client.clear();
  });

  it("offers everyone's decisions when nothing was handled by or for you (PAP-768)", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    fixture.historyByScope = { mine: [], all: [historyEntry("2", "Scott: task you created", "scott")] };
    const client = await renderPage();
    // Nothing of yours in the last day: Recent Decisions stays out of the way.
    expect(container.querySelector('[aria-label="Recent Decisions"]')).toBeNull();
    await click("Decision history");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("No decisions handled by you or for you yet.");
    await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Show everyone's decisions")!.click());
    await flush();
    expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="Whose decision history"]')!.value).toBe("all");
    expect(dialog.textContent).toContain("Scott: task you created");
    client.clear();
  });
});
describe("Coordinator Needs You", () => {
  it("reveals and focuses a linked decision beyond the first rendering window, then consumes only its URL parameter", async () => {
    fixture.url = "/decisions?decisionId=target&q=kept";
    fixture.pending = Array.from({ length: 61 }, (_, index) => ({ ...fixture.pending[0], id: `decision-${index}`, sourceKind: "decision",
      subject: { id: index === 60 ? "target" : `decision-${index}`, kind: "decision", title: `Decision ${index}` },
      activityAt: new Date(Date.now() - index * 1000).toISOString(),
    })) as AttentionItem[];
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scroll });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush(); await flush();
    const card = container.querySelector("#coordinator-decision-target");
    expect(card).not.toBeNull();
    expect(document.activeElement).toBe(card);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
    expect(container.querySelector("[data-location]")?.textContent).toBe("?q=kept");
    // Consumed links must not refocus on an ordinary feed refresh.
    scroll.mockClear();
    await act(async () => { await client.invalidateQueries({ queryKey: ["attention"] }); }); await flush();
    expect(scroll).not.toHaveBeenCalled();
    client.clear();
  });
  it("opens searchable history from both phone buttons without the hidden desktop panel", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    fixture.history = [{ id: "old-decision", sourceKind: "issue_thread_interaction", sourceId: "old", issueId: "task-1", issueIdentifier: "PAP-1", issueTitle: "Earlier launch", title: "Review", label: "Approved", outcome: "accepted", resolvedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-old", target: null }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    for (const label of ["Decision history", "Open decision history"]) {
      const trigger = [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === label);
      expect(trigger).toBeTruthy();
      await act(async () => trigger!.click()); await flush();
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.querySelector('[aria-label="Search decision history"]')).not.toBeNull();
      expect(dialog!.textContent).toContain("Earlier launch");
      expect(fixture.openPanel).not.toHaveBeenCalled();
      const close = [...dialog!.querySelectorAll("button")].find(button => button.textContent === "Close");
      await act(async () => close!.click()); await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    client.clear();
  });
  it("keeps a partial review actionable even when history is unavailable", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    fixture.partial = true; fixture.historyFail = true;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(true);
    expect(container.querySelector('[data-motion="gather"]')).toBeNull();
    fixture.partial = false;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(false);
    client.clear();
  });
  it.each([false, true])("does not restore a saved decision when history refresh fails (stale feed: %s)", async staleFeed => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    fixture.historyFail = true; fixture.feedFail = staleFeed;
    await click("Resolve 1"); await flush();
    expect([...container.querySelectorAll("button")].some(button => button.textContent === "Resolve 1")).toBe(false);
    expect(container.textContent).toContain("Recent decisions could not be loaded");
    expect(container.textContent).toContain("Resolve 2");
    client.clear();
  });
  it("sorts, groups, and filters the recent decisions shown beneath the toolbar", async () => {
    fixture.pending = [];
    const now = Date.now();
    fixture.history = [
      { id: "recent-old", sourceId: "old", issueIdentifier: "PAP-1", issueTitle: "First task", projectId: "launch", projectName: "Launch", resolvedAt: new Date(now - 180_000).toISOString() },
      { id: "recent-middle", sourceId: "middle", issueIdentifier: "PAP-2", issueTitle: "Second task", projectId: "other", projectName: "Other", resolvedAt: new Date(now - 120_000).toISOString() },
      { id: "recent-new", sourceId: "new", issueIdentifier: "PAP-3", issueTitle: "Third task", projectId: "launch", projectName: "Launch", resolvedAt: new Date(now - 60_000).toISOString() },
    ].map((item) => ({ sourceKind: "issue_thread_interaction", issueId: item.sourceId, agentId: null, agentName: null,
      title: "Review", outcome: "accepted", label: "Approved", resolvedByUserId: "reviewer", resolvedByAgentId: null,
      href: `/PAP/issues/${item.issueIdentifier}`, target: null, ...item })) as DecisionHistoryItem[];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    // Focus (PAP-770): filters are on request — open them before sorting/grouping.
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Filter and search"]')!.click());
    await flush();
    const visibleIds = () => [...container.querySelectorAll('[aria-label="Recent Decisions"] .coordinator-decision-receipt')]
      .map((item) => item.textContent?.match(/PAP-\d+/)?.[0]);
    const changeSelect = async (label: string, value: string) => {
      const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
      expect(select).not.toBeNull();
      await act(async () => { select!.value = value; select!.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    expect(visibleIds()).toEqual(["PAP-3", "PAP-2", "PAP-1"]);
    await changeSelect("Sort decisions", "oldest");
    expect(visibleIds()).toEqual(["PAP-1", "PAP-2", "PAP-3"]);
    await changeSelect("Group decisions", "task");
    expect([...container.querySelectorAll('[aria-label="Recent Decisions"] h3')].map((item) => item.textContent)).toEqual(["PAP-1", "PAP-2", "PAP-3"]);
    await changeSelect("Filter decisions by project", "launch");
    expect(visibleIds()).toEqual(["PAP-1", "PAP-3"]);
    client.clear();
  });

  it("resizes and gathers light in place before moving the saved receipt into Recent Decisions", async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const animate = vi.fn().mockReturnValue({ cancel: vi.fn() });
    HTMLElement.prototype.animate = animate;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { width: 500, height: this.querySelector("article") ? 320 : 80 } as DOMRect;
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ getPropertyValue: (name: string) => name.endsWith("ease") ? "ease-out" : name.includes("light") ? "1400ms" : name.includes("morph") ? "480ms" : "0ms" } as CSSStyleDeclaration);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.querySelector("[data-motion]")).toBeNull();
    vi.useFakeTimers();
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Resolve 1")!.click());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const transition = container.querySelector('[data-motion="gather"]');
    expect(transition?.textContent).toContain("Approved");
    expect(transition?.textContent).toContain("PAP-1");
    expect(container.querySelector('[aria-label="Recent Decisions"]')).toBeNull();
    expect(animate.mock.calls[0]?.[0]).toEqual([{ height: "320px", width: "500px" }, { height: "80px", width: "500px" }]);
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 480 });
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(container.querySelector("[data-motion]")).toBeNull();
    expect(container.querySelector('[aria-label="Recent Decisions"]')?.textContent).toContain("PAP-1");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
    client.clear();
  });
  it("renders a pending canonical question from persistent chat with its original resolver and context", async () => {
    fixture.pending = [{ id: "issue_thread_interaction:interaction:chat-question", sourceKind: "issue_thread_interaction", inlineResolvable: true,
      subject: { id: "chat-question", kind: "interaction", title: "Choose the screen", metadata: { kind: "ask_user_questions", issueId: "chat-issue" } },
      relatedIssue: { id: "chat-issue", identifier: "PAP-10", title: "Chat with Chief of Staff", href: "/PAP/issues/PAP-10" },
      detail: { kind: "questions", questionCount: 1, firstQuestionText: "Which screen should we redesign?", images: [] },
      activityAt: new Date().toISOString() } as unknown as AttentionItem];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector('[data-issue-id="chat-issue"]')?.textContent).toBe("Resolve chat-question");
    expect(container.textContent).toContain("Chat with Chief of Staff");
    expect(container.textContent).not.toContain("You're caught up.");
    await click("PAP-10");
    expect(fixture.navigate).toHaveBeenCalledWith("/PAP/issues/PAP-10");
  });
  it("keeps a distinct stalled task actionable after its document decision is recorded", async () => {
    fixture.pending = [{ id: "review:task-1", sourceKind: "review", inlineResolvable: true,
      subject: { id: "task-1", kind: "issue", title: "Launch copy", identifier: "PAP-1", href: "/PAP/issues/PAP-1", metadata: { reviewAttentionState: "stalled", reviewPolicy: "human_only" } },
      activityAt: new Date().toISOString() } as unknown as AttentionItem];
    fixture.history = [{ id: "issue_thread_interaction:approved-copy", sourceKind: "issue_thread_interaction", sourceId: "approved-copy", issueId: "task-1", issueIdentifier: "PAP-1", issueTitle: "Launch copy", title: "Copy review", label: "Approved", outcome: "accepted", resolvedAt: new Date().toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-approved-copy", target: null }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(container.textContent).toContain("Choose how this task continues");
    expect(container.textContent).not.toContain("Open to review");
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
    expect(container.querySelector("[data-review-policy]")?.getAttribute("data-review-policy")).toBe("human_only");
    await click("Mark task done");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("You're caught up.");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(1);
  });
  it("retains all three decisions as receipts, including an answered question, and opens history only on demand", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(fixture.openPanel).not.toHaveBeenCalled();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    await click("Resolve 1"); await click("Resolve 2"); await click("Resolve 3");
    await flush();
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("Recent Decisions");
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(3);
    expect(container.textContent).toContain("Answers recorded");
    await click("PAP-3");
    expect(fixture.navigate).toHaveBeenCalledWith("/PAP/issues/PAP-3#interaction-3");
    await click("Decision history");
    expect(fixture.openPanel).toHaveBeenCalled();
    expect(fixture.setPanelVisible).toHaveBeenCalledWith(true);
    // The shared desktop hide control changes visibility without closing
    // this tab. Clicking history again must reveal the already-open tab.
    fixture.setPanelVisible(false);
    fixture.setPanelVisible.mockClear();
    await click("Decision history");
    expect(fixture.setPanelVisible).toHaveBeenCalledWith(true);
  });
});

describe("Coordinator Needs You views (PAP-749 task 1b)", () => {
  const mine = (id: string, reason: string) => ({ ...fixture.pending[0], id, subject: { id, kind: "interaction", title: `Mine ${id}`, metadata: { issueId: `task-${id}` } },
    audience: { kind: "user", userId: "reviewer", reason } }) as unknown as AttentionItem;
  const pool = { id: "pool", sourceKind: "issue_thread_interaction", inlineResolvable: true, subject: { id: "pool-interaction", kind: "interaction", title: "Pool", metadata: { issueId: "task-pool" } },
    relatedIssue: { id: "task-pool", identifier: "PAP-9", title: "Pool task", href: "/PAP/issues/PAP-9" }, activityAt: new Date().toISOString(),
    audience: { kind: "pool", userId: null, reason: "none" } } as unknown as AttentionItem;
  const company = { id: "alert", sourceKind: "failed_run", inlineResolvable: false, subject: { id: "run-1", kind: "run", title: "Nightly sync failed", href: "/PAP/runs/1" }, relatedIssue: null,
    activityAt: new Date().toISOString(), audience: { kind: "user", userId: "dotta", reason: "escalation_owner" } } as unknown as AttentionItem;
  async function render(client: QueryClient) {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush(); await flush();
  }
  const tab = (view: string) => container.querySelector<HTMLElement>(`[data-attention-view="${view}"]`)!;

  it("defaults to For you with Why me?, the banner and per-person keys, then claims from Unassigned", async () => {
    fixture.byView = { mine: [mine("m1", "addressee"), mine("m2", "reviewer")], unassigned: [pool], company: [company] };
    fixture.viewCounts = { mine: 2, unassigned: 1, company: 1 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(fixture.listCalls).toContainEqual({ all: true, view: "mine" });
    expect(fixture.listCalls.some((call) => (call as { view?: string }).view !== "mine")).toBe(false);
    // Focus (PAP-770): For you is the page (no tab); Unassigned/Company are quiet
    // chips, and the owner banner folds into the Unassigned chip's count.
    expect(tab("mine")).toBeNull();
    expect(tab("unassigned")?.textContent).toBe("Unassigned1");
    expect([...container.querySelectorAll('[data-attention-audience="mine"]')].map((line) => line.textContent))
      .toEqual(["Why me?Sent to you", "Why me?You are the reviewer"]);
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "mine"], exact: false })).toBeTruthy();

    await act(async () => tab("unassigned")!.click()); await flush();
    expect(container.querySelector("[data-location]")?.textContent).toBe("?view=unassigned");
    expect(fixture.listCalls).toContainEqual({ all: true, view: "unassigned" });
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "unassigned"], exact: false })).toBeTruthy();
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
    await vi.waitFor(() => expect(container.querySelector('[data-attention-audience="pool"]')).not.toBeNull());
    await click("Claim");
    expect(fixture.claim).toHaveBeenCalledWith("company", "issue_thread_interaction", "pool-interaction");
    client.clear();
  });

  it("opens Company from the URL and names another person's card with For @name", async () => {
    fixture.url = "/decisions?view=company";
    fixture.byView = { company: [company] };
    fixture.viewCounts = { mine: 0, unassigned: 0, company: 1 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(tab("company").getAttribute("aria-selected")).toBe("true");
    expect(fixture.listCalls).toContainEqual({ all: true, view: "company" });
    await flush();
    expect(container.querySelector("[data-attention-for-user]")?.textContent).toBe("For @Dotta");
    expect(container.querySelector('[data-attention-view-count="mine"]')).toBeNull();
    client.clear();
  });

  it("puts stale cards in a collapsed Stale (N) group at the bottom and withdraws them after a confirmation (PAP-749 task 2c)", async () => {
    const stale = (id: string, reason: string, extra: Record<string, unknown> = {}) => ({ ...mine(id, "addressee"), stale: { reason }, closeModes: ["withdraw", "archive", "snooze"], ...extra }) as unknown as AttentionItem;
    fixture.byView = { mine: [mine("fresh", "addressee"), stale("old", "aged"), stale("done", "issue_closed"),
      stale("run", "aged", { sourceKind: "failed_run", inlineResolvable: false, closeModes: ["archive", "snooze"], subject: { id: "run-9", kind: "run", title: "Old run", href: "/PAP/runs/9" } })] };
    fixture.viewCounts = { mine: 4, unassigned: 0, company: 0 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const group = container.querySelector<HTMLElement>("[data-attention-stale-group]")!;
    expect(group.textContent).toContain("Stale (3)");
    // Collapsed: only the current card is mounted, and the group sits after it.
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container.querySelector("article")!.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => group.querySelector<HTMLElement>("[aria-expanded]")!.click()); await flush();
    expect(container.querySelectorAll("article")).toHaveLength(4);
    expect(group.querySelector('[data-attention-stale="aged"]')?.textContent).toBe("Stale · Waiting 30+ days");
    expect(group.querySelector('[data-attention-stale="issue_closed"]')?.textContent).toBe("Stale · Task closed");

    await click("Withdraw all stale");
    const dialog = document.querySelector<HTMLElement>("[data-attention-stale-withdraw-dialog]")!;
    expect(dialog.textContent).toContain("Withdraw 2 stale requests?");
    expect(fixture.close).not.toHaveBeenCalled();
    await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Withdraw 2 requests")!.click());
    await flush(); await flush();
    expect(fixture.close.mock.calls.map((call) => [call[2], (call[3] as { mode: string }).mode])).toEqual([["old", "withdraw"], ["done", "withdraw"]]);
    // Withdrawn cards leave at once; the failed run has nothing to withdraw and stays.
    expect(group.textContent).toContain("Stale (1)");
    client.clear();
  });

  it("archives a card for me from its Close… menu with the version I saw", async () => {
    fixture.byView = { mine: [{ ...mine("m1", "addressee"), closeModes: ["withdraw", "archive", "snooze"], changeFingerprint: "fp-1.me" } as unknown as AttentionItem, mine("m2", "addressee")] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const menu = container.querySelector<HTMLElement>("[data-attention-close-menu]")!;
    await act(async () => {
      menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLElement>('[data-attention-close-mode="archive"]')!.click()); await flush(); await flush();
    expect(fixture.close).toHaveBeenCalledWith("company", "issue_thread_interaction", "m1", { mode: "archive", reason: undefined, until: undefined, fingerprint: "fp-1.me" });
    expect(container.querySelector('[data-attention-card="m1"]')).toBeNull();
    expect(container.querySelector('[data-attention-card="m2"]')).not.toBeNull();
    client.clear();
  });

  it("retries a failed run inline instead of only linking to it (Rule 7)", async () => {
    fixture.url = "/decisions?view=company";
    fixture.byView = { company: [{ id: "failed", sourceKind: "failed_run", inlineResolvable: true, decisionVerbs: [{ id: "retry", label: "Retry" }, { id: "inspect", label: "Open run" }],
      subject: { id: "run-7", kind: "run", title: "Nightly sync failed", href: "/PAP/agents/a/runs/run-7", metadata: { issueId: "task-7" } },
      relatedIssue: { id: "task-7", identifier: "PAP-7", title: "Nightly sync", href: "/PAP/issues/PAP-7" }, closeModes: ["archive", "snooze"],
      activityAt: new Date().toISOString(), audience: { kind: "company", userId: null, reason: "none" } } as unknown as AttentionItem] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(container.textContent).not.toContain("Open to review");
    await click("Retry");
    expect(fixture.retryTask).toHaveBeenCalledWith("task-7", { idempotencyKey: expect.any(String), observedRunId: "run-7" });
    client.clear();
  });

  it("shows one card for each obligation, with the rest folded in as evidence (PAP-749 task 2d)", async () => {
    const now = new Date().toISOString();
    const forMe = { kind: "user", userId: "reviewer", reason: "instigator" };
    const run = { id: "failed", sourceKind: "failed_run", inlineResolvable: true, decisionVerbs: [{ id: "retry", label: "Retry" }, { id: "inspect", label: "Open run" }],
      subject: { id: "run-7", kind: "run", title: "Flaky Runner run failed", href: "/PAP/agents/a/runs/run-7", metadata: { issueId: "task-7" } },
      relatedIssue: { id: "task-7", identifier: "PAP-7", title: "Nightly sync", href: "/PAP/issues/PAP-7" }, closeModes: ["archive", "snooze"],
      obligationKey: "blocked:task-7", obligationLeadId: "failed", activityAt: now, audience: forMe } as unknown as AttentionItem;
    const blocked = { id: "blocked", sourceKind: "blocker_attention", inlineResolvable: false, whyNow: "Automatic retries exhausted. Retry or reassign the task.",
      subject: { id: "task-7", kind: "issue", identifier: "PAP-7", title: "Nightly sync", href: "/PAP/issues/PAP-7" }, relatedIssue: null, closeModes: ["archive", "snooze"],
      obligationKey: "blocked:task-7", obligationLeadId: "failed", activityAt: now, audience: forMe } as unknown as AttentionItem;
    const approval = { id: "approval", sourceKind: "approval", inlineResolvable: false, whyNow: "Approval is pending a board decision.",
      subject: { id: "appr-1", kind: "approval", title: "Approve the launch", href: "/PAP/approvals/appr-1", metadata: { issueId: "task-8" } }, relatedIssue: null,
      closeModes: ["withdraw", "archive", "snooze"], obligationKey: "approval:appr-1", obligationLeadId: "approval", activityAt: now, audience: forMe } as unknown as AttentionItem;
    const review = { id: "review", sourceKind: "review", inlineResolvable: false, whyNow: "Issue is in review with a linked pending approval.",
      subject: { id: "task-8", kind: "issue", identifier: "PAP-8", title: "Launch page", href: "/PAP/issues/PAP-8" }, relatedIssue: null, closeModes: ["archive", "snooze"],
      obligationKey: "approval:appr-1", obligationLeadId: "approval", activityAt: now, audience: forMe } as unknown as AttentionItem;
    fixture.byView = { mine: [run, blocked, approval, review] };
    fixture.viewCounts = { mine: 2, unassigned: 0, company: 0 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    // Two obligations, two cards; the evidence cards are never cards of their own.
    expect([...container.querySelectorAll("[data-attention-card]")].map((card) => card.getAttribute("data-attention-card"))).toEqual(["failed", "approval"]);
    const runCard = container.querySelector<HTMLElement>('[data-attention-card="failed"]')!;
    expect(runCard.querySelector('[data-attention-evidence="blocked"]')?.textContent)
      .toBe("Blocked by this run: PAP-7 Nightly sync — Automatic retries exhausted. Retry or reassign the task.");
    const approvalCard = container.querySelector<HTMLElement>('[data-attention-card="approval"]')!;
    expect(approvalCard.querySelector('[data-attention-evidence="review"]')?.textContent)
      .toBe("Task waiting on this approval: PAP-8 Launch page — Issue is in review with a linked pending approval.");
    expect(approvalCard.querySelector('[data-attention-evidence="review"] a')?.getAttribute("href")).toBe("/PAP/issues/PAP-8");
    // The run keeps the one action for the blocked work.
    await click("Retry");
    expect(fixture.retryTask).toHaveBeenCalledWith("task-7", { idempotencyKey: expect.any(String), observedRunId: "run-7" });
    client.clear();
  });

  const boardMember = (membershipRole: string) => ({ userId: "reviewer", source: "session", isInstanceAdmin: false, companyIds: ["company"],
    memberships: [{ companyId: "company", membershipRole, status: "active" }] });

  it("opens Everyone for a board member, names another person's card and asks before withdrawing it (PAP-768)", async () => {
    fixture.boardAccess = boardMember("admin");
    fixture.url = "/decisions?view=all";
    const dottas = { ...mine("d1", "instigator"), audience: { kind: "user", userId: "dotta", reason: "instigator" }, closeModes: ["withdraw", "archive", "snooze"],
      subject: { id: "d1", kind: "interaction", title: "Dotta's confirmation", metadata: { issueId: "task-d1" } } } as unknown as AttentionItem;
    fixture.byView = { all: [mine("m1", "addressee"), dottas] };
    fixture.viewCounts = { mine: 1, unassigned: 0, company: 0, archived: 0, all: 2 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    // Focus (PAP-770): Everyone opens from the View menu; a quiet label names the
    // current view and a For you control returns to the page.
    await vi.waitFor(() => expect(container.textContent).toContain("Showing Everyone"));
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "For you")).toBe(true);
    expect(fixture.listCalls).toContainEqual({ all: true, view: "all" });
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "all"], exact: false })).toBeTruthy();
    const card = container.querySelector<HTMLElement>('[data-attention-card="d1"]')!;
    expect(card.querySelector("[data-attention-for-user]")?.textContent).toBe("For @Dotta");
    expect(container.querySelector('[data-attention-card="m1"] [data-attention-for-user]')).toBeNull();

    const menu = card.querySelector<HTMLElement>("[data-attention-close-menu]")!;
    await act(async () => {
      menu.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      menu.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => document.querySelector<HTMLElement>('[data-attention-close-mode="withdraw"]')!.click()); await flush();
    const dialog = document.querySelector<HTMLElement>("[data-attention-withdraw-dialog]")!;
    expect(dialog.textContent).toContain("This is for @Dotta. Withdraw anyway?");
    expect(fixture.close).not.toHaveBeenCalled();
    await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Withdraw request")!.click());
    await flush(); await flush();
    expect(fixture.close).toHaveBeenCalledWith("company", "issue_thread_interaction", "d1", expect.objectContaining({ mode: "withdraw" }));
    expect(container.querySelector('[data-attention-card="d1"]')).toBeNull();
    client.clear();
  });

  it("keeps Everyone from a viewer: no tab, and ?view=all opens For you (PAP-768)", async () => {
    fixture.boardAccess = boardMember("viewer");
    fixture.url = "/decisions?view=all";
    fixture.byView = { mine: [mine("m1", "addressee")], all: [mine("m1", "addressee"), mine("m2", "addressee")] };
    fixture.viewCounts = { mine: 1, unassigned: 0, company: 0, archived: 0, all: 2 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client); await flush();
    // Focus (PAP-770): a viewer has no Everyone — ?view=all falls back to For you
    // (the page), so there is no "Showing" label and no For you return control.
    expect(container.textContent).not.toContain("Showing");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "For you")).toBe(false);
    expect(container.querySelector('[data-attention-view="all"]')).toBeNull();
    expect(fixture.listCalls.some((call) => (call as { view?: string }).view === "all")).toBe(false);
    client.clear();
  });

  it("shows a budget hard stop and its override approval as one card with Raise limit and Keep paused (PAP-768)", async () => {
    const now = new Date().toISOString();
    const owner = { kind: "user", userId: "reviewer", reason: "budget_owner", alsoInCompany: true };
    const stop = { id: "stop", sourceKind: "budget_alert", inlineResolvable: true, whyNow: "Budget hard stop was reached.",
      decisionVerbs: [{ id: "raise_budget_and_resume", label: "Raise limit" }, { id: "keep_paused", label: "Keep paused" }],
      subject: { id: "incident-1", kind: "budget_incident", title: "Spendy Agent budget hard stop", href: "/PAP/costs", metadata: { thresholdType: "hard", amountObserved: 10_000, amountLimit: 10_000, approvalId: "appr-b" } },
      detail: { kind: "budget", observedPercent: 100, amountObserved: 10_000, amountLimit: 10_000, images: [] },
      relatedIssue: null, closeModes: ["archive", "snooze"], obligationKey: "approval:appr-b", obligationLeadId: "stop", activityAt: now, audience: owner } as unknown as AttentionItem;
    const approval = { id: "approval-b", sourceKind: "approval", inlineResolvable: true, whyNow: "Approval is pending a board decision.",
      decisionVerbs: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      subject: { id: "appr-b", kind: "approval", title: "budget override required", href: "/PAP/approvals/appr-b", metadata: { type: "budget_override_required" } }, relatedIssue: null,
      closeModes: ["withdraw", "archive", "snooze"], obligationKey: "approval:appr-b", obligationLeadId: "stop", activityAt: now, audience: owner } as unknown as AttentionItem;
    fixture.byView = { mine: [stop, approval] };
    fixture.viewCounts = { mine: 1, unassigned: 0, company: 1, archived: 0, all: 1 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect([...container.querySelectorAll("[data-attention-card]")].map((card) => card.getAttribute("data-attention-card"))).toEqual(["stop"]);
    const card = container.querySelector<HTMLElement>('[data-attention-card="stop"]')!;
    expect(card.querySelector('[data-attention-evidence="approval-b"]')?.textContent).toBe("Approval this answers: budget override required — Approval is pending a board decision.");
    const buttons = [...card.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Raise limit & resume", "Keep paused"]));
    // The approval's own Approve / Reject would skip the budget; they are not offered.
    expect(buttons).not.toContain("Approve");
    expect(buttons).not.toContain("Reject");
    // Keep paused answers the stop, which rejects its approval on the server.
    await click("Keep paused");
    expect(fixture.resolveIncident).toHaveBeenCalledWith("company", "incident-1", { action: "keep_paused" });
    client.clear();
  });

  it("shows a view-specific empty state", async () => {
    fixture.url = "/decisions?view=unassigned";
    fixture.byView = { unassigned: [] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(container.textContent).toContain("No cards need an owner.");
    client.clear();
  });

  it("opens a plan card's plan in the side panel and closes it again (PAP-770)", async () => {
    fixture.pending = [{ ...fixture.pending[0], subject: { ...fixture.pending[0].subject, metadata: { issueId: "task-1", targetDocumentKey: "plan" } } }, fixture.pending[1]];
    const client = await renderPage();
    expect([...container.querySelectorAll("[data-coordinator-review-trigger]")]).toHaveLength(1);
    await click("Review plan");
    expect(fixture.setPanelVisible).toHaveBeenLastCalledWith(true);
    const panel = fixture.openPanel.mock.calls.at(-1)?.[0] as { props: Record<string, unknown> };
    expect(panel.props).toMatchObject({ issueId: "task-1", documentKey: "plan" });
    expect(container.querySelector("[data-reviewing]")).toBeTruthy();
    await click("Reviewing plan");
    expect(fixture.closePanel).toHaveBeenCalled();
    expect(container.querySelector("[data-reviewing]")).toBeNull();
    client.clear();
  });
});
