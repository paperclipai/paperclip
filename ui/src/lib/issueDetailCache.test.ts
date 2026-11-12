import { QueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi } from "@/api/issues";
import { activityApi } from "@/api/activity";
import { heartbeatsApi } from "@/api/heartbeats";
import {
  issueCommentInputFactsQueryKey,
  recentIssueActivityQueryKey,
  recentIssueRunWindowQueryKey,
} from "./issue-chat-history-queries";
import {
  fetchIssueDetail,
  getCachedIssueDetail,
  prefetchIssueDetail,
  prefetchIssueDetailForNavigation,
  seedIssueDetailCache,
} from "./issueDetailCache";
import { queryKeys } from "./queryKeys";
import { resetIssueChatBootstrapsForTest } from "./issue-chat-bootstrap";

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: vi.fn(),
    getCore: vi.fn(),
    recentComments: vi.fn(),
    listComments: vi.fn(),
    listInteractions: vi.fn(),
    listAttachments: vi.fn(),
    chatBootstrap: vi.fn(),
  },
}));
vi.mock("@/api/activity", () => ({
  activityApi: { recentForIssue: vi.fn(), recentRunsForIssue: vi.fn(), runsForIssue: vi.fn(), runsByIdsForIssue: vi.fn(), inputFactsForIssue: vi.fn() },
}));
vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: { liveRunsForIssue: vi.fn(), activeRunForIssue: vi.fn() },
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
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
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


