// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueAttachment, IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import { artifactReviewDocumentKey } from "@paperclipai/shared";
import { IssuePropertiesArtifactsTab } from "./IssuePropertiesArtifactsTab";
import { ApiError } from "@/api/client";

const mockIssuesApi = vi.hoisted(() => ({
  listAttachments: vi.fn(async (): Promise<unknown[]> => []),
  listWorkProducts: vi.fn(async (): Promise<unknown[]> => []),
  ensureWorkProductReviewDocument: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));

const mockUseIssueDocuments = vi.hoisted(() =>
  vi.fn((): { data: IssueDocument[] } => ({ data: [] })),
);
vi.mock("@/hooks/useIssueDocuments", () => ({ useIssueDocuments: mockUseIssueDocuments }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => (
    <div data-testid="markdown-body">{children}</div>
  ),
}));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => (
    <span data-testid={`annotation-count-${docKey}`} />
  ),
  IssueDocumentAnnotations: ({ doc, children }: { doc: IssueDocument; children: React.ReactNode }) => (
    <div data-testid={`annotation-surface-${doc.key}`} data-document-id={doc.id}>{children}</div>
  ),
}));

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const WORK_PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_KEY = artifactReviewDocumentKey(WORK_PRODUCT_ID);

const issue = { id: "issue-1", identifier: "PAP-1534", workMode: "standard" } as Issue;

function makeMarkdownWorkProduct(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  const contentPath = `/api/attachments/${ATTACHMENT_ID}/content`;
  return {
    id: WORK_PRODUCT_ID,
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: "Verification report",
    url: null,
    status: "ready_for_review",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {
      attachmentId: ATTACHMENT_ID,
      contentType: "text/markdown",
      byteSize: 64,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: "report.md",
    },
    createdByRunId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    updatedAt: new Date("2026-08-01T12:00:00Z"),
    ...overrides,
  } as IssueWorkProduct;
}

function makeReviewDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: REVIEW_KEY,
    title: "Verification report",
    format: "markdown",
    body: "# Report\n\nRendered body",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    updatedAt: new Date("2026-08-01T12:00:00Z"),
    ...overrides,
  } as IssueDocument;
}

