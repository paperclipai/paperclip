// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyDocument } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { DocumentDetail } from "./DocumentDetail";

const mocks = vi.hoisted(() => ({
  documentsApi: { get: vi.fn() },
  documentReviewsApi: { reviewIndex: vi.fn() },
  documentAnnotationsApi: {},
  issuesApi: {},
  agentsApi: { list: vi.fn() },
  accessApi: { listUserDirectory: vi.fn() },
  authApi: { getSession: vi.fn() },
  setBreadcrumbs: vi.fn(),
  params: { value: { documentId: "doc-1" } as { documentId?: string } },
}));

vi.mock("react-router-dom", () => ({
  useParams: () => mocks.params.value,
  useSearchParams: () => [new URLSearchParams(), () => {}],
}));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.setBreadcrumbs }) }));
vi.mock("@/api/documents", () => ({ documentsApi: mocks.documentsApi }));
vi.mock("@/api/document-reviews", () => ({ documentReviewsApi: mocks.documentReviewsApi }));
vi.mock("@/api/document-annotations", () => ({ documentAnnotationsApi: mocks.documentAnnotationsApi }));
vi.mock("@/api/issues", () => ({ issuesApi: mocks.issuesApi }));
vi.mock("@/api/agents", () => ({ agentsApi: mocks.agentsApi }));
vi.mock("@/api/access", () => ({ accessApi: mocks.accessApi }));
vi.mock("@/api/auth", () => ({ authApi: mocks.authApi }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/MarkdownEditor", () => ({ MarkdownEditor: () => <textarea data-testid="md-editor" /> }));
vi.mock("@/components/DocumentAnnotationLayer", () => ({ DocumentAnnotationLayer: () => null }));
vi.mock("@/components/DocumentDiffModal", () => ({ DocumentDiffModal: () => null }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return;
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function makeDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: "doc-1",
    companyId: "company-1",
    title: "Paperclip Documents review flow",
    format: "markdown",
    status: "in_review",
    documentType: "spec",
    summary: null,
    ownerAgentId: "agent-1",
    ownerUserId: null,
    latestRevisionId: "rev-12",
    latestRevisionNumber: 12,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    sourceTrust: null,
    archivedAt: null,
    archivedByAgentId: null,
    archivedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-06T00:00:00Z"),
    backlinks: [
      {
        id: "link-1",
        companyId: "company-1",
        documentId: "doc-1",
        targetType: "issue",
        targetId: "issue-1",
        relationship: "source",
        issueDocumentId: "idoc-1",
        issueDocumentKey: "spec",
        title: "Design Paperclip Documents UX",
        identifier: "PAP-10520",
        createdAt: new Date("2026-06-01T00:00:00Z"),
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      },
    ],
    feedbackCounts: {
      openComments: 1,
      resolvedComments: 0,
      openReviewThreads: 0,
      resolvedReviewThreads: 0,
      pendingSuggestions: 0,
      acceptedSuggestions: 0,
      rejectedSuggestions: 0,
      staleAnchors: 0,
      orphanedAnchors: 0,
    },
    body: "# Heading\n\nBody text here.",
    ...overrides,
  };
}

const emptyIndex = {
  issueId: "issue-1",
  documentId: "doc-1",
  documentKey: "spec",
  latestRevisionId: "rev-12",
  latestRevisionNumber: 12,
  counts: {
    unresolved: 0,
    openAnchoredThreads: 0,
    openReviewThreads: 0,
    pendingSuggestions: 0,
    resolvedAnchoredThreads: 0,
    resolvedReviewThreads: 0,
    acceptedSuggestions: 0,
    rejectedSuggestions: 0,
    resolvedSuggestions: 0,
    staleAnchors: 0,
    orphanedAnchors: 0,
  },
  annotationThreads: [],
  reviewThreads: [],
  suggestions: [],
};

let container: HTMLDivElement;
let root: Root;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <DocumentDetail />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.params.value = { documentId: "doc-1" };
  mocks.agentsApi.list.mockResolvedValue([{ id: "agent-1", name: "ClaudeCoder" }]);
  mocks.accessApi.listUserDirectory.mockResolvedValue({ users: [] });
  mocks.authApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
  mocks.documentReviewsApi.reviewIndex.mockResolvedValue(emptyIndex);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("DocumentDetail", () => {
  it("shows a permission-denied state without leaking the title", async () => {
    mocks.documentsApi.get.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderPage();
    await waitFor(() => container.textContent?.includes("don't have access") ?? false, "permission denied");
    expect(container.textContent).toContain("You don't have access to this document.");
    expect(container.textContent).not.toContain("Paperclip Documents review flow");
  });

  it("renders the header, body, and review rail for a board user", async () => {
    mocks.documentsApi.get.mockResolvedValue(makeDoc());
    await renderPage();
    await waitFor(() => container.textContent?.includes("Paperclip Documents review flow") ?? false, "title");
    // Header pieces
    expect(container.textContent).toContain("Spec");
    expect(container.textContent).toContain("Rev 12");
    expect(container.querySelector('[data-testid="action-edit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="action-history"]')).not.toBeNull();
    // Backlink chip
    expect(container.textContent).toContain("PAP-10520");
    // Body
    expect(container.textContent).toContain("Body text here.");
    // Rail
    expect(container.querySelector('[data-testid="document-review-rail"]')).not.toBeNull();
  });

  it("treats signed-out viewers as read-only", async () => {
    mocks.authApi.getSession.mockResolvedValue(null);
    mocks.documentsApi.get.mockResolvedValue(makeDoc());
    await renderPage();
    await waitFor(() => container.textContent?.includes("Paperclip Documents review flow") ?? false, "title");
    expect(container.querySelector('[data-testid="readonly-badge"]')).not.toBeNull();
    const edit = container.querySelector<HTMLButtonElement>('[data-testid="action-edit"]');
    expect(edit?.disabled).toBe(true);
  });

  it("surfaces a review-access error instead of an empty 'no feedback' state on 403", async () => {
    mocks.documentsApi.get.mockResolvedValue(makeDoc());
    mocks.documentReviewsApi.reviewIndex.mockRejectedValue(new ApiError("Forbidden", 403, null));
    await renderPage();
    await waitFor(
      () => container.querySelector('[data-testid="rail-access-error"]') !== null,
      "review access error",
    );
    // References the parent issue so the user knows whom to ask.
    expect(container.textContent).toContain("don't have access to this document's review thread");
    expect(container.textContent).toContain("PAP-10520");
    // The misleading empty state and the Done-reviewing CTA must NOT render —
    // there are no stats to hand off when the thread can't be read.
    expect(container.querySelector('[data-testid="rail-empty"]')).toBeNull();
    expect(container.querySelector('[data-testid="rail-done-reviewing"]')).toBeNull();
  });

  it("shows a locked-by-other badge and disables Edit", async () => {
    mocks.documentsApi.get.mockResolvedValue(makeDoc({ lockedByAgentId: "agent-1", lockedAt: new Date() }));
    await renderPage();
    await waitFor(() => container.textContent?.includes("Paperclip Documents review flow") ?? false, "title");
    expect(container.querySelector('[data-testid="locked-by-other"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="action-edit"]')?.disabled).toBe(true);
  });
});
