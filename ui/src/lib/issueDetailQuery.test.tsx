// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { getIssueDetailQueryOptions, seedIssueDetailProjections } from "./issueDetailCache";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    getCore: vi.fn(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date("2026-04-13T20:00:00.000Z");
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1442,
    identifier: "PAP-1442",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function IssueDetailQueryHarness({
  issueRef,
  placeholderIssue,
}: {
  issueRef: string;
  placeholderIssue?: Pick<Issue, "id" | "identifier"> | null;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issueRef, { placeholderIssue }),
  });

  return <div>{query.data?.description ?? "EMPTY"}</div>;
}

function IssueCoreQueryHarness({ issueRef }: { issueRef: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...queryKeys.issues.detail(issueRef), "core"],
    queryFn: async ({ signal }) => {
      const core = await issuesApi.getCore(issueRef, { signal });
      seedIssueDetailProjections(queryClient, core, issueRef);
      return core;
    },
  });
  return <div>{query.data?.title ?? "EMPTY"} / {query.data?.companyId ?? "UNKNOWN"} / {query.fetchStatus}</div>;
}

async function flush() {
  // Multiple act cycles to allow React Query to process the async queryFn
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("getIssueDetailQueryOptions", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("retains authenticated task metadata across UUID-to-identifier navigation while canonical core refresh is pending", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const issue = makeIssue({ id: "c1267799-90d5-4cb3-8311-38bd480dd76e", title: "Organization-bound task link", companyId: "owning-company" });
    let release!: (value: Issue) => void;
    const canonical = new Promise<Issue>((resolve) => { release = resolve; });
    vi.mocked(issuesApi.getCore).mockImplementation(async (ref) => ref === issue.id ? issue : canonical);
    const render = async (ref: string) => {
      await act(async () => root.render(<QueryClientProvider client={queryClient}><IssueCoreQueryHarness issueRef={ref} /></QueryClientProvider>));
      await flush();
    };
    try {
      await render(issue.id);
      expect(container.textContent).toContain(issue.title);
      await render(issue.identifier!);
      expect(issuesApi.getCore).toHaveBeenCalledWith(issue.identifier, { signal: expect.any(AbortSignal) });
      expect(container.textContent).toContain(issue.title);
      expect(container.textContent).toContain("owning-company");
      expect(container.textContent).toContain("fetching");
      expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toBeUndefined();
      expect(queryClient.getQueryData([...queryKeys.issues.detail("unrelated-task"), "core"])).toBeUndefined();
    } finally {
      release(issue);
      await act(async () => root.unmount());
      queryClient.clear();
      container.remove();
    }
  });

  it("does not replace an existing canonical core receipt or fill full-detail keys", () => {
    const queryClient = new QueryClient();
    const issue = makeIssue();
    const newer = makeIssue({ title: "Newer saved title", updatedAt: new Date("2026-11-04T00:00:00Z") });
    const key = [...queryKeys.issues.detail(issue.identifier!), "core"];
    queryClient.setQueryData(key, newer);
    seedIssueDetailProjections(queryClient, issue, "unrelated-task");
    expect(queryClient.getQueryData(key)).toBe(newer);
    expect(queryClient.getQueryData([...queryKeys.issues.detail(issue.id), "core"])).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.id))).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toBeUndefined();
    expect(queryClient.getQueryData([...queryKeys.issues.detail("unrelated-task"), "core"])).toBeUndefined();
    queryClient.clear();
  });

  it("treats cached issue data as placeholder and still fetches full detail", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const partialIssue = makeIssue({ description: null });
    const fullIssue = makeIssue({ description: "GitHub Security Advisory body" });

    queryClient.setQueryData(queryKeys.issues.detail("issue-1"), partialIssue);
    queryClient.setQueryData(queryKeys.issues.detail("PAP-1442"), partialIssue);
    vi.mocked(issuesApi.get).mockResolvedValue(fullIssue);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetailQueryHarness
            issueRef="PAP-1442"
            placeholderIssue={{ id: partialIssue.id, identifier: partialIssue.identifier }}
          />
        </QueryClientProvider>,
      );
    });

    await flush();

    expect(issuesApi.get).toHaveBeenCalledWith("PAP-1442", {
      signal: expect.any(AbortSignal),
    });
    expect(container.textContent).toContain("GitHub Security Advisory body");

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
  });
});
