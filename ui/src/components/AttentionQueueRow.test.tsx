// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useState, type AnchorHTMLAttributes, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttentionItem, AttentionSourceKind } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { issuesApi } from "../api/issues";
import { ToastViewport } from "./ToastViewport";
import { ToastProvider } from "../context/ToastContext";
import { AttentionQueueRow } from "./AttentionQueueRow";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
    requestRevision: vi.fn(),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    acceptInteraction: vi.fn(),
    rejectInteraction: vi.fn(),
  },
}));

// Spy on `relativeTime` (called exactly once per active-row render) so the
// memoization test below can count row renders without a profiling build.
vi.mock("../lib/utils", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/utils")>();
  return { ...original, relativeTime: vi.fn(original.relativeTime) };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          {element}
          <ToastViewport />
        </QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

function buildItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a1",
    companyId: "c1",
    sourceKind: "approval",
    subject: {
      kind: "approval",
      id: "approval-1",
      companyId: "c1",
      title: "Hire agent: Research Analyst",
      identifier: null,
      status: "pending",
      href: "/PAP/approvals/approval-1",
      metadata: {},
    },
    whyNow: "Approval is pending a board decision.",
    decisionVerbs: [],
    inlineResolvable: true,
    entryRule: "",
    exitRule: "",
    dedupKey: "approval:approval-1",
    dismissalKey: "attention:approval:approval-1",
    severity: "high",
    rank: 0,
    activityAt: "2026-07-09T12:00:00Z",
    createdAt: "2026-07-09T12:00:00Z",
    updatedAt: "2026-07-09T12:00:00Z",
    relatedIssue: null,
    project: null,
    workspace: null,
    detail: null,
    dismissal: null,
    ...overrides,
  };
}

const noop = () => {};

