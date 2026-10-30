// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueAttachment, IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import { IssuePropertiesArtifactsTab } from "./IssuePropertiesArtifactsTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockIssuesApi = vi.hoisted(() => ({
  listAttachments: vi.fn(async (): Promise<unknown[]> => []),
  listWorkProducts: vi.fn(async (_issueId: string, _options?: { refreshPullRequests?: boolean }): Promise<unknown[]> => []),
  ensureWorkProductReviewDocument: vi.fn(async (): Promise<unknown> => ({})),
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/api/activity", () => ({ activityApi: { runsForIssue: vi.fn(async (): Promise<unknown[]> => []) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(async (): Promise<unknown[]> => []) } }));
const mockUseIssueDocuments = vi.hoisted(() => vi.fn((): { data: IssueDocument[] } => ({ data: [] })));
vi.mock("@/hooks/useIssueDocuments", () => ({ useIssueDocuments: mockUseIssueDocuments }));
vi.mock("@/hooks/useArtifactsV1Enabled", () => ({ useArtifactsV1Enabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ hash: "" }),
}));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => <span data-testid={`annotation-count-${docKey}`} />,
  IssueDocumentAnnotations: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const issue = { id: "issue-1", companyId: "company-1", identifier: "ACM-3", workMode: "standard" } as Issue;
const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_ID = "00000000-0000-4000-8000-000000000002";

const pdfWorkProduct = {
  id: "wp-pdf",
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
  createdAt: new Date("2026-09-26T10:00:00Z"),
  updatedAt: new Date("2026-09-26T10:00:00Z"),
} as unknown as IssueWorkProduct;

const pullRequest = {
  ...pdfWorkProduct,
  id: "wp-pr",
  type: "pull_request",
  provider: "github",
  externalId: "42",
  title: "Ship rich work-product cards",
  url: "https://github.com/paperclipai/paperclip/pull/42",
  status: "merged",
  metadata: { repo: "paperclipai/paperclip", number: 42, state: "merged" },
  createdAt: new Date("2026-09-25T10:00:00Z"),
  updatedAt: new Date("2026-09-25T10:00:00Z"),
} as unknown as IssueWorkProduct;

const brokenService = {
  ...pdfWorkProduct,
  id: "wp-service",
  type: "runtime_service",
  provider: "paperclip",
  title: "Preview server",
  url: "https://preview.example.test",
  status: "active",
  healthStatus: "unhealthy",
  metadata: null,
  createdAt: new Date("2026-09-24T10:00:00Z"),
  updatedAt: new Date("2026-09-24T10:00:00Z"),
} as unknown as IssueWorkProduct;

const planDocument = {
  id: "doc-plan",
  companyId: "company-1",
  issueId: "issue-1",
  key: "plan",
  title: "acmehats branding strategy — proposed plan",
  format: "markdown",
  body: "## Goal\n\nA clear first brand direction.",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  updatedByAgentId: null,
  createdAt: new Date("2026-09-27T08:36:00Z"),
  updatedAt: new Date("2026-09-27T08:36:00Z"),
} as unknown as IssueDocument;

const heroAttachment = {
  id: IMAGE_ID,
  companyId: "company-1",
  issueId: "issue-1",
  issueCommentId: null,
  assetId: "asset-2",
  provider: "local",
  objectKey: "hero.png",
  contentType: "image/png",
  byteSize: 433050,
  originalFilename: "contact-sheet.png",
  createdByAgentId: null,
  createdByUserId: null,
  createdAt: new Date("2026-09-28T11:07:00Z"),
  updatedAt: new Date("2026-09-28T11:07:00Z"),
  contentPath: `/api/attachments/${IMAGE_ID}/content`,
} as unknown as IssueAttachment;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(flush);
    }
  }
  throw lastError;
}

describe("IssuePropertiesArtifactsTab with Artifacts V1 on", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockIssuesApi.listAttachments.mockResolvedValue([heroAttachment]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([pdfWorkProduct]);
    mockUseIssueDocuments.mockReturnValue({ data: [planDocument] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(props: { onOpenDocument?: (document: IssueDocument) => void } = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssuePropertiesArtifactsTab issue={issue} {...props} />
        </QueryClientProvider>,
      );
    });
  }

  it("lists every artifact as one flat set of V1 rows, newest first, with no run sections", async () => {
    render();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-row"]')).toHaveLength(3);
    });
    const names = Array.from(container.querySelectorAll('[data-testid="artifact-v1-row-open"]')).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["Open contact-sheet.png", "Open plan.md", "Open acmehats-interface-craft.pdf"]);
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector('[data-testid="artifacts-v1-list"]')).not.toBeNull();
  });

  it("shows a file's type and size, its picture when it has one, and keeps open and download beside the name", async () => {
    render();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-row"]')).toHaveLength(3);
    });
    const rows = container.querySelectorAll('[data-testid="artifact-v1-row"]');
    expect(rows[2].textContent).toContain("PDF");
    expect(rows[2].textContent).toContain("57.7 KB");
    expect(rows[2].textContent).toContain("For review");
    expect(rows[2].querySelector('a[aria-label="Download acmehats-interface-craft.pdf"]')?.getAttribute("href")).toContain("download=1");
    expect(rows[0].querySelector("img")?.getAttribute("src")).toBe(`/api/attachments/${IMAGE_ID}/content`);
  });

  it("opens other work products in a new tab and warns about an unhealthy service before anything else", async () => {
    mockIssuesApi.listWorkProducts.mockResolvedValue([pdfWorkProduct, pullRequest, brokenService]);
    render();
    await waitFor(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-row"]')).toHaveLength(5);
    });
    const pr = container.querySelector<HTMLAnchorElement>('a[aria-label="Open Ship rich work-product cards"]');
    expect(pr?.getAttribute("href")).toBe("https://github.com/paperclipai/paperclip/pull/42");
    expect(pr?.getAttribute("target")).toBe("_blank");
    const service = container.querySelector('a[aria-label="Open Preview server"]')?.closest('[data-testid="artifact-v1-row"]');
    expect(service?.textContent).toContain("Unhealthy");
    expect(service?.textContent).not.toContain("Running");
  });

  it("opens a task document the way the panel asks, through onOpenDocument", async () => {
    const onOpenDocument = vi.fn();
    render({ onOpenDocument });
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Open plan.md"]')).not.toBeNull();
    });
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Open plan.md"]')!.click());
    expect(onOpenDocument).toHaveBeenCalledWith(planDocument);
  });
});
