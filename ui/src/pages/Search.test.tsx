// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Search, buildSearchUrl } from "./Search";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({
  openNewIssue: vi.fn(),
}));

const navigateMock = vi.hoisted(() => vi.fn());

const searchApiMock = vi.hoisted(() => ({
  search: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("../api/search", () => ({
  searchApi: searchApiMock,
}));

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("../api/projects", () => ({
  projectsApi: projectsApiMock,
}));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status }: { status: string }) => <span data-status={status} />,
}));

vi.mock("../components/StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span data-status-badge={status}>{status}</span>,
}));

vi.mock("../components/Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
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

function renderSearch(initialPath: string, container: HTMLDivElement, node?: ReactNode) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/search" element={node ?? <Search />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("buildSearchUrl", () => {
  it("writes q and scope when provided", () => {
    expect(buildSearchUrl("http://x/search", "auth flake", "comments")).toBe(
      "/search?q=auth+flake&scope=comments",
    );
  });

  it("clears q when empty and omits scope when scope=all", () => {
    expect(buildSearchUrl("http://x/search?q=stale&scope=issues", "", "all")).toBe("/search");
  });

  it("preserves the existing pathname and hash", () => {
    expect(buildSearchUrl("http://x/PAP/search?q=x#anchor", "y", "issues")).toBe(
      "/PAP/search?q=y&scope=issues#anchor",
    );
  });
});

describe("Search page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    dialogState.openNewIssue.mockReset();
    navigateMock.mockReset();
    searchApiMock.search.mockReset();
    agentsApiMock.list.mockReset();
    projectsApiMock.list.mockReset();
    agentsApiMock.list.mockResolvedValue([]);
    projectsApiMock.list.mockResolvedValue([]);
    window.localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("issues a search request when ?q is in the URL and renders the result", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "auth flake",
      normalizedQuery: "auth flake",
      scope: "all",
      limit: 20,
      offset: 0,
      countsByType: { issue: 1, agent: 0, project: 0 },
      hasMore: false,
      results: [
        {
          id: "issue-1",
          type: "issue",
          score: 100,
          title: "PAP-3142 Auth middleware flakes",
          href: "/PAP/issues/PAP-3142",
          matchedFields: ["title", "comment"],
          sourceLabel: "Comment",
          snippet: "we hit another flake",
          snippets: [
            {
              field: "title",
              label: "Title",
              text: "Auth middleware flakes",
              highlights: [{ start: 0, end: 4 }],
            },
            {
              field: "comment",
              label: "Comment",
              text: "we hit another flake in the morning batch",
              highlights: [{ start: 16, end: 21 }],
            },
          ],
          issue: {
            id: "issue-1",
            identifier: "PAP-3142",
            title: "Auth middleware flakes",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const { root } = renderSearch("/search?q=auth+flake", container);

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("company-1", {
        q: "auth flake",
        scope: "all",
        limit: 20,
      });
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-3142");
      expect(container.textContent).toContain("Auth middleware flakes");
      expect(container.textContent).toContain("1 result");
    });

    act(() => {
      root.unmount();
    });
  });

  it("debounces typing into the input and dispatches a search after the debounce window", async () => {
    searchApiMock.search.mockResolvedValue({
      query: "deflake",
      normalizedQuery: "deflake",
      scope: "all",
      limit: 20,
      offset: 0,
      countsByType: { issue: 0, agent: 0, project: 0 },
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch("/search", container);

    const input = container.querySelector('input[aria-label="Search query"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    act(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "deflake");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The debounce hasn't fired yet, so no API call should be made synchronously.
    expect(searchApiMock.search).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 350));

    await waitForAssertion(() => {
      expect(searchApiMock.search).toHaveBeenCalledWith("company-1", {
        q: "deflake",
        scope: "all",
        limit: 20,
      });
    });

    act(() => {
      root.unmount();
    });
  });

  it("auto-redirects an exact identifier match to the issue root, dropping any deep-link suffix", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "PAP-3366",
      normalizedQuery: "pap-3366",
      scope: "all",
      limit: 20,
      offset: 0,
      countsByType: { issue: 1, agent: 0, project: 0 },
      hasMore: false,
      results: [
        {
          id: "issue-3366",
          type: "issue",
          score: 1300,
          title: "PAP-3366 Continuation summary",
          href: "/PAP/issues/PAP-3366#document-continuation-summary",
          matchedFields: ["identifier", "document"],
          sourceLabel: "Document",
          snippet: "Continuation summary excerpt",
          snippets: [
            {
              field: "document",
              label: "Continuation summary",
              text: "Continuation summary excerpt",
              highlights: [],
            },
          ],
          issue: {
            id: "issue-3366",
            identifier: "PAP-3366",
            title: "Continuation summary",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
            projectId: null,
            updatedAt: new Date().toISOString(),
          },
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const { root } = renderSearch("/search?q=PAP-3366", container);

    await waitForAssertion(() => {
      expect(navigateMock).toHaveBeenCalledWith("/PAP/issues/PAP-3366", { replace: true });
    });

    act(() => {
      root.unmount();
    });
  });

  it("renders the no-results state with a Search-all action when scope is non-default", async () => {
    searchApiMock.search.mockResolvedValueOnce({
      query: "ghost",
      normalizedQuery: "ghost",
      scope: "comments",
      limit: 20,
      offset: 0,
      countsByType: { issue: 0, agent: 0, project: 0 },
      hasMore: false,
      results: [],
    });

    const { root } = renderSearch("/search?q=ghost&scope=comments", container);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("No results for");
      expect(container.textContent).toContain("ghost");
      expect(container.textContent).toContain("Search all scopes");
    });

    act(() => {
      root.unmount();
    });
  });
});
