// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail as CaseDetailData } from "@/api/cases";
import { CaseDetail } from "./CaseDetail";

function act(callback: () => void) {
  flushSync(callback);
}

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const mockCasesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listEvents: vi.fn(),
  list: vi.fn(),
  patch: vi.fn(),
  getDocument: vi.fn(),
  listRevisions: vi.fn(),
  upsertDocument: vi.fn(),
  lockDocument: vi.fn(),
  unlockDocument: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  deleteDocument: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn(), createLabel: vi.fn() }));
const panelState = vi.hoisted(() => ({ openPanel: vi.fn(), closePanel: vi.fn() }));
const mockCopyTextToClipboard = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => panelState }));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mockCopyTextToClipboard }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
vi.mock("@/components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: ({ subject }: { subject?: { id: string } }) => (
    <div data-testid="case-documents-section">Documents {subject?.id}</div>
  ),
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ caseIdentifier: "PAP-C7" }),
  useLocation: () => ({ hash: "" }),
  Navigate: () => null,
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}
async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      assertion();
      return;
    } catch (e) {
      lastError = e;
      await flush();
    }
  }
  throw lastError;
}

function detail(): CaseDetailData {
  return {
    id: "case-1",
    companyId: "company-1",
    projectId: null,
    caseNumber: 7,
    identifier: "PAP-C7",
    caseType: "blog_post",
    key: "v2026.707/hermes-agent-post",
    title: "Hermes agent launch post",
    summary: null,
    status: "in_review",
    fields: {
      slug: "hermes-agent-post",
      body: "Legacy body field",
      runbook: "Legacy runbook field",
      word_count: 1850,
      published: true,
      description: "Launch narrative",
      issue_identifiers: ["PAP-12947"],
    },
    parent: null,
    parentCaseId: null,
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    labels: [],
    issueLinks: [
      {
        id: "link-1",
        caseId: "case-1",
        issueId: "issue-1",
        role: "reference",
        createdAt: "2026-07-07T00:00:00.000Z",
        issue: {
          id: "issue-1",
          identifier: "PAP-12947",
          title: "Case object exploration",
          status: "in_progress",
        },
      },
    ],
    documents: [
      {
        key: "body",
        document: {
          id: "doc-1",
          companyId: "company-1",
          title: "body",
          format: "markdown",
          latestBody: "# Draft body\n\nSome content.",
          latestRevisionId: "rev-8",
          latestRevisionNumber: 8,
          createdByAgentId: null,
          createdByUserId: null,
          updatedByAgentId: "agent-1",
          updatedByUserId: null,
          lockedAt: null,
          lockedByAgentId: null,
          lockedByUserId: null,
          createdAt: "2026-07-07T00:00:00.000Z",
          updatedAt: "2026-07-07T00:00:00.000Z",
        },
      },
      {
        key: "runbook",
        document: {
          id: "doc-2",
          companyId: "company-1",
          title: "runbook",
          format: "markdown",
          latestBody: "# Runbook\n\nSteps.",
          latestRevisionId: "rev-2",
          latestRevisionNumber: 2,
          createdByAgentId: null,
          createdByUserId: null,
          updatedByAgentId: "agent-1",
          updatedByUserId: null,
          lockedAt: null,
          lockedByAgentId: null,
          lockedByUserId: null,
          createdAt: "2026-07-07T00:00:00.000Z",
          updatedAt: "2026-07-07T00:00:00.000Z",
        },
      },
    ],
    attachments: [],
  };
}

function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CaseDetail />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("CaseDetail", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    panelState.openPanel.mockClear();
    panelState.closePanel.mockClear();
    mockCasesApi.get.mockReset().mockResolvedValue(detail());
    mockCasesApi.listEvents.mockReset().mockResolvedValue([]);
    mockCasesApi.list.mockReset().mockResolvedValue([]);
    mockCasesApi.getDocument.mockReset();
    mockCasesApi.listRevisions.mockReset().mockResolvedValue({
      key: "body",
      document: {
        id: "doc-1",
        title: "body",
        format: "markdown",
        latestRevisionId: "rev-8",
        latestRevisionNumber: 8,
      },
      revisions: [],
    });
    mockCasesApi.upsertDocument.mockReset();
    mockCasesApi.lockDocument.mockReset();
    mockCasesApi.unlockDocument.mockReset();
    mockCasesApi.restoreDocumentRevision.mockReset();
    mockCasesApi.deleteDocument.mockReset();
    mockIssuesApi.listLabels.mockReset().mockResolvedValue([]);
    mockCopyTextToClipboard.mockClear();
  });
  afterEach(() => {
    container.remove();
  });

  it("renders the case header and body-first overview without duplicating generic fields", async () => {
    const root = renderPage(container);

    await waitForAssertion(() => {
      // header
      expect(container.textContent).toContain("PAP-C7");
      expect(container.textContent).toContain("blog_post");
      expect(container.textContent).toContain("Hermes agent launch post");
      // upsert key (detail-only)
      expect(container.textContent).toContain("v2026.707/hermes-agent-post");
      // shared document section
      expect(container.textContent).toContain("Documents case-1");
      expect(container.textContent).toContain("Launch narrative");
      expect(container.textContent).not.toContain("Revisions");
      expect(container.textContent).not.toContain("1,850");
    });

    act(() => root.unmount());
  });

  it("copies the case identifier from the header", async () => {
    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-C7");
    });

    const caseIdButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent === "PAP-C7"
    );
    expect(caseIdButton).toBeTruthy();
    act(() => {
      caseIdButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockCopyTextToClipboard).toHaveBeenCalledWith("PAP-C7");
    });

    act(() => root.unmount());
  });

  it("renders primary fields and task references in the compact properties panel", async () => {
    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(panelState.openPanel).toHaveBeenCalled();
    });

    const panelContainer = document.createElement("div");
    document.body.appendChild(panelContainer);
    const panelRoot = createRoot(panelContainer);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      panelRoot.render(
        <QueryClientProvider client={queryClient}>
          {panelState.openPanel.mock.calls.at(-1)?.[0]}
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      const text = panelContainer.textContent ?? "";
      expect(text).toContain("Fields");
      expect(text).toContain("title");
      expect(text).toContain("Hermes agent launch post");
      expect(text).toContain("description");
      expect(text).toContain("Launch narrative");
      expect(text).toContain("word_count");
      expect(text).toContain("Linked tasks");
      expect(text).toContain("PAP-12947");
      expect(text).not.toContain("body");
      expect(text).not.toContain("Legacy body field");
      expect(text).not.toContain("runbook");
      expect(text).not.toContain("Legacy runbook field");
      expect(text).not.toContain("Documents");
      expect(text).not.toContain("reference");
      expect(text).not.toContain("Activity");
    });

    act(() => panelRoot.unmount());
    panelContainer.remove();
    act(() => root.unmount());
  });

  it("adds a full properties tab with expanded values", async () => {
    const root = renderPage(container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Properties");
    });

    const propertiesTab = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Properties")
    );
    expect(propertiesTab).toBeTruthy();
    act(() => {
      propertiesTab!.focus();
      propertiesTab!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await waitForAssertion(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("title");
      expect(text).toContain("Hermes agent launch post");
      expect(text).toContain("issue_identifiers");
      expect(container.querySelector('a[data-mention-kind="issue"][href="/issues/PAP-12947"]')).not.toBeNull();
      expect(text).not.toContain("body");
      expect(text).not.toContain("Legacy body field");
      expect(text).not.toContain("runbook");
      expect(text).not.toContain("Legacy runbook field");
    });

    act(() => root.unmount());
  });
});
