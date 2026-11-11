// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, AttentionReceipt } from "@paperclipai/shared";
import { WhatNeedsMe } from "./WhatNeedsMe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// PAP-749 tasks 1b and 2e on the classic Decisions page: the view switch, per
// person and view query keys, the Unassigned banner, Claim, and the Archived
// view with Restore and its Snoozed group.
const fixture = vi.hoisted(() => ({
  userId: "scott",
  byView: {} as Record<string, AttentionItem[]>,
  calls: [] as Array<Record<string, unknown>>,
  claim: vi.fn(async () => ({})),
  close: vi.fn(async (..._args: unknown[]) => ({ until: null })),
  restore: vi.fn(async (..._args: unknown[]) => ({})),
  boardAccess: null as null | Record<string, unknown>,
  receipts: [] as AttentionReceipt[],
}));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false, userId: fixture.userId }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }), useOptionalToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxDismissals: () => ({ dismiss: vi.fn(), snooze: vi.fn(), restore: vi.fn() }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/decisions", () => ({ decisionsApi: { list: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: {
  listUserDirectory: async () => ({ users: [] }),
  getCurrentBoardAccess: async () => { if (!fixture.boardAccess) throw new Error("No board access"); return fixture.boardAccess; },
} }));
vi.mock("../api/inboxDismissals", () => ({ inboxDismissalsApi: { restore: fixture.restore, dismiss: vi.fn() } }));
vi.mock("../components/DecisionHistoryPanel", () => ({ DecisionHistoryPanel: () => <div data-history-panel>History</div> }));
vi.mock("../api/attention", () => ({ attentionApi: {
  claim: fixture.claim,
  close: fixture.close,
  list: async (_companyId: string, options: Record<string, unknown>) => {
    fixture.calls.push(options);
    const items = fixture.byView[String(options.view)] ?? [];
    return { companyId: "company", generatedAt: "2026-10-30T12:00:00Z", totalCount: items.length, deskBadgeCount: 2,
      viewCounts: { mine: 2, unassigned: 1, company: 0, archived: 3, all: 3 }, nextCursor: null, countsBySourceKind: {}, items,
      receipts: options.view === "mine" ? fixture.receipts : [] };
  },
} }));
vi.mock("../components/DecisionsToolbar", () => ({ DecisionsToolbar: () => null }));
vi.mock("../components/DecisionQueueRail", () => ({ DecisionQueueRail: () => null }));
vi.mock("../components/DecisionDateChips", () => ({ DecisionDateChips: () => null }));
vi.mock("../components/DecisionResolver", () => ({ DecisionResolver: () => null }));
vi.mock("../components/AttentionQueueRow", () => ({
  AttentionQueueRow: ({ item, onClaim, onDismiss, onRestore, onSnooze, currentUserId }: { item: AttentionItem; onClaim?: (item: AttentionItem) => void; onDismiss?: (item: AttentionItem) => void; onRestore?: (item: AttentionItem) => void; onSnooze?: (item: AttentionItem, until: string) => void; currentUserId?: string | null }) => (
    <div data-row={item.id} data-viewer={currentUserId ?? ""}>
      {item.subject.title}
      {onClaim ? <button type="button" onClick={() => onClaim(item)}>Claim {item.id}</button> : null}
      {onDismiss && !onRestore ? <button type="button" onClick={() => onDismiss(item)}>Archive {item.id}</button> : null}
      {onRestore ? <button type="button" onClick={() => onRestore(item)}>Restore {item.id}</button> : null}
      {onRestore && onSnooze ? <button type="button" onClick={() => onSnooze(item, "2026-11-02T09:00:00.000Z")}>Change time {item.id}</button> : null}
    </div>
  ),
}));

function card(id: string, audience: AttentionItem["audience"]) {
  const at = new Date().toISOString();
  return { id, sourceKind: "issue_thread_interaction", subject: { id: `${id}-interaction`, kind: "interaction", title: `Card ${id}`, metadata: {} },
    audience, dismissal: null, dismissalKey: `attention:${id}`, changeFingerprint: `${id}.me`, closeModes: ["archive", "snooze"], obligationKey: null, obligationLeadId: null, activityAt: at, createdAt: at, updatedAt: at, inlineResolvable: false, decisionVerbs: [], queues: [], shelf: false,
    severity: "medium", relatedIssue: null, project: null } as unknown as AttentionItem;
}

function Location() { return <output data-location>{useLocation().search}</output>; }

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  fixture.userId = "scott";
  fixture.calls = [];
  fixture.boardAccess = null;
  fixture.receipts = [];
  fixture.claim.mockClear();
  fixture.close.mockClear();
  fixture.restore.mockClear();
  fixture.byView = {
    mine: [card("mine-1", { kind: "user", userId: "scott", reason: "addressee" })],
    unassigned: [card("pool-1", { kind: "pool", userId: null, reason: "none" })],
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function render(url = "/decisions") {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><WhatNeedsMe /><Location /></MemoryRouter></QueryClientProvider>));
  await flush(); await flush();
}