describe("task navigation prefetch", () => {
  it("warms the compact task and recent exchange used by the default surface", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const issue = createIssue();
    const recent = { comments: [], latestCommentId: null, oldestCommentId: null, hasMore: false };
    vi.mocked(issuesApi.getCore).mockResolvedValue(issue);
    vi.mocked(issuesApi.recentComments).mockResolvedValue(recent);
    vi.mocked(issuesApi.get).mockResolvedValue(issue);
    vi.mocked(issuesApi.listComments).mockResolvedValue([]);
    vi.clearAllMocks();
    try {
      await prefetchIssueDetailForNavigation(client, issue.identifier!);
      expect(client.getQueryData([...queryKeys.issues.detail(issue.identifier!), "core"])).toEqual(issue);
      expect(client.getQueryData([...queryKeys.issues.comments(issue.identifier!), "recent"])).toEqual(recent);
      expect(issuesApi.get).not.toHaveBeenCalled();
      expect(issuesApi.listComments).not.toHaveBeenCalled();
    } finally { client.clear(); }
  });

  it("retains full-history prefetch for an already expanded task", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const issue = createIssue();
    client.setQueryData(["issues", "history-expanded", issue.identifier!], true);
    vi.mocked(issuesApi.get).mockResolvedValue(issue);
    vi.mocked(issuesApi.listComments).mockResolvedValue([]);
    try {
      await prefetchIssueDetailForNavigation(client, issue.identifier!);
      expect(client.getQueryData(queryKeys.issues.detail(issue.identifier!))).toEqual(issue);
      expect(client.getQueryData(queryKeys.issues.comments(issue.identifier!))).toMatchObject({ pages: [[]] });
    } finally { client.clear(); }
  });

  describe("chat history for a likely open", () => {
    const run = (runId: string, status: string) => ({ runId, status, agentId: "agent-1", adapterType: "codex_local", createdAt: "2026-11-09T00:00:00Z" });
    function mockHistoryReads() {
      const issue = createIssue();
      vi.mocked(issuesApi.getCore).mockResolvedValue(issue);
      vi.mocked(issuesApi.recentComments).mockResolvedValue({ comments: [], latestCommentId: null, oldestCommentId: null, hasMore: false });
      vi.mocked(activityApi.recentForIssue).mockResolvedValue([{ id: "event-1" }] as never);
      vi.mocked(activityApi.recentRunsForIssue).mockResolvedValue([run("run-2", "failed"), run("run-1", "succeeded")] as never);
      vi.mocked(issuesApi.listInteractions).mockResolvedValue([]);
      vi.mocked(issuesApi.listAttachments).mockResolvedValue([]);
      vi.mocked(heartbeatsApi.liveRunsForIssue).mockResolvedValue([]);
      vi.mocked(heartbeatsApi.activeRunForIssue).mockResolvedValue(null);
      resetIssueChatBootstrapsForTest();
      return issue;
    }
    /** A task opened before has some chat reads cached; they refresh one by one. */
    const seenBefore = (client: QueryClient, ref: string) => client.setQueryData(queryKeys.issues.attachments(ref), []);

    it("warms a task with no chat history cached in one bootstrap request", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = mockHistoryReads();
      const ref = issue.identifier!;
      const recentComments = { comments: [], latestCommentId: null, oldestCommentId: null, hasMore: false };
      vi.mocked(issuesApi.chatBootstrap).mockResolvedValue({ items: [{
        ref, issue, recentComments, commentInputFacts: [], recentActivity: [{ id: "event-1" }] as never,
        recentRuns: [run("run-2", "failed"), run("run-1", "succeeded")] as never,
        interactions: [], attachments: [], liveRuns: [], activeRun: null,
      }] });
      try {
        await prefetchIssueDetailForNavigation(client, ref, { issue, history: true });
        expect(issuesApi.chatBootstrap).toHaveBeenCalledWith(issue.companyId, [ref]);
        expect(client.getQueryData(recentIssueActivityQueryKey(ref))).toEqual([{ id: "event-1" }]);
        expect(client.getQueryData(recentIssueRunWindowQueryKey(ref))).toEqual({ runs: [run("run-2", "failed")], hasEarlierRuns: true });
        expect(client.getQueryData(queryKeys.issues.liveRuns(ref))).toEqual([]);
        expect(client.getQueryData([...queryKeys.issues.comments(ref), "recent"])).toEqual(recentComments);
        // The recent-comments read shares the bootstrap; the header keeps its own read.
        expect(issuesApi.recentComments).not.toHaveBeenCalled();
        expect(issuesApi.getCore).toHaveBeenCalledOnce();
        for (const read of [activityApi.recentForIssue, activityApi.recentRunsForIssue, issuesApi.listInteractions, heartbeatsApi.liveRunsForIssue]) {
          expect(read).not.toHaveBeenCalled();
        }
      } finally { client.clear(); }
    });

    it("falls back to the separate reads when the bootstrap fails", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = mockHistoryReads();
      vi.mocked(issuesApi.chatBootstrap).mockRejectedValue(new Error("busy"));
      try {
        await prefetchIssueDetailForNavigation(client, issue.identifier!, { issue, history: true });
        expect(issuesApi.recentComments).toHaveBeenCalledOnce();
        expect(client.getQueryData(recentIssueActivityQueryKey(issue.identifier!))).toBeUndefined();
      } finally { client.clear(); }
    });

    it("fills every key the compact chat waits on before its first reveal", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = mockHistoryReads();
      const ref = issue.identifier!;
      seenBefore(client, ref);
      try {
        await prefetchIssueDetailForNavigation(client, ref, { issue, history: true });
        expect(client.getQueryData(recentIssueActivityQueryKey(ref))).toEqual([{ id: "event-1" }]);
        // Same window shape the page builds: the latest run, plus evidence of earlier runs.
        expect(client.getQueryData(recentIssueRunWindowQueryKey(ref))).toEqual({ runs: [run("run-2", "failed")], hasEarlierRuns: true });
        expect(client.getQueryData(queryKeys.issues.interactions(ref))).toEqual([]);
        expect(client.getQueryData(queryKeys.issues.attachments(ref))).toEqual([]);
        expect(client.getQueryData(queryKeys.issues.liveRuns(ref))).toEqual([]);
        // A task that is not running has no active run for the page to read.
        expect(heartbeatsApi.activeRunForIssue).not.toHaveBeenCalled();
      } finally { client.clear(); }
    });

    it("reads the active run only for running work", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = { ...mockHistoryReads(), status: "in_progress" as const };
      seenBefore(client, issue.identifier!);
      try {
        await prefetchIssueDetailForNavigation(client, issue.identifier!, { issue, history: true });
        expect(heartbeatsApi.activeRunForIssue).toHaveBeenCalledWith(issue.identifier);
        expect(client.getQueryData(queryKeys.issues.activeRun(issue.identifier!))).toBeNull();
      } finally { client.clear(); }
    });

    it("warms the input facts of the recent comments under the chat's batch keys", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = mockHistoryReads();
      const ref = issue.identifier!;
      const comment = (id: string) => ({ id, body: id, createdAt: "2026-11-09T00:00:00Z" });
      vi.mocked(issuesApi.recentComments).mockResolvedValue({
        comments: [comment("comment-b"), comment("comment-a")],
        latestCommentId: "comment-b", oldestCommentId: "comment-a", hasMore: false,
      } as never);
      vi.mocked(activityApi.inputFactsForIssue).mockResolvedValue([{ id: "input-1" }] as never);
      seenBefore(client, ref);
      try {
        await prefetchIssueDetailForNavigation(client, ref, { issue, history: true });
        // The same ids, order and keys that the chat's useIssueIdBatches reads.
        expect(activityApi.inputFactsForIssue).toHaveBeenCalledWith(ref, ["comment-a", "comment-b"]);
        const key = issueCommentInputFactsQueryKey(ref);
        expect(client.getQueryData([...key, "batch-ids"])).toEqual([["comment-a", "comment-b"]]);
        expect(client.getQueryData([...key, "batch", ["comment-a", "comment-b"]])).toEqual([{ id: "input-1" }]);
      } finally { client.clear(); }
    });

    it("reconciles a watched agent conversation's runs by id, not by reading every run", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = { ...mockHistoryReads(), conversationAgentId: "agent-1" };
      const ref = issue.identifier!;
      // A run watched earlier is still running, but has left the recent window.
      client.setQueryData(recentIssueRunWindowQueryKey(ref), { runs: [run("run-0", "running")], hasEarlierRuns: false });
      client.getQueryCache().find({ queryKey: recentIssueRunWindowQueryKey(ref) })!.invalidate();
      vi.mocked(activityApi.runsByIdsForIssue).mockResolvedValue([run("run-2", "failed"), run("run-0", "succeeded")] as never);
      try {
        await prefetchIssueDetailForNavigation(client, ref, { issue, history: true });
        expect(activityApi.runsByIdsForIssue).toHaveBeenCalledWith(ref, ["run-0", "run-2", "run-1"]);
        expect(activityApi.runsForIssue).not.toHaveBeenCalled();
      } finally { client.clear(); }
    });

    it("keeps a pointer passing over a row to the issue and recent comments", async () => {
      vi.clearAllMocks();
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const issue = mockHistoryReads();
      try {
        await prefetchIssueDetailForNavigation(client, issue.identifier!, { issue });
        expect(activityApi.recentForIssue).not.toHaveBeenCalled();
        expect(activityApi.recentRunsForIssue).not.toHaveBeenCalled();
        expect(issuesApi.listInteractions).not.toHaveBeenCalled();
        expect(heartbeatsApi.liveRunsForIssue).not.toHaveBeenCalled();
      } finally { client.clear(); }
    });
  });
});