function makeMarkdownAttachment(): IssueAttachment {
  return {
    id: ATTACHMENT_ID,
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: "asset-1",
    provider: "local",
    objectKey: `objects/${ATTACHMENT_ID}`,
    contentType: "text/markdown",
    byteSize: 64,
    sha256: "0".repeat(64),
    originalFilename: "report.md",
    createdByAgentId: "agent-1",
    createdByUserId: null,
    createdAt: new Date("2026-08-01T12:00:00Z"),
    updatedAt: new Date("2026-08-01T12:00:00Z"),
    contentPath: `/api/attachments/${ATTACHMENT_ID}/content`,
  } as IssueAttachment;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("markdown work product review row", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    Element.prototype.scrollIntoView = vi.fn();
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([makeMarkdownWorkProduct()]);
    mockUseIssueDocuments.mockReturnValue({ data: [] });
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => currentRoot.unmount());
      root = null;
    }
    container.remove();
  });

  async function renderTab(props: { documentDeepLink?: { requestId: number; documentKey: string } | null } = {}) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    root = createRoot(container);
    const currentRoot = root;
    await act(async () =>
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <IssuePropertiesArtifactsTab issue={issue} {...props} />
        </QueryClientProvider>,
      ),
    );
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Verification report");
    });
  }

  function expandButton() {
    return container.querySelector('button[aria-expanded]') as HTMLButtonElement;
  }

  it("renders an expandable row with explicit raw and download actions", async () => {
    await renderTab();

    expect(expandButton().textContent).toContain("Verification report");
    const raw = container.querySelector('a[title="Open raw"]') as HTMLAnchorElement;
    const download = container.querySelector('a[title="Download"]') as HTMLAnchorElement;
    expect(raw?.getAttribute("href")).toBe(`/api/attachments/${ATTACHMENT_ID}/content`);
    expect(raw?.getAttribute("target")).toBe("_blank");
    expect(download?.getAttribute("href")).toBe(`/api/attachments/${ATTACHMENT_ID}/content?download=1`);
  });

  it("expands into the existing document surface without a server call when the document exists", async () => {
    mockUseIssueDocuments.mockReturnValue({ data: [makeReviewDocument()] });
    await renderTab();

    // The proxy document maps onto the work-product row instead of a
    // standalone Documents row.
    expect(container.textContent).not.toContain("Documents");
    expect(container.querySelector(`[data-testid="annotation-count-${REVIEW_KEY}"]`)).not.toBeNull();

    await act(async () => expandButton().click());
    expect(
      container.querySelector(`[data-testid="annotation-surface-${REVIEW_KEY}"]`)?.getAttribute("data-document-id"),
    ).toBe("document-1");
    expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toContain("Rendered body");
    expect(mockIssuesApi.ensureWorkProductReviewDocument).not.toHaveBeenCalled();
  });

  it("materializes the document on first expand", async () => {
    mockIssuesApi.ensureWorkProductReviewDocument.mockResolvedValue(makeReviewDocument());
    await renderTab();

    await act(async () => expandButton().click());
    expect(container.textContent).toContain("Preparing preview…");
    await waitForAssertion(() => {
      expect(mockIssuesApi.ensureWorkProductReviewDocument).toHaveBeenCalledWith("issue-1", WORK_PRODUCT_ID);
    });
    expect(mockIssuesApi.ensureWorkProductReviewDocument).toHaveBeenCalledTimes(1);
  });

  it("shows an unsupported state without retry for typed rejections", async () => {
    mockIssuesApi.ensureWorkProductReviewDocument.mockRejectedValue(
      new ApiError("Work product attachment is not Markdown", 415, {}),
    );
    await renderTab();

    await act(async () => expandButton().click());
    await waitForAssertion(() => {
      expect(container.textContent).toContain("can't be previewed as Markdown");
    });
    expect(container.textContent).not.toContain("Retry");
  });

  it("offers an explicit retry for recoverable errors", async () => {
    mockIssuesApi.ensureWorkProductReviewDocument.mockRejectedValue(
      new ApiError("Internal error", 500, {}),
    );
    await renderTab();

    await act(async () => expandButton().click());
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Preview failed to load.");
    });

    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await act(async () => retry?.click());
    await waitForAssertion(() => {
      expect(mockIssuesApi.ensureWorkProductReviewDocument).toHaveBeenCalledTimes(2);
    });
  });

  it("marks oversized markdown as too large without calling the server", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([
      makeMarkdownWorkProduct({
        metadata: {
          ...(makeMarkdownWorkProduct().metadata as Record<string, unknown>),
          byteSize: 512 * 1024 + 1,
        },
      }),
    ]);
    await renderTab();

    await act(async () => expandButton().click());
    expect(container.textContent).toContain("too large to preview");
    expect(mockIssuesApi.ensureWorkProductReviewDocument).not.toHaveBeenCalled();
  });

  it("expands from a document deep link and requests materialization", async () => {
    mockIssuesApi.ensureWorkProductReviewDocument.mockResolvedValue(makeReviewDocument());
    await renderTab({ documentDeepLink: { documentKey: REVIEW_KEY, requestId: 1 } });

    await waitForAssertion(() => {
      expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
      expect(mockIssuesApi.ensureWorkProductReviewDocument).toHaveBeenCalledTimes(1);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    });
  });

  it("hides the promoted markdown attachment from Files but keeps loose attachments", async () => {
    const loose = {
      ...makeMarkdownAttachment(),
      id: "22222222-2222-4222-8222-222222222222",
      originalFilename: "loose-notes.md",
      contentPath: "/api/attachments/22222222-2222-4222-8222-222222222222/content",
    };
    mockIssuesApi.listAttachments.mockResolvedValue([makeMarkdownAttachment(), loose]);
    await renderTab();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("loose-notes.md");
    });
    expect(container.textContent).not.toContain("report.md");
    const looseLink = Array.from(container.querySelectorAll("a")).find(
      (anchor) => anchor.textContent?.includes("loose-notes.md"),
    );
    expect(looseLink?.getAttribute("href")).toBe("/api/attachments/22222222-2222-4222-8222-222222222222/content");
  });

  it("keeps non-markdown work products on the raw link row", async () => {
    const contentPath = `/api/attachments/${ATTACHMENT_ID}/content`;
    mockIssuesApi.listWorkProducts.mockResolvedValue([
      makeMarkdownWorkProduct({
        metadata: {
          attachmentId: ATTACHMENT_ID,
          contentType: "application/pdf",
          byteSize: 64,
          contentPath,
          openPath: contentPath,
          downloadPath: `${contentPath}?download=1`,
          originalFilename: "report.pdf",
        },
      }),
    ]);
    await renderTab();

    await waitForAssertion(() => {
      const row = Array.from(container.querySelectorAll("a")).find(
        (anchor) => anchor.textContent?.includes("Verification report"),
      );
      expect(row?.getAttribute("href")).toBe(contentPath);
      expect(row?.getAttribute("target")).toBe("_blank");
    });
    expect(container.querySelector("button[aria-expanded]")).toBeNull();
  });
});