describe("classic Decisions views", () => {
  it("finds a linked decision outside Mine before consuming its URL", async () => {
    fixture.boardAccess = { userId: "scott", source: "session", memberships: [{ companyId: "company", status: "active", membershipRole: "admin" }] };
    fixture.byView.all = [{ ...card("decision-target", { kind: "pool", userId: null, reason: "none" }), sourceKind: "decision", subject: { id: "target", kind: "decision", title: "Linked decision" } } as AttentionItem];
    await render("/decisions?decisionId=target");
    for (let tick = 0; tick < 5; tick++) await flush();
    expect(fixture.calls).toContainEqual(expect.objectContaining({ view: "all" }));
    expect(container.querySelector("[data-location]")?.textContent).not.toContain("decisionId");
  });

  it("shows personal receipts even when there are no pending cards", async () => {
    fixture.byView = { mine: [] };
    fixture.receipts = [{
      id: "receipt-1", dismissalKey: "attention:receipt:receipt-1", outcome: "withdrawn",
      sourceKind: "issue_thread_interaction", sourceId: "interaction-1", title: "Review the plan",
      reason: "Plan changed", actorUserId: "dotta", transferredToUserId: null,
      issue: null, href: null, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }];
    await render();
    expect(container.querySelector('[data-attention-receipt="withdrawn"]')?.textContent).toContain("Plan changed");
    await act(async () => {
      const company = container.querySelector<HTMLButtonElement>('[data-attention-view="company"]')!;
      company.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      company.focus();
    });
    await flush();
    expect(container.querySelector("[data-attention-receipts]")).toBeNull();
  });

  it("opens For you by default with the shared badge count and the Unassigned banner", async () => {
    await render();
    expect(fixture.calls).toContainEqual(expect.objectContaining({ all: true, view: "mine" }));
    // The views never ask for hidden cards; those live in the Archived view (PAP-749 plan §3).
    expect(fixture.calls.some((call) => "includeDismissed" in call)).toBe(false);
    expect(fixture.calls.every((call) => call.view === "mine")).toBe(true);
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["For you2", "Unassigned1", "Company0", "Archived3"]);
    expect(container.querySelector('[data-row="mine-1"]')?.getAttribute("data-viewer")).toBe("scott");
    expect(container.querySelector("[data-attention-unassigned-banner]")?.textContent).toContain("1 card needs an owner");
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "scott", "mine", "classic"], exact: false })).toBeTruthy();
  });

  it("opens Everyone for a board member with its own count (PAP-768)", async () => {
    fixture.boardAccess = { userId: "scott", source: "session", isInstanceAdmin: false, companyIds: ["company"],
      memberships: [{ companyId: "company", membershipRole: "owner", status: "active" }] };
    fixture.byView.all = [card("mine-1", { kind: "user", userId: "scott", reason: "addressee" }), card("dotta-1", { kind: "user", userId: "dotta", reason: "instigator" })];
    await render("/decisions?view=all");
    await vi.waitFor(() => expect(container.querySelector('[data-attention-view="all"]')?.getAttribute("aria-selected")).toBe("true"));
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["For you2", "Unassigned1", "Company0", "Archived3", "Everyone3"]);
    expect(fixture.calls).toContainEqual(expect.objectContaining({ all: true, view: "all" }));
    expect([...container.querySelectorAll("[data-row]")].map((row) => row.getAttribute("data-row"))).toEqual(["mine-1", "dotta-1"]);
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
  });

  it("hides Everyone when the board access is unknown (PAP-768)", async () => {
    await render("/decisions?view=all");
    expect(container.querySelector('[data-attention-view="all"]')).toBeNull();
    expect(container.querySelector('[data-attention-view="mine"]')?.getAttribute("aria-selected")).toBe("true");
    expect(fixture.calls.some((call) => call.view === "all")).toBe(false);
  });

  it("switches to Unassigned from the banner and claims a card", async () => {
    await render();
    const open = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Open Unassigned"))!;
    await act(async () => open.click());
    await flush(); await flush();
    expect(container.querySelector("[data-location]")?.textContent).toBe("?view=unassigned");
    expect(fixture.calls).toContainEqual(expect.objectContaining({ view: "unassigned" }));
    expect(container.querySelector("[data-attention-unassigned-banner]")).toBeNull();
    const claim = [...container.querySelectorAll("button")].find((button) => button.textContent === "Claim pool-1")!;
    await act(async () => claim.click());
    await flush();
    expect(fixture.claim).toHaveBeenCalledWith("company", "issue_thread_interaction", "pool-1-interaction");
  });

  it("keeps each person's list under their own key", async () => {
    await render();
    fixture.userId = "dotta";
    await render();
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "dotta", "mine", "classic"], exact: false })).toBeTruthy();
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "scott", "mine", "classic"], exact: false })).toBeTruthy();
  });

  it("moves stale cards to a collapsed Stale group and withdraws them after a confirmation (PAP-749 task 2c)", async () => {
    const stale = (id: string) => ({ ...card(id, { kind: "user", userId: "scott", reason: "addressee" }), stale: { reason: "aged" }, closeModes: ["withdraw", "archive", "snooze"] }) as unknown as AttentionItem;
    fixture.byView = { mine: [card("fresh", { kind: "user", userId: "scott", reason: "addressee" }), stale("old-1"), stale("old-2")] };
    await render();
    const group = container.querySelector<HTMLElement>("[data-attention-stale-group]")!;
    expect(group.textContent).toContain("Stale (2)");
    expect(container.querySelector('[data-row="fresh"]')).not.toBeNull();
    expect(container.querySelector('[data-row="old-1"]')).toBeNull();
    await act(async () => group.querySelector<HTMLElement>("[aria-expanded]")!.click());
    expect(group.querySelector('[data-row="old-1"]')).not.toBeNull();
    const withdrawAll = [...group.querySelectorAll("button")].find((button) => button.textContent?.includes("Withdraw all stale"))!;
    await act(async () => withdrawAll.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("[data-attention-stale-withdraw-dialog] button")].find((button) => button.textContent === "Withdraw 2 requests")!;
    await act(async () => confirm.click());
    await flush();
    expect(fixture.close.mock.calls.map((call) => [call[2], (call[3] as { mode: string }).mode])).toEqual([["old-1-interaction", "withdraw"], ["old-2-interaction", "withdraw"]]);
  });

  it("archives for me through the one close API (PAP-749 task 2c)", async () => {
    fixture.byView = { mine: [{ ...card("mine-1", { kind: "user", userId: "scott", reason: "addressee" }), changeFingerprint: "fp.me", closeModes: ["archive", "snooze"] } as unknown as AttentionItem] };
    await render();
    const archive = [...container.querySelectorAll("button")].find((button) => button.textContent === "Archive mine-1")!;
    await act(async () => archive.click());
    await flush();
    expect(fixture.close).toHaveBeenCalledWith("company", "issue_thread_interaction", "mine-1-interaction", { mode: "archive", reason: undefined, until: undefined, fingerprint: "fp.me" });
    expect(container.querySelector('[data-row="mine-1"]')).toBeNull();
  });

  it("lists your archived cards, then a Snoozed group, with Restore and Change time (PAP-749 task 2e)", async () => {
    const hidden = (id: string, kind: "dismiss" | "snooze", snoozedUntil: string | null = null) => ({
      ...card(id, { kind: "user", userId: "scott", reason: "addressee" }),
      dismissal: { kind, dismissedAt: "2026-10-29T12:00:00Z", snoozedUntil, isActive: true },
    }) as unknown as AttentionItem;
    fixture.byView = { archived: [hidden("arch-1", "dismiss"), hidden("snz-1", "snooze", "2026-10-31T09:00:00Z")] };
    await render("/decisions?view=archived");
    expect(fixture.calls).toContainEqual(expect.objectContaining({ view: "archived", all: true }));
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Archived3");
    // The badge stays the For you count; the Archived count is only on its tab.
    expect(container.querySelector('[data-attention-view-count="mine"]')?.textContent).toBe("2");
    const snoozedGroup = container.querySelector<HTMLElement>("[data-attention-snoozed-group]")!;
    expect(snoozedGroup.textContent).toContain("Snoozed (1)");
    expect(snoozedGroup.querySelector('[data-row="snz-1"]')).not.toBeNull();
    expect(snoozedGroup.querySelector('[data-row="arch-1"]')).toBeNull();
    expect(container.querySelector('[data-row="arch-1"]')).not.toBeNull();
    // No Archive verb here: the card is already archived.
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Archive arch-1")).toBe(false);

    const changeTime = [...container.querySelectorAll("button")].find((button) => button.textContent === "Change time snz-1")!;
    await act(async () => changeTime.click());
    await flush();
    expect(fixture.close).toHaveBeenCalledWith("company", "issue_thread_interaction", "snz-1-interaction", expect.objectContaining({ mode: "snooze", until: "2026-11-02T09:00:00.000Z" }));
    // A new time keeps the card in the Archived view.
    expect(container.querySelector('[data-row="snz-1"]')).not.toBeNull();

    const restore = [...container.querySelectorAll("button")].find((button) => button.textContent === "Restore arch-1")!;
    await act(async () => restore.click());
    await flush();
    expect(fixture.restore).toHaveBeenCalledWith("company", "attention:arch-1");
    expect(container.querySelector('[data-row="arch-1"]')).toBeNull();
  });

  it("shows the Archived empty state and opens Decision history from the header", async () => {
    await render("/decisions?view=archived");
    expect(container.textContent).toContain("Nothing archived.");
    expect(document.querySelector("[data-history-panel]")).toBeNull();
    const history = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Decision history"))!;
    await act(async () => history.click());
    await flush();
    expect(document.querySelector("[data-classic-decision-history] [data-history-panel]")).not.toBeNull();
  });

  it("shows a Company empty state from the URL", async () => {
    await render("/decisions?view=company");
    expect(fixture.calls).toContainEqual(expect.objectContaining({ view: "company" }));
    expect(container.textContent).toContain("No company alerts right now.");
  });
});
