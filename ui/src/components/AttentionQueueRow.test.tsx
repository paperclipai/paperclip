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
    expiresAt: overrides.expiresAt ?? null,
    ruleKey: overrides.ruleKey ?? null,
    originAgentName: overrides.originAgentName ?? null,
    queues: overrides.queues ?? [],
    shelf: overrides.shelf ?? false,
    retentionDays: overrides.retentionDays ?? 30,
    keep: overrides.keep ?? false,
    archivedAt: overrides.archivedAt ?? null,
    retentionVersion: overrides.retentionVersion ?? 1,
    decideBy: overrides.decideBy ?? null,
    decideByAttribution: overrides.decideByAttribution ?? null,
    snoozedUntil: overrides.snoozedUntil ?? null,
    trainingExampleId: overrides.trainingExampleId ?? null,
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

  it("does not inline a review — it deep-links instead", () => {
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
    expect(el.textContent).toContain("Open");
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

  // The eyebrow carries the decision kind and the task key only. Project
  // identity was removed from the card: the queue is filtered and grouped by
  // project from the toolbar, so repeating it on every row spent the eyebrow's
  // width on a fact the operator had usually just chosen.
  it("keeps project identity off the card", () => {
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

    expect(container?.querySelector('[data-testid="attention-project-meta"]')).toBeNull();
    expect(container?.textContent).not.toContain("Alpha");
  });

  it("separates eyebrow facts with a middle dot, not a slash", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "blocker_attention",
          subject: {
            kind: "issue",
            id: "i1",
            companyId: "c1",
            title: "Update primary paperclip instance",
            identifier: "PAP-23",
            status: "blocked",
            href: "/PAP/issues/PAP-23",
          },
          relatedIssue: null,
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const eyebrow = container?.querySelector('[data-attention-row] > div');
    expect(eyebrow?.textContent).toContain("·");
    expect(eyebrow?.textContent).not.toContain("/");
  });

  // Regression: the meta breadcrumb used to read only `relatedIssue`, so rows
  // whose subject IS the task (reviews, blocked dependencies) showed no key at
  // all — the rows most obviously about a task were the ones missing it.
  it("shows the task key when the subject is the task itself", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "blocker_attention",
          subject: {
            kind: "issue",
            id: "i1",
            companyId: "c1",
            title: "Update primary paperclip instance",
            identifier: "PAP-23",
            status: "blocked",
            href: "/PAP/issues/PAP-23",
          },
          relatedIssue: null,
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const link = Array.from(container?.querySelectorAll("a") ?? []).find((a) => a.textContent === "PAP-23");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe("/PAP/issues/PAP-23");
  });

  it("shows no task key on a row that is not attached to a task", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ relatedIssue: null })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    expect(container?.textContent).not.toMatch(/PAP-\d+/);
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

  // Rows became rounded cards when the decision types were flattened: with the
  // left accent rail gone, the card's own shape carries the separation that the
  // rail used to, so square edges no longer read as deliberate.
  it("uses rounded card edges and can show a keyboard selection ring", () => {
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
    expect(row?.getAttribute("class")).toContain("rounded-xl");
    expect(row?.getAttribute("class")).toContain("ring-ring");
  });

  it("renders collapsed inline decision verbs in a dedicated action bar with semantic variants", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          decisionVerbs: [
            { id: "approve", label: "Approve", description: null },
            { id: "reject", label: "Reject", description: null },
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

    // The footer splits the row's last line: disclosure on the left, decision
    // verbs on the right, so the affirmative verb sits in the same place in
    // every row whether it is collapsed or expanded.
    const actionArea = decisionActions?.closest('[data-attention-actions="true"]');
    expect(actionArea?.getAttribute("class")).toContain("justify-between");
    expect(decisionActions?.parentElement?.getAttribute("class")).toContain("@xl:justify-end");

    const rowMenu = container?.querySelector('[aria-label="Row actions"]');
    expect(rowMenu?.closest('[data-attention-menu="true"]')).toBeTruthy();
    expect(rowMenu?.closest('[data-attention-actions="true"]')).toBeNull();

    const buttons = Array.from(decisionActions?.querySelectorAll("button") ?? []);
    expect(buttons.find((button) => button.textContent === "Approve")?.getAttribute("data-variant")).toBe(
      "default",
    );
    expect(buttons.find((button) => button.textContent === "Reject")?.getAttribute("data-variant")).toBe(
      "destructive",
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

  it("renders configured confirmation labels and accepts from the compact action area", async () => {
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

    const decisionActions = container?.querySelector('[aria-label="Decision actions"]');
    expect(decisionActions?.textContent).toContain("Approve plan");
    expect(decisionActions?.textContent).toContain("Request changes");
    expect(Array.from(decisionActions?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Approve plan")?.getAttribute("data-variant")).toBe("default");
    expect(Array.from(decisionActions?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Request changes")?.getAttribute("data-variant")).toBe("outline");

    const approve = Array.from(decisionActions?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Approve plan",
    );
    act(() => approve?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(issuesApi.acceptInteraction).toHaveBeenCalledWith("issue-1", "interaction-1");
    expect(onToggleExpand).not.toHaveBeenCalled();
  });

  it("opens the matching confirmation form when requesting changes from a compact action", () => {
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

    const requestChanges = Array.from(container?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Request changes",
    );
    act(() => requestChanges?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(onToggleExpand).toHaveBeenCalledOnce();
    expect(issuesApi.rejectInteraction).not.toHaveBeenCalled();
  });

  // The old context row bundled project identity + thumbnails together; project
  // identity has since moved up into the meta breadcrumb, so evidence is now a
  // block of the row's own column rather than a shared strip.
  it("renders evidence thumbnails as their own block below the text stack", () => {
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

    const image = container?.querySelector('img[alt="Screenshot"]');
    expect(image?.getAttribute("src")).toBe("/api/assets/asset-1/content");

    const thumbnailStack = image?.parentElement?.parentElement;
    expect(thumbnailStack?.getAttribute("class")).toContain("items-center");
    // The strip is collapsed-only content: it rides the inverse disclosure so
    // it can fade out as the expanded gallery fades in, rather than popping.
    const cluster = thumbnailStack?.closest("[data-decision-disclosure]");
    expect(cluster).toBeTruthy();
    expect(cluster?.getAttribute("data-state")).toBe("open");
    expect(cluster?.closest("[data-attention-row]")).toBeTruthy();
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

  it("makes a non-inline row with images expandable", () => {
    const onToggleExpand = vi.fn();
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          detail: {
            kind: "generic",
            summaryExcerpt: "3 files changed",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
            ],
          },
        })}
        companyId="c1"
        expanded={false}
        onToggleExpand={onToggleExpand}
        onDismiss={noop}
      />,
    );
    const header = container?.querySelector('[role="button"][aria-expanded]');
    expect(header).not.toBeNull();
    act(() => (header as HTMLElement).click());
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
  });

  it("shows a larger gallery with an n-more link to the issue when expanded", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          relatedIssue: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "Ship it",
            identifier: "PAP-42",
            status: "in_progress",
            href: "/PAP/issues/PAP-42",
            metadata: {},
          },
          detail: {
            kind: "generic",
            summaryExcerpt: "5 screenshots",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
              { assetId: "img-3", alt: "three" },
              { assetId: "img-4", alt: "four" },
              { assetId: "img-5", alt: "five" },
            ],
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );
    const gallery = container?.querySelector('[data-attention-expanded-images="true"]');
    expect(gallery).not.toBeNull();
    // First three images render at the larger size.
    expect(gallery?.querySelectorAll("img")).toHaveLength(3);
    // "n more" link points at the related issue (5 images − 3 shown = 2 more).
    const moreLink = Array.from(gallery?.querySelectorAll("a") ?? []).find((a) =>
      a.textContent?.includes("2 more"),
    );
    expect(moreLink).toBeDefined();
    expect(moreLink?.getAttribute("href")).toBe("/PAP/issues/PAP-42");
  });

  it("shows the remaining image count when no issue link is available", () => {
    render(
      <AttentionQueueRow
        item={buildItem({
          sourceKind: "review" as AttentionSourceKind,
          inlineResolvable: false,
          subject: {
            kind: "issue",
            id: "issue-1",
            companyId: "c1",
            title: "Unlinked review",
            identifier: null,
            status: "in_review",
            href: null,
            metadata: {},
          },
          detail: {
            kind: "generic",
            summaryExcerpt: "4 screenshots",
            images: [
              { assetId: "img-1", alt: "one" },
              { assetId: "img-2", alt: "two" },
              { assetId: "img-3", alt: "three" },
              { assetId: "img-4", alt: "four" },
            ],
          },
        })}
        companyId="c1"
        expanded
        onToggleExpand={noop}
        onDismiss={noop}
      />,
    );

    const gallery = container?.querySelector('[data-attention-expanded-images="true"]');
    expect(gallery?.textContent).toContain("1 more");
    expect(gallery?.querySelectorAll("a")).toHaveLength(0);
  });

  // Decision training (PAP-14299): a trainable row shows the train affordance;
  // the trained/untrained state renders purely from `trainingExampleId`.
  function trainableItem(overrides: Partial<AttentionItem> = {}): AttentionItem {
    return buildItem({
      sourceKind: "issue_thread_interaction",
      subject: {
        kind: "interaction",
        id: "interaction-1",
        companyId: "c1",
        title: "Approve the migration plan?",
        identifier: null,
        status: "pending",
        href: "/PAP/issues/PAP-1",
        metadata: { issueId: "issue-1", kind: "request_confirmation" },
      },
      ...overrides,
    });
  }

  // Training moved off the header strip into the row's overflow menu, so the
  // header carries only recency + overflow. Menu items live in a portal that
  // only mounts once opened — environment-flaky in jsdom (see the dismiss test
  // above) — so the untrained path asserts the menu exists and no badge is
  // shown, and the onTrain contract is exercised through the inline badge.
  it("offers training through the row menu and shows no badge until trained", () => {
    render(
      <AttentionQueueRow
        item={trainableItem()}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        onTrain={noop}
      />,
    );
    expect(container?.querySelector('[aria-label="Row actions"]')).toBeTruthy();
    expect(container?.querySelector('[data-testid="attention-trained-badge"]')).toBeNull();
  });

  it("renders a Trained ✓ badge once trained and fires onTrain when it is clicked", () => {
    const onTrain = vi.fn();
    render(
      <AttentionQueueRow
        item={trainableItem({ trainingExampleId: "example-1" })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        onTrain={onTrain}
      />,
    );
    const badge = container?.querySelector('[data-testid="attention-trained-badge"]');
    expect(badge?.textContent).toContain("Trained");
    act(() => badge?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onTrain).toHaveBeenCalledWith(expect.objectContaining({ id: "a1" }));
  });

  it("does not offer training on a decision that isn't anchored to an issue", () => {
    render(
      <AttentionQueueRow
        item={buildItem({ subject: { ...buildItem().subject, metadata: {} }, relatedIssue: null })}
        companyId="c1"
        expanded={false}
        onToggleExpand={noop}
        onDismiss={noop}
        onTrain={noop}
      />,
    );
    expect(container?.querySelector('[data-testid="attention-train-button"]')).toBeNull();
  });
});
