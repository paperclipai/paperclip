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
const mockCasesApi = vi.hoisted(() => ({ get: vi.fn(), listEvents: vi.fn(), list: vi.fn(), patch: vi.fn() }));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn(), createLabel: vi.fn() }));
const panelState = vi.hoisted(() => ({ openPanel: vi.fn(), closePanel: vi.fn() }));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => panelState }));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ caseIdentifier: "PAP-C7" }),
  Navigate: () => null,
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
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
    fields: { slug: "hermes-agent-post", word_count: 1850, published: true },
    parent: null,
    parentCaseId: null,
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    labels: [],
    issueLinks: [],
    documents: [
      {
        key: "body",
        document: {
          id: "doc-1",
          title: "body",
          format: "markdown",
          latestBody: "# Draft body\n\nSome content.",
          latestRevisionId: "rev-8",
          latestRevisionNumber: 8,
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
    mockCasesApi.get.mockReset().mockResolvedValue(detail());
    mockCasesApi.listEvents.mockReset().mockResolvedValue([]);
    mockCasesApi.list.mockReset().mockResolvedValue([]);
    mockIssuesApi.listLabels.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    container.remove();
  });

  it("renders the case header, generic fields, and body document", async () => {
    const root = renderPage(container);

    await waitForAssertion(() => {
      // header
      expect(container.textContent).toContain("PAP-C7");
      expect(container.textContent).toContain("blog_post");
      expect(container.textContent).toContain("Hermes agent launch post");
      // upsert key (detail-only)
      expect(container.textContent).toContain("v2026.707/hermes-agent-post");
      // generic fields rendered
      expect(container.textContent).toContain("hermes-agent-post");
      expect(container.textContent).toContain("1,850");
      // body document card
      expect(container.textContent).toContain("Draft body");
      expect(container.textContent).toContain("rev 8");
    });

    act(() => root.unmount());
  });
});
