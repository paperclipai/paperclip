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
vi.mock("@/components/AttentionRecoveryResolver", () => ({ AttentionRecoveryResolver: ({ item }: { item: AttentionItem }) => <div data-recovery-resolver={item.subject.id}>Recovery choices</div> }));
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
describe("Coordinator Needs You — recovery cards", () => {
  const recovery = (id: string, hasResolutionActions: boolean) => ({
    id, sourceKind: "recovery_action", inlineResolvable: false, dismissalKey: `attention:${id}`, changeFingerprint: `${id}.v1`,
    closeModes: ["archive"], obligationKey: null, obligationLeadId: null, audience: { kind: "user", userId: "reviewer", reason: "addressee" },
    subject: { id: `${id}-action`, kind: "recovery_action", title: `Recover ${id}`, status: "active", href: `/PAP/issues/PAP-1#${id}`,
      metadata: { hasResolutionActions, kind: "stranded_assigned_issue", sourceIssueId: "task" } },
    relatedIssue: null, activityAt: new Date().toISOString(),
  }) as unknown as AttentionItem;

  it("answers a recovery with supported choices on the card and links the rest to the recovery control", async () => {
    fixture.pending = [recovery("choices", true), recovery("owner", false)];
    const client = await renderPage();
    const supported = container.querySelector<HTMLElement>('[data-attention-card="choices"]')!;
    expect(supported.querySelector('[data-recovery-resolver="choices-action"]')).not.toBeNull();
    expect(supported.textContent).not.toContain("Open recovery");
    const unsupported = container.querySelector<HTMLElement>('[data-attention-card="owner"]')!;
    expect(unsupported.querySelector("[data-recovery-resolver]")).toBeNull();
    expect(unsupported.textContent).toContain("Open recovery");
    client.clear();
  }, 15_000);
});
