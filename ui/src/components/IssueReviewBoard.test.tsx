// @vitest-environment jsdom

import { act } from "react";
import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueReviewItem, IssueReviewPack, IssueReviewPackSurface } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueReviewBoard } from "./IssueReviewBoard";
import { IssueReviewItemDrawer } from "./IssueReviewItemDrawer";

const getFilePreview = vi.fn();

vi.mock("../api/issues", () => ({
  issuesApi: {
    getFilePreview: (...args: unknown[]) => getFilePreview(...args),
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: React.ComponentProps<"button"> & { asChild?: boolean }) => {
    if (asChild) return children;
    return <button {...props}>{children}</button>;
  },
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetContent: ({ children }: { children: ReactNode }) => <div data-testid="sheet-content">{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeReviewItem(overrides: Partial<IssueReviewItem> = {}): IssueReviewItem {
  return {
    id: "item-1",
    kind: "work_product",
    group: "review_now",
    title: "Published listing preview",
    subtitle: "preview_url",
    summary: "Marketplace draft preview",
    previewState: "ready",
    status: "new",
    thumbnailUrl: null,
    resolvedTarget: { url: "https://preview.paperclip.local/listings/preview-123" },
    sourceRefs: [
      {
        sourceType: "issue_comment",
        sourceId: "comment-1",
        commentId: "comment-1",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-04-17T10:00:00.000Z"),
      },
    ],
    mentionCount: 1,
    metadata: {
      provider: "paperclip",
      reviewState: "needs_board_review",
      status: "ready_for_review",
      type: "preview_url",
    },
    ...overrides,
  };
}

function makePack(overrides: Partial<IssueReviewPack> = {}): IssueReviewPack {
  return {
    id: "pack-1",
    title: "Publish listings pack",
    summary: "3 primary outputs with 2 supporting assets.",
    reason: "3 marketplace outputs grouped from the same listing workspace.",
    primaryItemIds: ["item-1"],
    evidenceItemIds: [],
    warningCodes: [],
    hints: [],
    status: "ready",
    nextActionLabel: "Inspect deliverable",
    nextActionTarget: { type: "item", value: "item-1" },
    mentionCount: 1,
    sourceRefs: [
      {
        sourceType: "issue_comment",
        sourceId: "comment-1",
        commentId: "comment-1",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: new Date("2026-04-17T10:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

function makeSurface(overrides: Partial<IssueReviewPackSurface> = {}): IssueReviewPackSurface {
  return {
    blockers: [],
    heroPack: makePack(),
    queue: [],
    evidence: [],
    ...overrides,
  };
}

function ReviewHarness({
  items,
  surface,
}: {
  items: IssueReviewItem[];
  surface: IssueReviewPackSurface;
}) {
  const [selected, setSelected] = useState<IssueReviewItem | null>(null);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <IssueReviewBoard issueId="issue-1" items={items} surface={surface} onOpenItem={setSelected} />
      <IssueReviewItemDrawer
        issueId="issue-1"
        item={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </QueryClientProvider>
  );
}

describe("IssueReviewBoard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getFilePreview.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders a blocker rail, hero review pack, supporting evidence, and opens the selected hero member", async () => {
    getFilePreview.mockResolvedValue({
      path: "ops/listing-templates/milanuncios.txt",
      absolutePath: "/tmp/project/ops/listing-templates/milanuncios.txt",
      exists: true,
      kind: "text",
      contentType: "text/plain; charset=utf-8",
      byteSize: 144,
      snippet: "Title: Milanuncios listing\nPrice: 1600 EUR",
      contentPath: null,
    });

    const root = createRoot(container);

    act(() => {
      root.render(
        <ReviewHarness
          items={[
            makeReviewItem({
              id: "wallapop",
              kind: "file",
              group: "references",
              title: "wallapop.txt",
              subtitle: "ops/listing-templates/wallapop.txt",
              summary: "Wallapop listing copy",
              previewState: "partial",
              resolvedTarget: { path: "ops/listing-templates/wallapop.txt" },
              metadata: { extension: ".txt" },
            }),
            makeReviewItem({
              id: "milanuncios",
              group: "references",
              kind: "file",
              title: "milanuncios.txt",
              subtitle: "ops/listing-templates/milanuncios.txt",
              summary: "Milanuncios listing copy",
              previewState: "partial",
              resolvedTarget: { path: "ops/listing-templates/milanuncios.txt" },
              metadata: { extension: ".txt" },
            }),
            makeReviewItem({
              id: "ebay",
              group: "references",
              kind: "file",
              title: "ebay-es.txt",
              subtitle: "ops/listing-templates/ebay-es.txt",
              summary: "eBay ES listing copy",
              previewState: "partial",
              resolvedTarget: { path: "ops/listing-templates/ebay-es.txt" },
              metadata: { extension: ".txt" },
            }),
            makeReviewItem({
              id: "checklist",
              group: "references",
              kind: "file",
              title: "publication-checklist.md",
              subtitle: "ops/listing-templates/publication-checklist.md",
              summary: "Checklist for final publication.",
              previewState: "partial",
              resolvedTarget: { path: "ops/listing-templates/publication-checklist.md" },
              metadata: { extension: ".md" },
            }),
            makeReviewItem({
              id: "readme",
              group: "references",
              kind: "file",
              title: "README.md",
              subtitle: "ops/listing-templates/README.md",
              summary: "Template guidance and caveats.",
              previewState: "partial",
              resolvedTarget: { path: "ops/listing-templates/README.md" },
              metadata: { extension: ".md" },
            }),
            makeReviewItem({
              id: "preview",
              kind: "work_product",
              group: "review_now",
              title: "Published listing preview",
              subtitle: "preview_url",
              summary: "Marketplace draft preview",
              previewState: "ready",
              resolvedTarget: { url: "https://preview.paperclip.local/listings/preview-123" },
            }),
          ]}
          surface={makeSurface({
            blockers: [
              {
                id: "blocker-1",
                title: "System error in issue state",
                summary: "Fix the issue state or add the missing dependency before treating this review pack as complete.",
                actionLabel: "Inspect issue state",
                actionTarget: { type: "issue", value: "issue-1" },
                severity: "critical",
              },
            ],
            heroPack: makePack({
              primaryItemIds: ["wallapop", "milanuncios", "ebay"],
              evidenceItemIds: ["checklist"],
              hints: [
                {
                  code: "missing_live_links",
                  label: "Live links not detected",
                  severity: "warning",
                  detail: "No preview URL or marketplace link was detected in the issue context yet.",
                },
                {
                  code: "no_visible_images",
                  label: "No visible images",
                  severity: "warning",
                  detail: "No image attachments were detected for this review pack.",
                },
              ],
              warningCodes: ["missing_live_links", "no_visible_images"],
              status: "warning",
              nextActionLabel: "Inspect primary outputs",
            }),
            queue: [
              makePack({
                id: "queue-1",
                title: "Published listing preview",
                summary: "Marketplace draft preview",
                reason: "Primary work product surfaced for review.",
                primaryItemIds: ["preview"],
                nextActionLabel: "Inspect deliverable",
                nextActionTarget: { type: "item", value: "preview" },
              }),
            ],
            evidence: ["readme"],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Review pack");
    expect(container.textContent).toContain("Review blockers");
    expect(container.textContent).toContain("System error in issue state");
    expect(container.textContent).toContain("Publish listings pack");
    expect(container.textContent).toContain("3 marketplace outputs grouped from the same listing workspace.");
    expect(container.textContent).toContain("Live links not detected");
    expect(container.textContent).toContain("No visible images");
    expect(container.textContent).toContain("Next up");
    expect(container.textContent).toContain("Supporting evidence");
    expect(container.textContent).toContain("README.md");

    const memberButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("milanuncios.txt"),
    );
    expect(memberButton).toBeTruthy();

    act(() => {
      memberButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const inspectButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Inspect primary outputs"),
    );
    expect(inspectButton).toBeTruthy();

    await act(async () => {
      inspectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Title: Milanuncios listing");
      });
    });

    expect(container.textContent).toContain("milanuncios.txt");
    expect(container.textContent).toContain("Jump to source");
    expect(getFilePreview).toHaveBeenCalledWith("issue-1", "ops/listing-templates/milanuncios.txt");

    act(() => {
      root.unmount();
    });
  });

  it("shows only four queued cards until expanded", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ReviewHarness
          items={[
            makeReviewItem({ id: "hero", title: "Primary preview", summary: "Hero preview" }),
            makeReviewItem({ id: "queue-1", title: "Queue one", summary: "Queue one" }),
            makeReviewItem({ id: "queue-2", title: "Queue two", summary: "Queue two" }),
            makeReviewItem({ id: "queue-3", title: "Queue three", summary: "Queue three" }),
            makeReviewItem({ id: "queue-4", title: "Queue four", summary: "Queue four" }),
            makeReviewItem({ id: "queue-5", title: "Queue five", summary: "Queue five" }),
          ]}
          surface={makeSurface({
            heroPack: makePack({
              title: "Primary review pack",
              primaryItemIds: ["hero"],
              reason: "Primary review target surfaced from the current issue context.",
            }),
            queue: [
              makePack({ id: "qp-1", title: "Queue one", primaryItemIds: ["queue-1"] }),
              makePack({ id: "qp-2", title: "Queue two", primaryItemIds: ["queue-2"] }),
              makePack({ id: "qp-3", title: "Queue three", primaryItemIds: ["queue-3"] }),
              makePack({ id: "qp-4", title: "Queue four", primaryItemIds: ["queue-4"] }),
              makePack({ id: "qp-5", title: "Queue five", primaryItemIds: ["queue-5"] }),
            ],
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Queue one");
    expect(container.textContent).toContain("Queue two");
    expect(container.textContent).toContain("Queue three");
    expect(container.textContent).toContain("Queue four");
    expect(container.textContent).not.toContain("Queue five");

    const expandButton = Array.from(container.querySelectorAll("button")).find((node) =>
      node.textContent?.includes("Show 1 more"),
    );
    expect(expandButton).toBeTruthy();

    act(() => {
      expandButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Queue five");

    act(() => {
      root.unmount();
    });
  });
});