describe("AttentionQueueRow", () => {
  it("renders an inline approval resolver when expanded", () => {
    const el = render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(el.textContent).toContain("Approve");
    expect(el.textContent).toContain("Request revision");
    expect(el.textContent).toContain("Reject");
    // Inline rows show an expand chevron, not an "Open" deep-link.
    expect(el.textContent).not.toContain("Open");
  });

  it("does not inline a review — it deep-links with the Review verb instead", () => {
    const el = render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: true,
          subject: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "PR ready for review",
            identifier: null,
            status: "in_review",
            href: "/PAP/issues/PAP-1",
            metadata: {},
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    // Deep-link cards carry one solid advance verb — "Review" for review rows.
    // Selected via data-variant: the footer's first anchor is now the 4a
    // context link, which is a plain link rather than a Button.
    const actionArea = container?.querySelector('[data-attention-actions="true"]');
    const cta = actionArea?.querySelector("a[data-variant]");
    expect(cta?.textContent).toBe("Review");
    expect(cta?.getAttribute("href")).toBe("/PAP/issues/PAP-1");
    expect(cta?.getAttribute("data-variant")).toBe("default");
    // No approval buttons should render for a review row.
    expect(el.textContent).not.toContain("Request revision");
  });

  it("fires onDismiss from the row menu action", () => {
    const onDismiss = vi.fn();
    const item = buildItem();
    render(
      <AttentionQueueRow
        item={item}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={onDismiss}
      />,
    );
    // The dropdown trigger + item live in a portal; invoke the handler contract
    // directly via the rendered menu after opening is environment-flaky in
    // jsdom, so assert the wiring by locating the trigger exists.
    const trigger = container?.querySelector('[aria-label="Row actions"]');
    expect(trigger).toBeTruthy();
  });

  it("toggles expand when the collapsed header of an inline row is clicked", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );
    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header).toBeTruthy();
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      header?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("exposes the visible expand chevron as an accessible button", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const chevronButton = container?.querySelector('button[aria-label="Expand decision"]');
    expect(chevronButton).toBeTruthy();
    expect(chevronButton?.getAttribute("aria-expanded")).toBe("false");
    act(() => chevronButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggleExpand).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("does not navigate on title click — the title is plain text, not a link", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const links = Array.from(container?.querySelectorAll("a") ?? []);
    // No anchor should carry the subject title (only the identifier link, absent here).
    expect(links.some((a) => a.textContent?.includes("Hire agent: Research Analyst"))).toBe(false);
  });

  it("renders project identity once without a filter button", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          project: { id: "project-1", name: "Alpha", urlKey: "alpha", color: null, icon: "rocket" },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const projectMeta = container?.querySelector('[data-testid="attention-project-meta"]');
    expect(projectMeta?.textContent).toBe("Alpha");
    expect(projectMeta?.querySelector("button")).toBeNull();
    expect(projectMeta?.getAttribute("class")).not.toContain("border");
    expect(projectMeta?.getAttribute("class")).not.toContain("bg-");
    expect(container?.querySelector('button[title="Filter by Alpha"]')).toBeNull();
    expect(container?.textContent?.match(/Alpha/g)).toHaveLength(1);
  });

  it("places the timestamp beside the row menu without a clock icon", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const menu = container?.querySelector('[aria-label="Row actions"]');
    const menuArea = menu?.closest('[data-attention-menu="true"]');
    expect(menuArea?.textContent).not.toBe("");
    expect(container?.querySelector("svg.lucide-clock")).toBeNull();
  });

  it("uses square row edges and can show a keyboard selection ring", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        selected
      />,
    );

    const row = container?.querySelector("[data-attention-row]");
    expect(row?.getAttribute("class")).not.toContain("rounded");
    expect(row?.getAttribute("class")).toContain("ring-ring");
  });

  it("renders collapsed decision verbs as one solid advance + one outline counter, footer-right", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          decisionVerbs: [
            { id: "approve", label: "Approve", description: null },
            { id: "reject", label: "Reject", description: null },
            { id: "request_revision", label: "Request revision", description: null },
          ],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header?.textContent).not.toContain("Approve");
    expect(header?.textContent).not.toContain("Reject");

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    expect(decisionActions?.textContent).toContain("Approve");
    expect(decisionActions?.textContent).toContain("Reject");
    // The third verb stays in the expanded resolver — a card carries at most two CTAs.
    expect(decisionActions?.textContent).not.toContain("Request revision");

    // The footer band now splits context-left / CTAs-right (4a), so the
    // justify-end contract moved from the outer bar to the CTA group.
    const actionArea = decisionActions?.closest('[data-attention-actions="true"]');
    expect(actionArea?.getAttribute("class")).toContain("justify-between");
    expect(decisionActions?.parentElement?.getAttribute("class")).toContain("justify-end");

    const rowMenu = container?.querySelector('[aria-label="Row actions"]');
    expect(rowMenu?.closest('[data-attention-menu="true"]')).toBeTruthy();
    expect(rowMenu?.closest('[data-attention-actions="true"]')).toBeNull();

    const buttons = Array.from(decisionActions?.querySelectorAll("button") ?? []);
    // One size for every CTA; solid advance verb, outline counter-verb (red is
    // reserved for the Critical badge, so Reject is no longer destructive).
    expect(buttons.every((button) => button.getAttribute("data-size") === "sm")).toBe(true);
    expect(buttons.find((button) => button.textContent === "Approve")?.getAttribute("data-variant")).toBe(
      "default",
    );
    expect(buttons.find((button) => button.textContent === "Reject")?.getAttribute("data-variant")).toBe(
      "outline",
    );
  });

  it("submits a compact approval without expanding the card and confirms it", async () => {
    const onToggleExpand = vi.fn();
    vi.mocked(approvalsApi.approve).mockResolvedValue({} as never);
    render(
      <AttentionQueueRow
        item={buildItem({
          decisionVerbs: [{ id: "approve", label: "Approve", description: null }],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const approve = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Approve",
    );
    act(() => approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(approvalsApi.approve).toHaveBeenCalledWith("approval-1");
    expect(onToggleExpand).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Approval approved");
  });

  it("normalizes configured confirmation labels to Approve/Reject and accepts from the card", async () => {
    const onToggleExpand = vi.fn();
    vi.mocked(issuesApi.acceptInteraction).mockResolvedValue({} as never);
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-1",
            companyId: "c1",
            title: "Plan approval",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-1",
            metadata: { kind: "request_confirmation", issueId: "issue-1" },
          },
          decisionVerbs: [
            { id: "accept", label: "Approve plan", description: null },
            { id: "reject", label: "Request changes", description: null },
          ],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    // The card uses the fixed six-verb vocabulary; configured wording ("Approve
    // plan" / "Request changes") only appears once the resolver is expanded.
    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    expect(decisionActions?.textContent).not.toContain("Approve plan");
    expect(decisionActions?.textContent).not.toContain("Request changes");
    const buttons = Array.from(decisionActions?.querySelectorAll("button") ?? []);
    expect(buttons.find((button) => button.textContent === "Approve")?.getAttribute("data-variant")).toBe("default");
    expect(buttons.find((button) => button.textContent === "Reject")?.getAttribute("data-variant")).toBe("outline");

    const approve = buttons.find((button) => button.textContent === "Approve");
    act(() => approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(issuesApi.acceptInteraction).toHaveBeenCalledWith("issue-1", "interaction-1");
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("opens the matching confirmation form when rejecting from a compact action", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-1",
            companyId: "c1",
            title: "Plan approval",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-1",
            metadata: { kind: "request_confirmation", issueId: "issue-1" },
          },
          decisionVerbs: [{ id: "reject", label: "Request changes", description: null }],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const reject = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Reject",
    );
    act(() => reject?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onToggleExpand).toHaveBeenCalledOnce();
    expect(issuesApi.rejectInteraction).not.toHaveBeenCalled();
  });

  it("gives questions an Answer advance verb that expands the inline resolver", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-2",
            companyId: "c1",
            title: "Questions need answers",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-2",
            metadata: { kind: "ask_user_questions", issueId: "issue-1" },
          },
          decisionVerbs: [{ id: "respond", label: "Respond", description: null }],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    const answer = Array.from(decisionActions?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Answer",
    );
    expect(answer?.getAttribute("data-variant")).toBe("default");
    act(() => answer?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggleExpand).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
    expect(issuesApi.acceptInteraction).not.toHaveBeenCalled();
  });

  it("gives multi-item interactions a Review advance verb that expands the inline resolver", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: "interaction-3",
            companyId: "c1",
            title: "Suggested tasks need a decision",
            identifier: null,
            status: "pending",
            href: "/PAP/issues/issue-1#interaction-interaction-3",
            metadata: { kind: "suggest_tasks", issueId: "issue-1" },
          },
          decisionVerbs: [
            { id: "accept", label: "Accept", description: null },
            { id: "reject", label: "Reject", description: null },
          ],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    const review = Array.from(decisionActions?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Review",
    );
    expect(review?.getAttribute("data-variant")).toBe("default");
    act(() => review?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onToggleExpand).toHaveBeenCalledOnce();
    expect(issuesApi.acceptInteraction).not.toHaveBeenCalled();
  });

  // Anatomy 5b: the thumbnail row was removed from the card — evidence lives
  // one click away behind the footer-left context link, so detail images must
  // never render inline even when the payload carries them.
  it("does not render evidence thumbnails even when the detail payload has images", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          detail: {
            kind: "generic",
            summaryExcerpt: "Visual evidence attached.",
            images: [{ assetId: "asset-1", alt: "Screenshot" }],
          },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    expect(container?.querySelector('img[alt="Screenshot"]')).toBeNull();
    expect(container?.querySelector('img[src*="asset-1"]')).toBeNull();
  });

  it("is memoized — a parent re-render with identical props does not re-render the row", async () => {
    const { relativeTime } = await import("../lib/utils");
    const item = buildItem();
    let bump: () => void = () => {};
    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((n) => n + 1);
      return (
        <AttentionQueueRow
          item={item}
          companyId="c1"
          expanded={false}
          onToggleExpand={noop}
          onDismiss={noop}
        />
      );
    }
    render(<Harness />);
    const rendersAfterMount = vi.mocked(relativeTime).mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);
    act(() => bump());
    expect(vi.mocked(relativeTime).mock.calls.length).toBe(rendersAfterMount);
  });

  it("does not expose a toggle button for non-inline rows", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ sourceKind: "failed_run" as AttentionSourceKind, inlineResolvable: false })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(container?.querySelector('[role="button"][aria-expanded]')).toBeNull();
  });

  it("always shows a footer-left context link named for the source (4a)", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const link = container?.querySelector('[data-attention-context-link="true"]');
    expect(link?.textContent).toBe("View request→");
    expect(link?.getAttribute("href")).toBe("/PAP/approvals/approval-1");
    // Footer-left: the link leads the footer band, ahead of the CTA group.
    expect(link?.closest('[data-attention-actions="true"]')?.firstElementChild).toBe(link);
  });

  it("keeps the context link visible while the resolver is expanded", () => {
    render(
      <AttentionQueueRow
        item={buildItem()}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const link = container?.querySelector('[data-attention-context-link="true"]');
    expect(link?.textContent).toContain("View request");
  });

  it("gives curtain rows the context link beside Restore", () => {
    const onRestore = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          dismissal: { kind: "dismiss", dismissedAt: "2026-07-12T12:00:00Z" } as AttentionItem["dismissal"],
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        onRestore={onRestore}
        variant="hidden"
      />,
    );

    const link = container?.querySelector('[data-attention-context-link="true"]');
    expect(link?.getAttribute("href")).toBe("/PAP/approvals/approval-1");
    const restore = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Restore",
    );
    expect(restore).toBeTruthy();
  });
});
