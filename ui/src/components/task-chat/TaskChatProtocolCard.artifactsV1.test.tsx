// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import type { TaskChatProtocolItem } from "./task-chat-model";

vi.mock("@/hooks/useArtifactsV1Enabled", () => ({ useArtifactsV1Enabled: () => ({ enabled: true, loaded: true }) }));

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";

const deckPdf = {
  id: "work-product-1",
  companyId: "company-1",
  projectId: null,
  issueId: "issue-1",
  executionWorkspaceId: null,
  runtimeServiceId: null,
  type: "artifact",
  provider: "paperclip",
  externalId: null,
  title: "Interface Craft revision — PDF",
  url: null,
  status: "ready_for_review",
  reviewState: "none",
  isPrimary: false,
  healthStatus: "unknown",
  summary: null,
  metadata: {
    attachmentId: ATTACHMENT_ID,
    contentType: "application/pdf",
    byteSize: 59085,
    contentPath: `/api/attachments/${ATTACHMENT_ID}/content`,
    openPath: `/api/attachments/${ATTACHMENT_ID}/content?inline=1`,
    downloadPath: `/api/attachments/${ATTACHMENT_ID}/content?download=1`,
    originalFilename: "acmehats-interface-craft.pdf",
  },
  createdByRunId: null,
  createdAt: new Date("2026-09-28T11:07:00Z"),
  updatedAt: new Date("2026-09-28T11:07:00Z"),
} as unknown as IssueWorkProduct;

describe("TaskChatProtocolCard resources with Artifacts V1 on", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  const render = (item: TaskChatProtocolItem) =>
    flushSync(() =>
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <ThemeProvider>
              <TaskChatProtocolCard item={item} />
            </ThemeProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );

  it("renders a registered file as one row named after the file, with its size and state, opening where the card did", () => {
    render({ id: "resource:deliverable:work-product-1", kind: "protocol", surface: "resource", resourceKind: "deliverable", title: deckPdf.title, subtitle: "file · ready for review", href: `/api/attachments/${ATTACHMENT_ID}/content?inline=1`, workProduct: deckPdf });
    const row = container.querySelector('[data-testid="task-chat-resource-deliverable"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("acmehats-interface-craft.pdf");
    expect(row?.textContent).toContain("57.7 KB");
    expect(row?.textContent).toContain("PDF");
    const open = row?.querySelector<HTMLAnchorElement>('a[data-testid="task-chat-resource-deliverable-open"]');
    expect(open?.getAttribute("href")).toBe(`/api/attachments/${ATTACHMENT_ID}/content?inline=1`);
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(row?.querySelector('a[aria-label="Download acmehats-interface-craft.pdf"]')?.getAttribute("href")).toContain("download=1");
    expect(container.querySelector('[data-testid="task-chat-rich-work-product-artifact"]')).toBeNull();
  });

  it("renders a pull request as a link row that opens in a new tab with its state", () => {
    const pr = { ...deckPdf, id: "wp-pr", type: "pull_request", provider: "github", title: "Ship rich cards", url: "https://github.com/paperclipai/paperclip/pull/42", status: "merged", metadata: { number: 42 } } as unknown as IssueWorkProduct;
    render({ id: "resource:deliverable:wp-pr", kind: "protocol", surface: "resource", resourceKind: "deliverable", title: pr.title, subtitle: "pull request · merged", href: pr.url, workProduct: pr });
    const open = container.querySelector<HTMLAnchorElement>('a[data-testid="task-chat-resource-deliverable-open"]');
    expect(open?.getAttribute("href")).toBe("https://github.com/paperclipai/paperclip/pull/42");
    expect(open?.getAttribute("target")).toBe("_blank");
  });

  it("renders a task document as a row named after its key that stays in the app", () => {
    render({
      id: "resource:document:plan",
      kind: "protocol",
      surface: "resource",
      resourceKind: "document",
      title: "Launch plan",
      subtitle: "Document · rev 1",
      href: "#document-plan",
      document: { id: "doc-plan", issueId: "issue-1", key: "plan", title: "Launch plan", format: "markdown", latestRevisionNumber: 1, createdByAgentId: null, updatedByAgentId: null, createdAt: new Date("2026-09-27T08:36:00Z"), updatedAt: new Date("2026-09-27T08:36:00Z") } as never,
    });
    const row = container.querySelector('[data-testid="task-chat-resource-document"]');
    expect(row?.textContent).toContain("plan.md");
    expect(row?.textContent).toContain("DOC");
    const link = row?.querySelector<HTMLAnchorElement>('a[data-testid="task-chat-resource-document-open"]');
    expect(link?.getAttribute("href")).toBe("#document-plan");
    expect(link?.getAttribute("target")).toBeNull();
  });
});
