// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionItem, AttentionReceipt, DecisionHistoryItem } from "@paperclipai/shared";
import { CoordinatorNeedsYou } from "./CoordinatorNeedsYou";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ pending: [] as AttentionItem[], byView: {} as Record<string, AttentionItem[]>, viewCounts: undefined as undefined | Record<string, number>, receipts: [] as AttentionReceipt[], listCalls: [] as unknown[], claim: vi.fn(async () => ({})), close: vi.fn(async (..._args: unknown[]) => ({ until: null })), retryTask: vi.fn(async (..._args: unknown[]) => ({ accepted: true, requestId: "r", stale: false, presentation: null })), history: [] as DecisionHistoryItem[], url: "/decisions", mobile: false, partial: false, historyFail: false, feedFail: false, openPanel: vi.fn(), closePanel: vi.fn(), setPanelVisible: vi.fn(), navigate: vi.fn(), breadcrumbs: vi.fn(), boardAccess: null as null | Record<string, unknown>, historyByScope: {} as Record<string, DecisionHistoryItem[]>, historyCalls: [] as Array<Record<string, unknown>>, resolveIncident: vi.fn(async (..._args: unknown[]) => ({})) }));
const dismissals = vi.hoisted(() => ({ restore: vi.fn(async (..._args: unknown[]) => ({})), dismiss: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("@/api/inboxDismissals", () => ({ inboxDismissalsApi: { restore: dismissals.restore, dismiss: dismissals.dismiss } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: fixture.breadcrumbs }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({ openPanel: fixture.openPanel, closePanel: fixture.closePanel, setPanelVisible: fixture.setPanelVisible, panelVisible: true }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: fixture.mobile }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "reviewer" }) }));
vi.mock("@/lib/router", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/router")>(), useNavigate: () => fixture.navigate }));
const agentFixture = vi.hoisted(() => ({ rows: [] as Agent[] }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: async () => agentFixture.rows } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: {
  listUserDirectory: async () => ({ users: [{ principalId: "dotta", status: "active", user: { name: "Dotta" } }] }),
  getCurrentBoardAccess: async () => { if (!fixture.boardAccess) throw new Error("No board access"); return fixture.boardAccess; },
} }));
vi.mock("@/api/issues", () => ({ issuesApi: { retryTask: fixture.retryTask } }));
vi.mock("@/api/budgets", () => ({ budgetsApi: { resolveIncident: fixture.resolveIncident } }));
const approvals = vi.hoisted(() => ({ get: vi.fn(async (..._args: unknown[]) => ({ payload: {} })), approve: vi.fn(async (..._args: unknown[]) => ({})), reject: vi.fn(async () => ({})), requestRevision: vi.fn(async () => ({})) }));
vi.mock("@/api/approvals", () => ({ approvalsApi: approvals }));
vi.mock("@/api/attention", () => ({ attentionApi: {
  claim: fixture.claim,
  close: fixture.close,
  list: async (_companyId: string, options: { view?: string }) => {
    fixture.listCalls.push(options);
    if (fixture.feedFail) throw new Error("Feed unavailable");
    return { items: [...(fixture.byView[options.view ?? ""] ?? fixture.pending)], viewCounts: fixture.viewCounts, receipts: options.view === "mine" ? [...fixture.receipts] : [] };
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
vi.mock("@/components/AttentionInteractionResolver", () => ({ AttentionInteractionResolver: ({ issueId, interactionId, footerSlot, artifactRow, onResolved }: { issueId: string; interactionId: string; footerSlot?: ReactNode; artifactRow?: ReactNode; onResolved: (interaction: { status: string }) => void }) => <>{artifactRow}{footerSlot}<button data-issue-id={issueId} onClick={() => {
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
  agentFixture.rows = [{ id: "agent-cos", name: "Chief of Staff" }] as Agent[];
  fixture.history = []; fixture.url = "/decisions"; vi.clearAllMocks();
  fixture.byView = {}; fixture.viewCounts = undefined; fixture.receipts = []; fixture.listCalls = []; fixture.boardAccess = null; fixture.historyByScope = {}; fixture.historyCalls = [];
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
/** History has one home, the View menu (PAP-775, IA2–IA4). */
async function openHistory() {
  const trigger = container.querySelector<HTMLElement>("[data-attention-view-menu]");
  expect(trigger, "View menu").toBeTruthy();
  await act(async () => {
    trigger!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent === "Decision history");
  expect(item, "Decision history menu item").toBeTruthy();
  await act(async () => item!.click()); await flush();
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
    // its heading names the view, with a back control to Needs You (PAP-775).
    expect(container.querySelector("[data-attention-view-menu]")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Archived");
    expect(container.querySelector('[aria-label="Back to Needs You"]')).not.toBeNull();
    expect(container.querySelector('select[aria-label="Filter decisions by assignee"]')).toBeNull();
    const archivedCard = container.querySelector<HTMLElement>('[data-attention-card="arch"]')!;
    expect(archivedCard.querySelector('[data-attention-hidden="archived"]')?.textContent).toMatch(/^Archived /);
    const group = container.querySelector<HTMLElement>("[data-attention-snoozed-group]")!;
    expect(group.textContent).toContain("Snoozed (1)");
    expect(group.querySelector('[data-attention-card="snz"] [data-attention-hidden="snoozed"]')).not.toBeNull();
    expect(group.querySelector('[data-attention-card="arch"]')).toBeNull();

    dismissals.restore.mockImplementationOnce(async () => { fixture.byView.archived = fixture.byView.archived!.filter(item => item.id !== "arch"); return {}; });
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
    await act(async () => container.querySelector<HTMLElement>('[aria-label="Back to Needs You"]')!.click()); await flush();
    expect(container.querySelector("[data-location]")?.textContent).toBe("");
    expect(container.querySelector("h1")).toBeNull();
    client.clear();
    // The file's first test also pays for the cold module graph.
  }, 15_000);

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
    await openHistory();
    const dialog = container.querySelector<HTMLElement>("[data-coordinator-decision-history]")!;
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

  it("opens Decision history on Handled by me or for me, with Everyone one choice away, and keeps history off the page (PAP-768, PAP-775)", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    const mineEntry = historyEntry("1", "Dotta's launch checklist", "reviewer");
    const othersEntry = historyEntry("2", "Scott: task you created", "scott");
    fixture.historyByScope = { mine: [mineEntry], all: [mineEntry, othersEntry] };
    const client = await renderPage();
    // IA3/IA4: history has one home, the main-pane view; no Recent Decisions list or header button.
    expect(container.querySelector('[aria-label="Recent Decisions"]')).toBeNull();
    expect(container.textContent).not.toContain("Dotta's launch checklist");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("Decision history"))).toBe(false);

    await openHistory();
    const dialog = container.querySelector<HTMLElement>("[data-coordinator-decision-history]")!;
    const scope = dialog.querySelector<HTMLSelectElement>('select[aria-label="Whose decision history"]')!;
    expect(scope.value).toBe("mine");
    expect([...scope.options].map((option) => option.textContent)).toEqual(["Handled by me or for me", "Everyone"]);
    expect(dialog.textContent).not.toContain("Scott: task you created");
    await choose(dialog, "Whose decision history", "all");
    expect(dialog.textContent).toContain("Scott: task you created");
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
    await openHistory();
    const dialog = container.querySelector<HTMLElement>("[data-coordinator-decision-history]")!;
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
  it("opens a decision link outside the personal feed before focusing it", async () => {
    fixture.url = "/decisions?decisionId=target";
    fixture.boardAccess = { userId: "reviewer", source: "session", memberships: [{ companyId: "company", status: "active", membershipRole: "admin" }] };
    fixture.byView = { mine: [], all: [{ ...fixture.pending[0], id: "linked-decision", sourceKind: "decision", subject: { id: "target", kind: "decision", title: "Linked decision" } } as AttentionItem] };
    const scroll = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, writable: true, value: scroll });
    const client = await renderPage(fixture.url);
    for (let tick = 0; tick < 5; tick++) await flush();
    expect(fixture.listCalls).toContainEqual(expect.objectContaining({ view: "all" }));
    expect(container.querySelector("#coordinator-decision-target")).not.toBeNull();
    expect(container.querySelector("[data-location]")?.textContent).not.toContain("decisionId");
    expect(scroll).toHaveBeenCalled();
    client.clear();
  });

  it("opens searchable history in the main pane from the View menu, never in the side panel (PAP-770, PAP-775)", async () => {
    fixture.mobile = true;
    fixture.pending = [];
    fixture.history = [{ id: "old-decision", sourceKind: "issue_thread_interaction", sourceId: "old", issueId: "task-1", issueIdentifier: "PAP-1", issueTitle: "Earlier launch", title: "Review", label: "Approved", outcome: "accepted", resolvedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), resolvedByUserId: "reviewer", resolvedByAgentId: null, agentId: null, agentName: null, projectId: null, projectName: null, href: "/PAP/issues/PAP-1#interaction-old", target: null }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    for (let round = 0; round < 2; round += 1) {
      await openHistory();
      const history = container.querySelector("[data-coordinator-decision-history]");
      expect(history).not.toBeNull();
      expect(history!.querySelector('[aria-label="Search decision history"]')).not.toBeNull();
      expect(history!.textContent).toContain("Earlier launch");
      expect(fixture.openPanel).not.toHaveBeenCalled();
      const back = [...history!.querySelectorAll("button")].find(button => button.textContent === "Needs You");
      await act(async () => back!.click()); await flush();
      expect(container.querySelector("[data-coordinator-decision-history]")).toBeNull();
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
    expect(container.textContent).toContain("Resolve 2");
    client.clear();
  });
  it("keeps search, filters and grouping in one visible toolbar and applies them to cards (UX6, PAP-775)", async () => {
    const client = await renderPage();
    const toolbar = container.querySelector<HTMLElement>('[role="toolbar"][aria-label="Decisions controls"]')!;
    expect(toolbar).not.toBeNull();
    // No filter icon toggle and no sort select: the controls are always there.
    expect(container.querySelector('[aria-label="Filter and search"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Sort decisions"]')).toBeNull();
    const summary = container.querySelector("[data-needs-you-summary]")!;
    expect(summary.textContent).toBe("3 decisions");
    expect(toolbar.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("Someone needs you to choose");
    // Grouped by type by default.
    const group = toolbar.querySelector<HTMLSelectElement>('select[aria-label="Group decisions"]')!;
    expect(group.value).toBe("type");
    expect([...group.options].map((option) => option.textContent)).toEqual(["By type", "By task", "By agent", "By project", "No grouping"]);
    expect(container.querySelector('[data-needs-you-section="decisions"]')).toBeNull();
    await act(async () => { group.value = "none"; group.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector("[data-needs-you-section]")).toBeNull();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    // Search narrows the cards.
    const search = toolbar.querySelector<HTMLInputElement>('input[placeholder="Search…"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Task 2");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect([...container.querySelectorAll("[data-attention-card]")].map((card) => card.getAttribute("data-attention-card"))).toEqual(["2"]);
    client.clear();
  });

  it("resizes and gathers light in place, then the receipt leaves for Decision history", async () => {
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
    // IA3: the record now lives in Decision history only.
    expect(container.querySelector('[aria-label="Recent Decisions"]')).toBeNull();
    expect(container.querySelectorAll(".coordinator-decision-receipt")).toHaveLength(0);
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
    // IA7: a stuck task is a problem card, listed under Problems (PAP-775).
    expect(container.querySelector("article")?.getAttribute("data-card-kind")).toBe("problem");
    expect(container.querySelector("article")?.getAttribute("data-card-type")).toBe("blocked_task");
    expect(container.querySelector("[data-attention-type-label]")?.textContent).toBe("Unblock a task");
    expect(container.querySelector("[data-needs-you-summary]")?.textContent).toBe("1 problem");
    expect(container.querySelector('[data-needs-you-section="decisions"]')).toBeNull();
    expect(container.querySelector("[data-review-policy]")?.getAttribute("data-review-policy")).toBe("human_only");
    await click("Mark task done");
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("You're caught up.");
  });
  it("turns all three answers into receipts, then keeps them in Decision history, opened only on demand", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[fixture.url]}><CoordinatorNeedsYou /><Location /></MemoryRouter></QueryClientProvider>));
    await flush();
    expect(fixture.openPanel).not.toHaveBeenCalled();
    expect(container.querySelectorAll("article")).toHaveLength(3);
    await click("Resolve 1"); await click("Resolve 2"); await click("Resolve 3");
    await flush();
    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).not.toContain("Recent Decisions");
    // Decision history opens in the main pane, not the side panel (PAP-770).
    await openHistory();
    const history = container.querySelector<HTMLElement>("[data-coordinator-decision-history]");
    expect(history).not.toBeNull();
    expect(history!.textContent).toContain("Answers recorded");
    expect(fixture.openPanel).not.toHaveBeenCalled();
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

  it("defaults to Assigned to you with Why me?, no banner and per-person keys, then claims from No owner yet", async () => {
    fixture.byView = { mine: [mine("m1", "addressee"), mine("m2", "reviewer")], unassigned: [pool], company: [company] };
    fixture.viewCounts = { mine: 2, unassigned: 1, company: 1 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(fixture.listCalls).toContainEqual({ all: true, view: "mine" });
    expect(fixture.listCalls.some((call) => (call as { view?: string }).view !== "mine")).toBe(false);
    // PAP-775: For you is the page (no tab, no chips); the toolbar's assignee
    // filter says "Assigned to you" and widens to the other views.
    expect(tab("mine")).toBeNull();
    expect(tab("unassigned")).toBeNull();
    const assignee = () => container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    expect(assignee().value).toBe("me");
    expect(assignee().selectedOptions[0]?.textContent).toBe("Assigned to you");
    // Why me? is the type label's tooltip, not text on the card; your own card doesn't name you.
    expect([...container.querySelectorAll<HTMLElement>("[data-attention-type-label]")].map((label) => [label.textContent, label.title]))
      .toEqual([["Confirm or decline", "Why me? Sent to you"], ["Confirm or decline", "Why me? You are the reviewer"]]);
    expect(container.textContent).not.toContain("Why me?");
    expect(container.querySelector("[data-attention-for-user]")).toBeNull();
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "mine"], exact: false })).toBeTruthy();

    await act(async () => { assignee().value = "unassigned"; assignee().dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
    expect(container.querySelector("[data-location]")?.textContent).toBe("?view=unassigned");
    expect(assignee().value).toBe("unassigned");
    expect(fixture.listCalls).toContainEqual({ all: true, view: "unassigned" });
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "unassigned"], exact: false })).toBeTruthy();
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
    await vi.waitFor(() => expect(container.querySelector('[data-attention-audience="pool"]')).not.toBeNull());
    await click("Claim");
    expect(fixture.claim).toHaveBeenCalledWith("company", "issue_thread_interaction", "pool-interaction");
    client.clear();
  });

  it("opens Company alerts from the URL and names another person's card with @name before its type", async () => {
    fixture.url = "/decisions?view=company";
    fixture.byView = { company: [company] };
    fixture.viewCounts = { mine: 0, unassigned: 0, company: 1 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const assignee = container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    expect(assignee.value).toBe("company");
    expect(assignee.selectedOptions[0]?.textContent).toBe("Company alerts");
    expect(fixture.listCalls).toContainEqual({ all: true, view: "company" });
    await flush();
    // A1 (PAP-775): the type label starts with the person the card is for.
    const label = container.querySelector<HTMLElement>("[data-attention-type-label]")!;
    expect(label.textContent).toBe("@Dotta Fix a failed run");
    expect(label.querySelector("[data-attention-for-user]")?.getAttribute("data-attention-for-user")).toBe("dotta");
    expect(container.querySelector("article")?.textContent).not.toContain("Company alert");
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

  it("indexes company agents once when many task cards need assignee names", async () => {
    let reads = 0;
    agentFixture.rows = Array.from({ length: 1000 }, (_, index) => ({
      get id() { if (++reads > 15_000) throw new Error("Repeated company roster scan"); return `agent-${index}`; },
      name: `Agent ${index}`,
    })) as Agent[];
    fixture.byView = { mine: Array.from({ length: 80 }, (_, index) => ({
      ...mine(`review-${index}`, "assignee"), sourceKind: "review", inlineResolvable: false,
      subject: { id: `task-${index}`, companyId: "company", identifier: `PAP-${index}`, kind: "issue", title: `Review ${index}`, status: "in_review", href: `/PAP/issues/PAP-${index}`,
        metadata: { assigneeAgentId: "agent-999" } }, relatedIssue: null,
    }) as AttentionItem) };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    expect(container.querySelectorAll('[data-attention-card]')).toHaveLength(40);
    expect(container.textContent?.match(/Assigned to Agent 999/g)).toHaveLength(40);
    expect(reads).toBeLessThan(15_000);
    client.clear();
  });

  it("archives a card for me from its Close… menu with the version I saw", async () => {
    fixture.byView = { mine: [{ ...mine("m1", "addressee"), closeModes: ["withdraw", "archive", "snooze"], changeFingerprint: "fp-1.me" } as unknown as AttentionItem, mine("m2", "addressee")] };
    fixture.close.mockImplementationOnce(async () => { fixture.byView.mine = [mine("m2", "addressee")]; return { until: null }; });
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
    // The server can return the same request after a snooze or content change.
    fixture.byView.mine = [{ ...mine("m1", "addressee"), changeFingerprint: "fp-2.me" } as AttentionItem, mine("m2", "addressee")];
    await act(async () => { await client.invalidateQueries({ queryKey: ["attention", "company"] }); });
    await flush();
    expect(container.querySelector('[data-attention-card="m1"]')).not.toBeNull();
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
    // PAP-775: View run, then the primary Retry run last.
    const card = container.querySelector<HTMLElement>('[data-attention-card="failed"]')!;
    expect([...card.querySelectorAll("a, button")].map((entry) => entry.textContent).slice(-2)).toEqual(["View run", "Retry run"]);
    await click("Retry run");
    expect(fixture.retryTask).toHaveBeenCalledWith("task-7", { idempotencyKey: expect.any(String), observedRunId: "run-7" });
    client.clear();
  });

  it("explains when retry does not start new work", async () => {
    fixture.url = "/decisions?view=company";
    fixture.retryTask.mockResolvedValueOnce({ accepted: false, requestId: "stale", stale: true, presentation: null });
    fixture.byView = { company: [{ id: "stale-run", sourceKind: "failed_run", inlineResolvable: true,
      subject: { id: "run-old", kind: "run", title: "Previous attempt", metadata: { issueId: "task-old" } },
      relatedIssue: { id: "task-old", identifier: "PAP-7", href: "/PAP/issues/PAP-7" }, activityAt: new Date().toISOString(),
      audience: { kind: "company", userId: null, reason: "none" } } as unknown as AttentionItem] };
    const client = await renderPage(fixture.url);
    await click("Retry run");
    expect(container.textContent).toContain("Retry did not start new work");
    expect(container.textContent).not.toContain("A retry is already running");
    client.clear();
  });

  it("shows what others did with your requests as Updates cards you can dismiss (PAP-749 plan §6, PAP-775)", async () => {
    fixture.byView = { mine: [mine("m1", "addressee")] };
    fixture.receipts = [{ id: "receipt-1", dismissalKey: "receipt:1", outcome: "approved", sourceKind: "approval", sourceId: "appr-9", title: "Hire a designer",
      reason: null, actorUserId: "dotta", transferredToUserId: null, issue: null, href: "/PAP/approvals/appr-9",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    await vi.waitFor(() => expect(container.querySelector('[data-attention-receipt="approved"]')).not.toBeNull());
    expect(container.querySelector("[data-needs-you-summary]")?.textContent).toBe("1 decision · 1 update");
    expect(container.querySelector('[data-needs-you-section="updates"]')?.textContent).toBe("Updates");
    // No collapsed "N updates on your requests" line any more.
    expect(container.textContent).not.toContain("updates on your requests");
    const update = container.querySelector<HTMLElement>('[data-attention-receipt="approved"]')!;
    expect(update.textContent).toContain("View a request update");
    expect(update.querySelector("h2")?.textContent).toBe("Hire a designer");
    expect(update.querySelector("[data-needs-you-panel]")?.textContent).toBe("Approved by Dotta");
    // Updates are not in the badge and have no ⋯ menu.
    expect(update.querySelector("[data-attention-close-menu]")).toBeNull();
    expect([...update.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Dismiss", "View request"]);
    await act(async () => [...update.querySelectorAll("button")].find((button) => button.textContent === "View request")!.click());
    expect(fixture.navigate).toHaveBeenCalledWith("/PAP/approvals/appr-9");
    await act(async () => [...update.querySelectorAll("button")].find((button) => button.textContent === "Dismiss")!.click()); await flush();
    expect(dismissals.dismiss).toHaveBeenCalledWith("company", "receipt:1");
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
    // By type, the approval's decision comes before the run's problem (PAP-775).
    expect([...container.querySelectorAll("[data-attention-card]")].map((card) => card.getAttribute("data-attention-card"))).toEqual(["approval", "failed"]);
    expect([...container.querySelectorAll("[data-needs-you-section]")].map((section) => section.getAttribute("data-needs-you-section"))).toEqual(["problems"]);
    const runCard = container.querySelector<HTMLElement>('[data-attention-card="failed"]')!;
    expect(runCard.querySelector('[data-attention-evidence="blocked"]')?.textContent)
      .toBe("Blocked by this run: PAP-7 Nightly sync — Automatic retries exhausted. Retry or reassign the task.");
    const approvalCard = container.querySelector<HTMLElement>('[data-attention-card="approval"]')!;
    expect(approvalCard.querySelector('[data-attention-evidence="review"]')?.textContent)
      .toBe("Task waiting on this approval: PAP-8 Launch page — Issue is in review with a linked pending approval.");
    expect(approvalCard.querySelector('[data-attention-evidence="review"] a')?.getAttribute("href")).toBe("/PAP/issues/PAP-8");
    for (const card of [runCard, approvalCard]) {
      const evidence = card.querySelector("[data-attention-evidence]")!;
      const footer = card.querySelector("[data-decision-footer]")!;
      expect(evidence.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
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
    // PAP-775: Everyone is "All assignees" in the toolbar's assignee filter, and
    // "Assigned to you" returns to the page.
    const assignee = () => container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    expect(assignee().selectedOptions[0]?.textContent).toBe("All assignees");
    expect(container.querySelector("[data-needs-you-summary]")?.textContent).toBe("2 decisions");
    expect(fixture.listCalls).toContainEqual({ all: true, view: "all" });
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "reviewer", "all"], exact: false })).toBeTruthy();
    const card = container.querySelector<HTMLElement>('[data-attention-card="d1"]')!;
    expect(card.querySelector("[data-attention-type-label]")?.textContent).toBe("@Dotta Confirm or decline");
    expect(card.querySelector("[data-attention-for-user]")?.textContent).toBe("@Dotta ");
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
    // A viewer has no Everyone — ?view=all falls back to For you (the page), and
    // the assignee filter offers no "All assignees" and no other people (PAP-775).
    const assignee = container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    expect(assignee.value).toBe("me");
    expect([...assignee.options].map((option) => option.textContent)).toEqual(["Assigned to you", "No owner yet", "Company alerts"]);
    expect(container.querySelector('[data-attention-view="all"]')).toBeNull();
    expect(fixture.listCalls.some((call) => (call as { view?: string }).view === "all")).toBe(false);
    client.clear();
  });

  it("shows a budget hard stop and its override approval as one card with Increase limit and Keep paused (PAP-768)", async () => {
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
    expect(card.querySelector("[data-attention-type-label]")?.textContent).toBe("Resolve a budget stop");
    const buttons = () => [...card.querySelectorAll("button")].map((button) => button.textContent);
    // PAP-775: the new limit is asked for only once you choose to increase it; the primary action is last.
    expect(buttons().slice(-2)).toEqual(["Keep paused", "Increase limit…"]);
    expect(card.querySelector('input[inputmode="decimal"]')).toBeNull();
    await click("Increase limit…");
    expect(card.querySelector('input[inputmode="decimal"]')).not.toBeNull();
    expect(buttons().slice(-3)).toEqual(["Keep paused", "Cancel", "Raise limit & resume"]);
    // The approval's own Approve / Reject would skip the budget; they are not offered.
    expect(buttons()).not.toContain("Approve");
    expect(buttons()).not.toContain("Reject");
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

  it("opens a plan card's plan as a side-panel tab and closes the tab again (PAP-770)", async () => {
    fixture.pending = [{ ...fixture.pending[0], subject: { ...fixture.pending[0].subject, metadata: { issueId: "task-1", targetDocumentKey: "plan" } } }, fixture.pending[1]];
    const client = await renderPage();
    // PAP-775 (IA5): the plan opens from a row in the card's panel, not a footer button.
    const row = (verb: "Open" | "Close") => container.querySelector<HTMLElement>(`button[aria-label="${verb} Plan in the sidebar"]`);
    expect(container.querySelectorAll('button[aria-label$="in the sidebar"]')).toHaveLength(1);
    expect(row("Open")?.textContent).toBe("PlanOpen in sidebar");
    await act(async () => row("Open")!.click()); await flush();
    expect(fixture.setPanelVisible).toHaveBeenLastCalledWith(true);
    expect(row("Close")?.textContent).toBe("PlanOpen in sidebar · Showing");
    const panel = fixture.openPanel.mock.calls.at(-1)?.[0] as { props: { tabs: Array<{ id: string; label: string }>; activeTabId: string; reviewable: AttentionItem[] } };
    expect(panel.props.tabs).toEqual([expect.objectContaining({ id: `review:${fixture.pending[0].id}` })]);
    expect(panel.props.activeTabId).toBe(`review:${fixture.pending[0].id}`);
    // The + launcher offers every card with a document to review.
    expect(panel.props.reviewable.map(item => item.id)).toEqual([fixture.pending[0].id]);
    expect(container.querySelector("[data-reviewing]")).toBeTruthy();
    await act(async () => row("Close")!.click()); await flush();
    expect(row("Open")).not.toBeNull();
    const after = fixture.openPanel.mock.calls.at(-1)?.[0] as { props: { tabs: unknown[] } };
    expect(after.props.tabs).toEqual([]);
    expect(container.querySelector("[data-reviewing]")).toBeNull();
    client.clear();
  });
  it("shows who is asking, why it is yours, and the task's status before its ID (UI2, UI3, UI5, A3)", async () => {
    fixture.byView = { mine: [{ ...mine("m1", "addressee"), requester: { kind: "agent", id: "agent-cos", name: "Chief of Staff" },
      relatedIssue: { id: "task-m1", identifier: "PAP-21", title: "Launch", status: "in_progress", href: "/PAP/issues/PAP-21" } } as unknown as AttentionItem,
    { ...mine("m2", "assignee"), requester: { kind: "user", id: "dotta", name: null } } as unknown as AttentionItem] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const agentCard = container.querySelector<HTMLElement>('[data-attention-card="m1"]')!;
    expect(agentCard.querySelector('[data-attention-requester="agent"]')?.textContent).toBe("from Chief of Staff");
    // Your own card says why in the type label's tooltip, never your own name (PAP-775).
    const label = agentCard.querySelector<HTMLElement>("[data-attention-type-label]")!;
    expect(label.textContent).toBe("Confirm or decline");
    expect(label.title).toBe("Why me? Sent to you");
    expect(agentCard.querySelector('[data-attention-audience]')).toBeNull();
    expect(agentCard.querySelector("[data-attention-for-user]")).toBeNull();
    // The footer's task link: status icon, then "ID · title", then ↗.
    const link = agentCard.querySelector<HTMLElement>("[data-attention-task-link]")!;
    expect(link.querySelector('[title="In Progress"], [aria-label="In Progress"]')).not.toBeNull();
    expect(link.textContent).toMatch(/^In Progress.*PAP-21 · Launch$/);
    const personCard = container.querySelector<HTMLElement>('[data-attention-card="m2"]')!;
    expect(personCard.querySelector('[data-attention-requester="user"]')?.textContent).toContain("from Dotta");
    client.clear();
  });

  it("omits the requester avatar and line when the viewer made the request", async () => {
    fixture.byView = { mine: [{ ...mine("own", "addressee"), requester: { kind: "user", id: "reviewer", name: "Dotta" } } as unknown as AttentionItem] };
    const client = await renderPage();
    expect(container.querySelector('[data-attention-requester="user"]')).toBeNull();
    client.clear();
  });

  it("says No owner yet with Claim on an ownerless card (A2)", async () => {
    fixture.url = "/decisions?view=unassigned";
    fixture.byView = { unassigned: [pool] };
    fixture.viewCounts = { mine: 0, unassigned: 1, company: 0 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const corner = container.querySelector<HTMLElement>('[data-attention-audience="pool"]')!;
    expect(corner.textContent).toBe("No owner yetClaim");
    client.clear();
  });

  it("puts problems under a Problems heading apart from decisions, in words and not colour alone (IA7, UI6)", async () => {
    fixture.byView = { mine: [{ ...company, id: "run", inlineResolvable: false, audience: { kind: "user", userId: "reviewer", reason: "assignee" } } as unknown as AttentionItem, mine("decision", "addressee")] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const kinds = Object.fromEntries([...container.querySelectorAll("[data-attention-card]")].map((card) => [card.getAttribute("data-attention-card"), [card.getAttribute("data-card-kind"), card.getAttribute("data-card-type")]]));
    expect(kinds).toEqual({ decision: ["decision", "confirm"], run: ["problem", "failed_run"] });
    // Counts live in one line; the later Problems group keeps its own label.
    const sections = [...container.querySelectorAll<HTMLElement>("[data-needs-you-section]")];
    expect(sections.map((section) => section.textContent)).toEqual(["Problems"]);
    expect(container.querySelector("[data-needs-you-summary]")?.textContent).toBe("1 decision · 1 problem");
    // In document order, each card sits under its section's heading.
    expect([...container.querySelectorAll("[data-needs-you-section], [data-attention-card]")].map((node) => node.getAttribute("data-needs-you-section") ?? node.getAttribute("data-attention-card")))
      .toEqual(["decision", "problems", "run"]);
    // The heading is the signal; the card carries no "Problem" label of its own.
    expect(container.querySelector("[data-attention-problem]")).toBeNull();
    expect(container.querySelector('[data-attention-card="run"] [data-attention-type-label]')?.textContent).toBe("Fix a failed run");
    client.clear();
  });

  it("filters cards by who they are for from the toolbar (PAP-775)", async () => {
    fixture.boardAccess = boardMember("admin");
    fixture.url = "/decisions?view=all";
    const dottas = { ...mine("d1", "instigator"), audience: { kind: "user", userId: "dotta", reason: "instigator" },
      subject: { id: "d1", kind: "interaction", title: "Dotta's confirmation", metadata: { issueId: "task-d1" } } } as unknown as AttentionItem;
    fixture.byView = { all: [mine("m1", "addressee"), dottas, pool] };
    fixture.viewCounts = { mine: 1, unassigned: 1, company: 0, archived: 0, all: 3 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const assignee = () => container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    const choose = async (value: string) => { await act(async () => { assignee().value = value; assignee().dispatchEvent(new Event("change", { bubbles: true })); }); await flush(); };
    const cards = () => [...container.querySelectorAll("[data-attention-card]")].map(card => card.getAttribute("data-attention-card"));
    await vi.waitFor(() => expect(assignee().value).toBe("all"));
    // The viewer is "Assigned to you", never a person option of their own.
    expect([...assignee().options].map(option => [option.value, option.textContent])).toEqual([
      ["me", "Assigned to you"], ["all", "All assignees"], ["user:dotta", "Dotta"], ["unassigned", "No owner yet"], ["company", "Company alerts"]]);
    expect(cards()).toEqual(["m1", "d1", "pool"]);
    // One person narrows Everyone, and the person lives in the URL.
    await choose("user:dotta");
    expect(container.querySelector("[data-location]")?.textContent).toBe("?view=all&for=dotta");
    expect(assignee().value).toBe("user:dotta");
    expect(cards()).toEqual(["d1"]);
    // Back to everyone drops the person.
    await choose("all");
    expect(container.querySelector("[data-location]")?.textContent).toBe("?view=all");
    expect(cards()).toEqual(["m1", "d1", "pool"]);
    // "Assigned to you" is the page itself.
    await choose("me");
    expect(container.querySelector("[data-location]")?.textContent).toBe("");
    client.clear();
  });

  it("defaults the assignee filter to Assigned to you in For you, where every card is yours (PAP-775)", async () => {
    fixture.byView = { mine: [mine("m1", "addressee"), mine("m2", "assignee")] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    await vi.waitFor(() => expect(container.querySelector('[data-attention-card="m2"]')).toBeTruthy());
    const assignee = container.querySelector<HTMLSelectElement>('select[aria-label="Filter decisions by assignee"]')!;
    expect(assignee.value).toBe("me");
    expect(assignee.getAttribute("data-attention-assignee")).toBe("me");
    // The old "For anyone" filter is gone.
    expect(container.querySelector("[data-attention-audience-filter]")).toBeNull();
    expect(container.querySelector("[data-needs-you-summary]")?.textContent).toBe("2 decisions");
    client.clear();
  });

  it("opens a document a card links to as its own side-panel tab, tied to the card (PAP-775, IA5)", async () => {
    const approval = { id: "approval", sourceKind: "approval", inlineResolvable: true, whyNow: "Approval is pending a board decision.",
      subject: { id: "appr-1", kind: "approval", title: "Hire a designer", href: "/PAP/approvals/appr-1", metadata: {} }, relatedIssue: null,
      closeModes: ["withdraw", "archive", "snooze"], obligationKey: null, obligationLeadId: null, activityAt: new Date().toISOString(),
      audience: { kind: "user", userId: "reviewer", reason: "requester" } } as unknown as AttentionItem;
    fixture.byView = { mine: [approval] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const card = container.querySelector<HTMLElement>('[data-attention-card="approval"]')!;
    const link = document.createElement("a");
    link.href = "/PAP/issues/PAP-12#document-design";
    link.textContent = "design notes";
    card.querySelector("h2")!.after(link);
    await act(async () => link.click()); await flush();
    const panel = fixture.openPanel.mock.calls.at(-1)?.[0] as { props: { tabs: Array<{ id: string; type: string; payload: { itemId: string; artifact?: unknown } }>; activeTabId: string } };
    expect(panel.props.tabs).toEqual([expect.objectContaining({ id: "review:approval:document:PAP-12:design", type: "design notes",
      payload: { kind: "review", itemId: "approval", artifact: { kind: "document", issueId: "PAP-12", key: "design", title: "design notes" } } })]);
    expect(panel.props.activeTabId).toBe("review:approval:document:PAP-12:design");
    // The card is highlighted while something it mentions is open (UI9).
    expect(card.getAttribute("data-reviewing")).toBe("true");
    client.clear();
  });

  it("approves an approval on the card and opens it in the side panel (UX1, IA5)", async () => {
    const approval = { id: "approval", sourceKind: "approval", inlineResolvable: true, whyNow: "Approval is pending a board decision.",
      decisionVerbs: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
      subject: { id: "appr-1", kind: "approval", title: "Hire a designer", href: "/PAP/approvals/appr-1", metadata: {} }, relatedIssue: null,
      closeModes: ["withdraw", "archive", "snooze"], obligationKey: null, obligationLeadId: null, activityAt: new Date().toISOString(),
      audience: { kind: "user", userId: "reviewer", reason: "requester" } } as unknown as AttentionItem;
    fixture.byView = { mine: [approval] };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(client);
    const card = container.querySelector<HTMLElement>('[data-attention-card="approval"]')!;
    expect(card.querySelector("h2")?.textContent).toBe("Approve “Hire a designer”?");
    expect(card.textContent).not.toContain("Open to review");
    expect(card.querySelector("[data-attention-type-label]")?.textContent).toBe("Approve a request");
    // PAP-775: View details · Reject · Approve, primary last; the note and Request
    // revision stay in the side panel.
    const footer = [...card.querySelectorAll("button")].map((button) => button.textContent).filter((text) => ["View details", "Reject", "Approve"].includes(text ?? ""));
    expect(footer).toEqual(["View details", "Reject", "Approve"]);
    expect(card.querySelector("textarea")).toBeNull();
    expect(card.textContent).not.toContain("Request revision");
    await act(async () => [...card.querySelectorAll("button")].find((button) => button.textContent === "View details")!.click()); await flush();
    const panel = fixture.openPanel.mock.calls.at(-1)?.[0] as { props: { tabs: Array<{ id: string; type: string }> } };
    expect(panel.props.tabs).toEqual([expect.objectContaining({ id: "review:approval", type: "Approval" })]);
    await act(async () => [...card.querySelectorAll("button")].find((button) => button.textContent === "Approve")!.click()); await flush();
    expect(approvals.approve).toHaveBeenCalledWith("appr-1", undefined);
    client.clear();
  });
});
