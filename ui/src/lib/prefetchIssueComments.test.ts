import { QueryClient } from "@tanstack/react-query";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { prefetchIssueComments, prefetchIssueDetailForNavigation } from "./issueDetailCache";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    listComments: vi.fn(),
  },
}));

function createComment(overrides: Partial<IssueComment> = {}): IssueComment {
  return {
    id: "comment-1",
    issueId: "issue-1",
    body: "hello",
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    ...overrides,
  } as IssueComment;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    parentId: null,
    title: "Fast link target",
    description: "A complete snapshot.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    executionRunId: null,
    issueNumber: 1,
    requestDepth: 0,
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  } as Issue;
}

describe("prefetchIssueComments", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
  });

  it("warms the first comments page under the infinite query key IssueDetail mounts", async () => {
    const firstPage = [createComment({ id: "c1" }), createComment({ id: "c2" })];
    vi.mocked(issuesApi.listComments).mockResolvedValue(firstPage);

    await prefetchIssueComments(queryClient, "PAP-1");

    expect(issuesApi.listComments).toHaveBeenCalledWith("PAP-1", { order: "desc", limit: 50 });
    const cached = queryClient.getQueryData<{ pages: IssueComment[][]; pageParams: unknown[] }>(
      queryKeys.issues.comments("PAP-1"),
    );
    expect(cached?.pages).toEqual([firstPage]);
    expect(cached?.pageParams).toEqual([null]);
  });

  it("does not refetch comments that are already fresh in cache", async () => {
    const firstPage = [createComment({ id: "c1" })];
    vi.mocked(issuesApi.listComments).mockResolvedValue(firstPage);

    await prefetchIssueComments(queryClient, "PAP-1");
    await prefetchIssueComments(queryClient, "PAP-1");

    // Second prefetch sees fresh data within staleTime and is a no-op.
    expect(issuesApi.listComments).toHaveBeenCalledTimes(1);
  });

  it("seeds both the detail snapshot and the first comments page for navigation", async () => {
    const issue = createIssue();
    const firstPage = [createComment({ id: "c1" })];
    vi.mocked(issuesApi.listComments).mockResolvedValue(firstPage);

    await prefetchIssueDetailForNavigation(queryClient, issue.identifier!, { issue });

    // Complete snapshot seeds the detail cache without a network fetch.
    expect(issuesApi.get).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.id))).toEqual(issue);

    const cachedComments = queryClient.getQueryData<{ pages: IssueComment[][] }>(
      queryKeys.issues.comments(issue.identifier!),
    );
    expect(cachedComments?.pages).toEqual([firstPage]);
  });
});
