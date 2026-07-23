// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StatusCard } from "@paperclipai/shared";
import { StatusCardTile } from "./StatusCardTile";
import type { StatusCardView } from "./types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!HTMLElement.prototype.hasPointerCapture) {
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
}

// Keep the tile deterministic: the streaming hook is exercised elsewhere.
vi.mock("@/components/useSummaryDraftStream", () => ({
  useSummaryDraftStream: () => ({ runId: null, statusLine: null, draft: null, draftClosed: false, hasStream: false }),
}));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

function baseCard(overrides: Partial<StatusCardView>): StatusCardView {
  const card: StatusCard = {
    id: "card-1",
    companyId: "company-1",
    createdByUserId: null,
    createdByAgentId: null,
    title: "Decisions v1 rollout",
    titlePinned: false,
    interestPrompt: "issues that help ship the new install subcommand",
    queries: [],
    queryVersion: 1,
    queryCompiledAt: "2026-07-22T10:00:00.000Z",
    queryCompiledByAgentId: null,
    instructionsMode: "none",
    instructions: null,
    refreshPolicy: {
      mode: "interval",
      intervalMinutes: 15,
      triggers: {
        statusTransitions: true,
        membershipChanges: true,
        humanComments: true,
        assigneeChanges: true,
        anyUpdate: false,
      },
    },
    state: "active",
    pendingChangeCount: 0,
    lastChangeAt: null,
    fingerprint: null,
    fingerprintAt: null,
    documentId: null,
    lastUpdateRunKind: "full",
    lastGeneratedAt: "2026-07-22T11:00:00.000Z",
    lastModel: "claude-haiku",
    generatingIssueId: null,
    failureReason: null,
    nextEvalAt: null,
    archivedAt: null,
    archivedByUserId: null,
    archivedByAgentId: null,
    createdAt: "2026-07-22T09:00:00.000Z",
    updatedAt: "2026-07-22T11:00:00.000Z",
  };
  return { ...card, summaryBody: "All on track. Next: review the deep-link fix, then merge.", ...overrides };
}

let container: HTMLDivElement;
let root: Root;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function render(node: ReactNode) {
  flushSync(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
}

const noop = () => {};

function tile(card: StatusCardView) {
  return (
    <StatusCardTile
      card={card}
      companyId="company-1"
      onOpen={noop}
      onRefresh={noop}
      onRecompile={noop}
      onEditInterest={noop}
      onOpenDebug={noop}
      onArchive={noop}
    />
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("StatusCardTile lifecycle rendering", () => {
  it("renders a fresh card with its summary and policy footer", () => {
    render(tile(baseCard({ state: "active", pendingChangeCount: 0 })));
    const el = container.querySelector('[data-testid="status-card-tile"]');
    expect(el?.getAttribute("data-lifecycle")).toBe("fresh");
    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toContain("All on track");
    expect(container.textContent).toContain("every 15m if changed");
  });

  it("renders a stale card with the pending-change strip", () => {
    render(tile(baseCard({ state: "active", pendingChangeCount: 5 })));
    expect(container.querySelector('[data-lifecycle="stale"]')).toBeTruthy();
    expect(container.textContent).toContain("5 changes since last update");
    // Stale keeps the last good summary visible (never blank).
    expect(container.querySelector('[data-testid="markdown-body"]')).toBeTruthy();
  });

  it("renders a compiling card with dashed border and no summary claim", () => {
    render(tile(baseCard({ state: "compiling", title: null, summaryBody: null })));
    const el = container.querySelector('[data-lifecycle="compiling"]');
    expect(el).toBeTruthy();
    expect(el?.className).toContain("border-dashed");
    expect(container.textContent).toContain("Agent is building your query");
  });

  it("renders an updating card with the delta banner and keeps the old summary", () => {
    render(tile(baseCard({ generatingIssueId: "issue-9", pendingChangeCount: 3 })));
    expect(container.querySelector('[data-lifecycle="updating"]')).toBeTruthy();
    expect(container.textContent).toContain("Integrating 3 changes");
    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toContain("All on track");
  });

  it("renders an error card with retry/details and the last good summary", () => {
    render(tile(baseCard({ state: "error", failureReason: "run failed" })));
    expect(container.querySelector('[data-lifecycle="error"]')).toBeTruthy();
    expect(container.textContent).toContain("Last update failed");
    expect(container.textContent).toContain("Retry");
    expect(container.textContent).toContain("Showing last good summary");
  });

  it("renders paused (budget) with a paused banner", () => {
    render(tile(baseCard({ state: "paused_budget" })));
    expect(container.querySelector('[data-lifecycle="paused_budget"]')).toBeTruthy();
    expect(container.textContent).toContain("Daily token cap reached");
  });

  it("renders paused (hours)", () => {
    render(tile(baseCard({ state: "paused_hours" })));
    expect(container.querySelector('[data-lifecycle="paused_hours"]')).toBeTruthy();
    expect(container.textContent).toContain("Outside active hours");
  });

  it("shows tokens and cost in the footer when provided", () => {
    render(tile(baseCard({ todayTokens: 1100, todayCostCents: 62 })));
    expect(container.textContent).toContain("1.1k tok");
    expect(container.textContent).toContain("$0.62");
  });
});
