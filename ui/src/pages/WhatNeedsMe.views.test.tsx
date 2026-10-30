// @vitest-environment jsdom
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem } from "@paperclipai/shared";
import { WhatNeedsMe } from "./WhatNeedsMe";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// PAP-749 task 1b on the classic Decisions page: the three-view switch, per
// person and view query keys, the Unassigned banner and Claim.
const fixture = vi.hoisted(() => ({
  userId: "scott",
  byView: {} as Record<string, AttentionItem[]>,
  calls: [] as Array<Record<string, unknown>>,
  claim: vi.fn(async () => ({})),
}));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: false, userId: fixture.userId }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }), useOptionalToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useInboxBadge", () => ({ useInboxDismissals: () => ({ dismiss: vi.fn(), snooze: vi.fn(), restore: vi.fn() }) }));
vi.mock("../api/agents", () => ({ agentsApi: { list: async () => [] } }));
vi.mock("../api/decisions", () => ({ decisionsApi: { list: async () => [] } }));
vi.mock("../api/access", () => ({ accessApi: { listUserDirectory: async () => ({ users: [] }) } }));
vi.mock("../api/attention", () => ({ attentionApi: {
  claim: fixture.claim,
  list: async (_companyId: string, options: Record<string, unknown>) => {
    fixture.calls.push(options);
    const items = fixture.byView[String(options.view)] ?? [];
    return { companyId: "company", generatedAt: "2026-10-30T12:00:00Z", totalCount: items.length, deskBadgeCount: 2,
      viewCounts: { mine: 2, unassigned: 1, company: 0 }, nextCursor: null, countsBySourceKind: {}, items };
  },
} }));
vi.mock("../components/DecisionsToolbar", () => ({ DecisionsToolbar: () => null }));
vi.mock("../components/DecisionQueueRail", () => ({ DecisionQueueRail: () => null }));
vi.mock("../components/DecisionDateChips", () => ({ DecisionDateChips: () => null }));
vi.mock("../components/DecisionResolver", () => ({ DecisionResolver: () => null }));
vi.mock("../components/AttentionQueueRow", () => ({
  AttentionQueueRow: ({ item, onClaim, currentUserId }: { item: AttentionItem; onClaim?: (item: AttentionItem) => void; currentUserId?: string | null }) => (
    <div data-row={item.id} data-viewer={currentUserId ?? ""}>
      {item.subject.title}
      {onClaim ? <button type="button" onClick={() => onClaim(item)}>Claim {item.id}</button> : null}
    </div>
  ),
}));

function card(id: string, audience: AttentionItem["audience"]) {
  const at = new Date().toISOString();
  return { id, sourceKind: "issue_thread_interaction", subject: { id: `${id}-interaction`, kind: "interaction", title: `Card ${id}`, metadata: {} },
    audience, dismissal: null, activityAt: at, createdAt: at, updatedAt: at, inlineResolvable: false, decisionVerbs: [], queues: [], shelf: false,
    severity: "medium", relatedIssue: null, project: null } as unknown as AttentionItem;
}

function Location() { return <output data-location>{useLocation().search}</output>; }

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  fixture.userId = "scott";
  fixture.calls = [];
  fixture.claim.mockClear();
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
  it("opens For you by default with the shared badge count and the Unassigned banner", async () => {
    await render();
    expect(fixture.calls).toContainEqual(expect.objectContaining({ includeDismissed: true, all: true, view: "mine" }));
    expect(fixture.calls.every((call) => call.view === "mine")).toBe(true);
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["For you2", "Unassigned1", "Company0"]);
    expect(container.querySelector('[data-row="mine-1"]')?.getAttribute("data-viewer")).toBe("scott");
    expect(container.querySelector("[data-attention-unassigned-banner]")?.textContent).toContain("1 card needs an owner");
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "scott", "mine", "with-dismissed"], exact: false })).toBeTruthy();
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
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "dotta", "mine", "with-dismissed"], exact: false })).toBeTruthy();
    expect(client.getQueryCache().find({ queryKey: ["attention", "company", "scott", "mine", "with-dismissed"], exact: false })).toBeTruthy();
  });

  it("shows a Company empty state from the URL", async () => {
    await render("/decisions?view=company");
    expect(fixture.calls).toContainEqual(expect.objectContaining({ view: "company" }));
    expect(container.textContent).toContain("No company alerts right now.");
  });
});
