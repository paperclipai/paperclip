// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, CompanyDocumentSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Documents } from "./Documents";

const mockDocumentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

// A mutable search-params store so tests can seed the URL state and observe writes.
const searchStore = vi.hoisted(() => ({ value: "" }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => {
    const params = new URLSearchParams(searchStore.value);
    const setParams = (
      next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams),
    ) => {
      const resolved =
        typeof next === "function"
          ? next(new URLSearchParams(searchStore.value))
          : new URLSearchParams(next as Record<string, string>);
      searchStore.value = resolved.toString();
    };
    return [params, setParams];
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/documents", () => ({
  documentsApi: mockDocumentsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeDocument(overrides: Partial<CompanyDocumentSummary>): CompanyDocumentSummary {
  return {
    id: "doc-1",
    companyId: "company-1",
    title: "Paperclip Documents review flow",
    format: "markdown",
    status: "in_review",
    documentType: "spec",
    summary: "How review works",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    latestRevisionId: "rev-1",
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
    backlinks: [],
    feedbackCounts: {
      openComments: 3,
      resolvedComments: 0,
      openReviewThreads: 0,
      resolvedReviewThreads: 0,
      pendingSuggestions: 2,
      acceptedSuggestions: 0,
      rejectedSuggestions: 0,
      staleAnchors: 0,
      orphanedAnchors: 0,
    },
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "ClaudeCoder",
    urlKey: "claudecoder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("Documents library", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    searchStore.value = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockAgentsApi.list.mockResolvedValue([makeAgent({})]);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    await act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Documents />
        </QueryClientProvider>,
      );
    });
    // Allow react-query microtasks to flush.
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("renders a row per document with title and feedback counts", async () => {
    mockDocumentsApi.list.mockResolvedValue([
      makeDocument({ id: "doc-1", title: "Review flow spec" }),
      makeDocument({ id: "doc-2", title: "Onboarding plan", documentType: "plan", status: "draft" }),
    ]);

    await render();

    expect(container.textContent).toContain("Review flow spec");
    expect(container.textContent).toContain("Onboarding plan");
    // Feedback counts (3 open comments, 2 pending suggestions) are surfaced.
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("2");
    expect(mockDocumentsApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ limit: 100 }));
  });

  it("shows the empty state when there are no documents and no filters", async () => {
    mockDocumentsApi.list.mockResolvedValue([]);

    await render();

    expect(container.textContent).toContain("No documents yet");
  });

  it("renders an active filter chip and the filtered empty state when a status filter is set", async () => {
    searchStore.value = "status=approved";
    mockDocumentsApi.list.mockResolvedValue([]);

    await render();

    expect(container.textContent).toContain("Status: Approved");
    expect(container.textContent).toContain("No documents match these filters");
  });

  it("passes the status filter through to the API query", async () => {
    searchStore.value = "status=in_review";
    mockDocumentsApi.list.mockResolvedValue([makeDocument({})]);

    await render();

    expect(mockDocumentsApi.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ status: ["in_review"] }),
    );
  });
});
