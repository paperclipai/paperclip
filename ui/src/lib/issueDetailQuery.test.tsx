import type { Issue } from "@paperclipai/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { fetchIssueDetail } from "./issueDetailCache";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    getView: vi.fn(),
  },
}));

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

describe("getIssueDetailQueryOptions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("treats cached issue data as placeholder and still fetches full detail", async () => {
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
    vi.mocked(issuesApi.getView).mockResolvedValue({
      detail: fullIssue,
      comments: [],
      interactions: [],
      attachments: [],
      workProducts: [],
      childIssues: [],
      runs: [],
      liveRuns: [],
      activeRun: null,
    });

    const result = await fetchIssueDetail(queryClient, "PAP-1442", { signal: new AbortController().signal });

    expect(issuesApi.getView).toHaveBeenCalledWith("PAP-1442", {
      signal: expect.any(AbortSignal),
    });
    expect(result.description).toBe("GitHub Security Advisory body");
    expect(queryClient.getQueryData(queryKeys.issues.comments("issue-1"))).toEqual({
      pages: [[]],
      pageParams: [null],
    });

    queryClient.clear();
  });

  it("preserves same-millisecond socket updates received while the aggregate view is loading", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T20:00:00.000Z"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const issue = makeIssue();
    let resolveView!: (view: Awaited<ReturnType<typeof issuesApi.getView>>) => void;
    vi.mocked(issuesApi.getView).mockReturnValue(new Promise((resolve) => {
      resolveView = resolve;
    }));

    const pending = fetchIssueDetail(queryClient, "PAP-1442", { signal: new AbortController().signal });
    queryClient.setQueryData(
      queryKeys.issues.detail("PAP-1442"),
      makeIssue({ executionRunId: "socket-run" }),
    );
    queryClient.setQueryData(queryKeys.issues.interactions("PAP-1442"), [{ id: "socket-update" }]);
    resolveView({
      detail: issue,
      comments: [],
      interactions: [{ id: "aggregate-snapshot" }],
      attachments: [],
      workProducts: [],
      childIssues: [],
      runs: [],
      liveRuns: [],
      activeRun: null,
    } as unknown as Awaited<ReturnType<typeof issuesApi.getView>>);

    await pending;

    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail("PAP-1442"))?.executionRunId).toBe("socket-run");
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail("issue-1"))?.executionRunId).toBe("socket-run");
    expect(queryClient.getQueryData(queryKeys.issues.interactions("PAP-1442"))).toEqual([
      { id: "socket-update" },
    ]);
    queryClient.clear();
  });
});
