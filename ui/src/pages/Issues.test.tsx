// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Issues } from "./Issues";

const DEFAULT_ACTIVE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
  archiveClosed: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const issuesListPropsState = vi.hoisted(() => ({
  latest: null as Record<string, unknown> | null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: Record<string, unknown>) => {
    issuesListPropsState.latest = props;
    return <div>Issues list</div>;
  },
}));

vi.mock("../lib/router", () => ({
  Navigate: ({ to }: { to: string }) => <div>Navigate:{to}</div>,
  useLocation: () => ({ pathname: "/issues", search: "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(""), vi.fn()],
}));

vi.mock("../lib/issueDetailBreadcrumb", () => ({
  createIssueDetailLocationState: () => ({ from: "issues" }),
  createIssueDetailPath: (identifier: string) => `/issues/${identifier}`,
  readLegacyIssueDetailIdentifier: () => null,
}));

vi.mock("../lib/issue-update-errors", () => ({
  describeIssueUpdateError: () => ({ title: "Update failed", body: "Update failed." }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
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

function renderIssuesPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Issues />
      </QueryClientProvider>,
    );
  });

  return { root, queryClient };
}

describe("Issues page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    breadcrumbsState.setBreadcrumbs.mockReset();
    toastState.pushToast.mockReset();
    mockIssuesApi.list.mockReset();
    mockIssuesApi.update.mockReset();
    mockIssuesApi.archiveClosed.mockReset();
    mockAgentsApi.list.mockReset();
    mockProjectsApi.list.mockReset();
    mockHeartbeatsApi.liveRunsForCompany.mockReset();
    issuesListPropsState.latest = null;

    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("configures the main issues list to hide terminal statuses by default without prefiltering API data", async () => {
    const { root } = renderIssuesPage(container);

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({
          includeRelations: true,
          excludeRecoverySourcesWithOpenSuccessors: true,
        }),
      );
      const firstCall = mockIssuesApi.list.mock.calls[0]?.[1];
      expect(firstCall).not.toHaveProperty("status");
      expect(issuesListPropsState.latest).toMatchObject({
        defaultStatuses: DEFAULT_ACTIVE_STATUSES,
        excludeRecoverySourcesWithOpenSuccessors: true,
      });
    });

    act(() => {
      root.unmount();
    });
  });
});
