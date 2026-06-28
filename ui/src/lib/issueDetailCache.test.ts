import { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import {
  fetchIssueDetail,
  getCachedIssueDetail,
  prefetchIssueDetail,
  seedIssueDetailCache,
} from "./issueDetailCache";
import { queryKeys } from "./queryKeys";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
  },
}));

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Fast link target",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-11T00:00:00.000Z"),
    updatedAt: new Date("2026-04-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

describe("issueDetailCache", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    vi.clearAllMocks();
  });

  it("seeds and resolves issue detail by both identifier and id", () => {
    const issue = createIssue();

    seedIssueDetailCache(queryClient, issue, { issueRef: issue.identifier });

    expect(getCachedIssueDetail(queryClient, issue.identifier)).toEqual(issue);
    expect(getCachedIssueDetail(queryClient, issue.id)).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.id))).toEqual(issue);
  });

  it("prefetches with the provided issue snapshot without forcing a fresh fetch", async () => {
    const issue = createIssue();

    await prefetchIssueDetail(queryClient, issue.identifier!, { issue });

    expect(getCachedIssueDetail(queryClient, issue.identifier)).toEqual(issue);
    expect(getCachedIssueDetail(queryClient, issue.id)).toEqual(issue);
    expect(issuesApi.get).not.toHaveBeenCalled();
  });

  it("does not seed partial issue snapshots during prefetch", async () => {
    const issue = createIssue();
    const partialIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
    } as Issue;
    vi.mocked(issuesApi.get).mockResolvedValue(issue);

    await prefetchIssueDetail(queryClient, issue.identifier!, { issue: partialIssue });

    expect(issuesApi.get).toHaveBeenCalledWith(issue.identifier);
    expect(getCachedIssueDetail(queryClient, issue.identifier)).toEqual(issue);
  });

  it("does not write partial issue snapshots into the detail cache", () => {
    const issue = createIssue();
    const partialIssue = {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
    } as Issue;

    seedIssueDetailCache(queryClient, partialIssue, { issueRef: issue.identifier });

    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toBeUndefined();
    expect(getCachedIssueDetail(queryClient, issue.identifier)).toBeUndefined();
  });

  it("hydrates both cache aliases from a fetched issue detail response", async () => {
    const issue = createIssue();
    vi.mocked(issuesApi.get).mockResolvedValue(issue);

    const result = await fetchIssueDetail(queryClient, issue.identifier!);

    expect(result).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.identifier!))).toEqual(issue);
    expect(queryClient.getQueryData(queryKeys.issues.detail(issue.id))).toEqual(issue);
  });
});
