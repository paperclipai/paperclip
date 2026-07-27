// @vitest-environment node

const { getCommentMock } = vi.hoisted(() => ({
  getCommentMock: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    getComment: getCommentMock,
  },
}));

import { describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

describe("LiveUpdatesProvider issue invalidation", () => {
  it("refreshes touched inbox queries and only the changed issue data for issue updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listMineByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listUnreadTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.runs("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.attachments("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.approvals("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.liveRuns("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.activeRun("issue-1"),
    });
  });

  it("still refreshes comments when a comment activity event arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
    });
  });

  it("keeps heartbeat progress invalidation scoped away from hot list queries", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
    };

    __liveUpdatesTestUtils.invalidateHeartbeatProgressQueries(
      queryClient as never,
      "company-1",
      {
        agentId: "agent-1",
        runId: "run-1",
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.agents.detail("agent-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.liveRuns("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.heartbeats("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.heartbeats("company-1", "agent-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.agents.list("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.dashboard("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.costs("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.sidebarBadges("company-1"),
    });
  });

  it("applies heartbeat progress payloads directly to cached visible issue runs", () => {
    const cache = new Map<string, unknown>([
      [JSON.stringify(queryKeys.liveRuns("company-1")), [{ id: "run-1", currentStatusMessage: null }]],
      [JSON.stringify(queryKeys.issues.detail("DEMO-759")), {
        id: "issue-1",
        identifier: "DEMO-759",
        assigneeAgentId: "agent-1",
      }],
      [JSON.stringify(queryKeys.issues.detail("issue-1")), {
        id: "issue-1",
        identifier: "DEMO-759",
        assigneeAgentId: "agent-1",
      }],
      [JSON.stringify(queryKeys.issues.activeRun("DEMO-759")), {
        id: "run-1",
        currentStatusMessage: null,
      }],
      [JSON.stringify(queryKeys.issues.activeRun("issue-1")), {
        id: "run-1",
        currentStatusMessage: null,
      }],
      [JSON.stringify(queryKeys.issues.liveRuns("DEMO-759")), [{ id: "run-1", currentStatusMessage: null }]],
      [JSON.stringify(queryKeys.issues.liveRuns("issue-1")), [{ id: "run-1", currentStatusMessage: null }]],
      [JSON.stringify(queryKeys.issues.runs("DEMO-759")), [{ runId: "run-1" }]],
    ]);
    const queryClient = {
      getQueryData: (key: unknown) => cache.get(JSON.stringify(key)),
      setQueryData: (key: unknown, updater: unknown) => {
        const cacheKey = JSON.stringify(key);
        const current = cache.get(cacheKey);
        cache.set(cacheKey, typeof updater === "function" ? updater(current) : updater);
      },
    };

    const changed = __liveUpdatesTestUtils.applyRunLiveStatusPatchToCaches(
      queryClient as never,
      "company-1",
      "/DEMO/issues/DEMO-759",
      {
        runId: "run-1",
        agentId: "agent-1",
        issueId: "issue-1",
        message: "Syncing workspace",
        updatedAt: "2026-04-06T12:00:05.000Z",
        currentToolName: "bash",
        lastAssistantSnippet: "Reading package.json",
        lastEventAt: "2026-04-06T12:00:08.000Z",
      },
      { isForegrounded: true },
    );

    expect(changed).toBe(true);
    expect(cache.get(JSON.stringify(queryKeys.liveRuns("company-1")))).toEqual([
      expect.objectContaining({
        id: "run-1",
        currentStatusMessage: "Syncing workspace",
        currentStatusUpdatedAt: "2026-04-06T12:00:05.000Z",
        currentToolName: "bash",
        lastAssistantSnippet: "Reading package.json",
        lastEventAt: "2026-04-06T12:00:08.000Z",
      }),
    ]);
    expect(cache.get(JSON.stringify(queryKeys.issues.activeRun("DEMO-759")))).toMatchObject({
      currentToolName: "bash",
      lastAssistantSnippet: "Reading package.json",
    });
    expect(cache.get(JSON.stringify(queryKeys.issues.liveRuns("issue-1")))).toEqual([
      expect.objectContaining({
        currentStatusMessage: "Syncing workspace",
        currentToolName: "bash",
      }),
    ]);
  });

  it("uses the heartbeat event timestamp for run event status patches", () => {
    expect(
      __liveUpdatesTestUtils.readRunLiveStatusPatchFromPayload(
        {
          runId: "run-1",
          agentId: "agent-1",
          issueId: "issue-1",
          message: "Tool started",
          currentToolName: "bash",
          lastAssistantSnippet: "Checking workspace",
        },
        "2026-04-06T12:00:09.000Z",
        "heartbeat.run.event",
      ),
    ).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      issueId: "issue-1",
      message: "Tool started",
      updatedAt: "2026-04-06T12:00:09.000Z",
      currentToolName: "bash",
      lastAssistantSnippet: "Checking workspace",
      lastEventAt: "2026-04-06T12:00:09.000Z",
    });
  });

  it("does not clear run tool context from null heartbeat event fields", () => {
    const patch = __liveUpdatesTestUtils.readRunLiveStatusPatchFromPayload(
      {
        runId: "run-1",
        agentId: "agent-1",
        issueId: "issue-1",
        message: null,
        currentToolName: null,
        lastAssistantSnippet: null,
        lastEventAt: "2026-04-06T12:00:10.000Z",
      },
      "2026-04-06T12:00:09.000Z",
      "heartbeat.run.event",
    );

    expect(patch).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      issueId: "issue-1",
      updatedAt: "2026-04-06T12:00:09.000Z",
      lastEventAt: "2026-04-06T12:00:10.000Z",
    });
    expect(patch).not.toHaveProperty("message");
    expect(patch).not.toHaveProperty("currentToolName");
    expect(patch).not.toHaveProperty("lastAssistantSnippet");
  });

  it("refreshes issue document caches when a document activity event arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.document_updated",
        actorType: "agent",
        actorId: "agent-1",
        details: {
          identifier: "PAP-9403",
          key: "plan",
        },
      },
      { userId: "user-1", agentId: null },
      { pathname: "/PAP/issues/PAP-9403", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.document("issue-1", "plan"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.documentRevisions("issue-1", "plan"),
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-annotations", "issue-1", "plan"],
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.documents("PAP-9403"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.document("PAP-9403", "plan"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.documentRevisions("PAP-9403", "plan"),
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-annotations", "PAP-9403", "plan"],
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
      refetchType: "inactive",
    });
  });

  it("refreshes all issue document caches when document activity omits a document key", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.document_deleted",
        actorType: "agent",
        actorId: "agent-1",
        details: null,
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document", "issue-1"],
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-revisions", "issue-1"],
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-annotations", "issue-1"],
    });
  });

  it("refreshes document annotation caches when annotation activity arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.document_annotation_comment_added",
        actorType: "user",
        actorId: "user-2",
        details: {
          identifier: "PAP-9403",
          documentKey: "plan",
          threadId: "thread-1",
          commentId: "comment-1",
        },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-annotations", "issue-1", "plan"],
    });
    expect(invalidations).toContainEqual({
      queryKey: ["issues", "document-annotations", "PAP-9403", "plan"],
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.documents("issue-1"),
    });
  });

  it("refreshes routine description annotation caches when routine annotation activity arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "routine",
        entityId: "routine-1",
        action: "routine.document_annotation_comment_added",
        actorType: "user",
        actorId: "user-2",
        details: {
          documentKey: "description",
          threadId: "thread-1",
          commentId: "comment-1",
        },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: ["routines"],
    });
    expect(invalidations).toContainEqual({
      queryKey: ["routines", "document-annotations", "routine-1", "description"],
    });
  });

  it("refreshes case document annotation caches when case annotation activity arrives", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "case",
        entityId: "case-1",
        action: "case.document_annotation_comment_added",
        actorType: "user",
        actorId: "user-2",
        details: {
          documentKey: "body",
          threadId: "thread-1",
          commentId: "comment-1",
        },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.cases.list("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.cases.detail("case-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.cases.events("case-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: ["cases", "document-annotations", "case-1", "body"],
    });
  });

  it("keeps self-authored comment events from refetching the active issue tree", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        actorType: "user",
        actorId: "user-1",
        details: null,
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("treats self-authored comment-driven issue updates as inactive-only refreshes", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "user",
        actorId: "user-1",
        details: { source: "comment" },
      },
      { userId: "user-1", agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible issue detail refetches inactive for downstream agent updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "system",
        actorId: "heartbeat",
        details: {
          identifier: "PAP-759",
          source: "deferred_comment_wake",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
  });

  it("still actively refetches visible issue detail for board-authored updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.updated",
        actorType: "user",
        actorId: "user-2",
        details: {
          identifier: "PAP-759",
          status: "in_progress",
        },
      },
      { userId: "user-1", agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
  });

  it("keeps visible issue comment updates inactive-only instead of active refetching", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        actorType: "agent",
        actorId: "agent-1",
        details: {
          identifier: "PAP-759",
          commentId: "comment-1",
          bodySnippet: "New agent comment",
        },
      },
      { userId: null, agentId: null },
      { pathname: "/PAP/issues/PAP-759", isForegrounded: true },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("issue-1"),
      refetchType: "inactive",
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.comments("issue-1"),
      refetchType: "inactive",
    });
  });

  it("refreshes visible issue run queries when the displayed run changes status", () => {
    const invalidations: unknown[] = [];
    const cache = new Map<string, unknown>([
      [JSON.stringify(queryKeys.issues.detail("PAP-759")), {
        id: "issue-1",
        identifier: "PAP-759",
        assigneeAgentId: "agent-1",
        executionRunId: "run-1",
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date("2026-04-08T21:00:00.000Z"),
      }],
      [JSON.stringify(queryKeys.issues.detail("issue-1")), {
        id: "issue-1",
        identifier: "PAP-759",
        assigneeAgentId: "agent-1",
        executionRunId: "run-1",
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date("2026-04-08T21:00:00.000Z"),
      }],
      [JSON.stringify(queryKeys.issues.activeRun("PAP-759")), {
        id: "run-1",
      }],
      [JSON.stringify(queryKeys.issues.activeRun("issue-1")), {
        id: "run-1",
      }],
      [JSON.stringify(queryKeys.issues.liveRuns("PAP-759")), [{ id: "run-1" }]],
      [JSON.stringify(queryKeys.issues.liveRuns("issue-1")), [{ id: "run-1" }]],
      [JSON.stringify(queryKeys.issues.runs("PAP-759")), [{ runId: "run-1" }]],
      [JSON.stringify(queryKeys.issues.runs("issue-1")), [{ runId: "run-1" }]],
    ]);
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        return cache.get(JSON.stringify(key));
      },
      setQueryData: (key: unknown, updater: unknown) => {
        const cacheKey = JSON.stringify(key);
        const current = cache.get(cacheKey);
        cache.set(cacheKey, typeof updater === "function" ? updater(current) : updater);
      },
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleIssueRunQueries(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        runId: "run-1",
        agentId: "agent-1",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(true);
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activity("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.runs("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.liveRuns("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activeRun("PAP-759"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.activeRun("issue-1"),
    });
    expect(cache.get(JSON.stringify(queryKeys.issues.activeRun("PAP-759")))).toBeNull();
    expect(cache.get(JSON.stringify(queryKeys.issues.liveRuns("PAP-759")))).toEqual([]);
    expect(cache.get(JSON.stringify(queryKeys.issues.detail("PAP-759")))).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(cache.get(JSON.stringify(queryKeys.issues.activeRun("issue-1")))).toBeNull();
    expect(cache.get(JSON.stringify(queryKeys.issues.liveRuns("issue-1")))).toEqual([]);
    expect(cache.get(JSON.stringify(queryKeys.issues.detail("issue-1")))).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("ignores run status events for other issues", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.activeRun("PAP-759"))) {
          return {
            id: "run-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.liveRuns("PAP-759"))) {
          return [{ id: "run-1" }];
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.runs("PAP-759"))) {
          return [{ runId: "run-1" }];
        }
        return undefined;
      },
      setQueryData: vi.fn(),
    };

    const invalidated = __liveUpdatesTestUtils.invalidateVisibleIssueRunQueries(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        runId: "run-2",
        agentId: "agent-2",
        status: "succeeded",
      },
      { isForegrounded: true },
    );

    expect(invalidated).toBe(false);
    expect(invalidations).toEqual([]);
  });
});

describe("LiveUpdatesProvider visible issue comment hydration", () => {
  it("hydrates the visible issue comments cache with only the new comment", async () => {
    getCommentMock.mockResolvedValueOnce({
      id: "comment-2",
      companyId: "company-1",
      issueId: "issue-1",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Second comment",
      createdAt: "2026-04-13T15:00:00.000Z",
      updatedAt: "2026-04-13T15:00:00.000Z",
    });

    const setCalls: Array<{ key: unknown; value: unknown }> = [];
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.comments("PAP-759"))) {
          return {
            pages: [[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "First comment",
              createdAt: "2026-04-13T14:00:00.000Z",
              updatedAt: "2026-04-13T14:00:00.000Z",
            }]],
            pageParams: [null],
          };
        }
        return undefined;
      },
      setQueryData: (key: unknown, updater: (value: unknown) => unknown) => {
        const current = queryClient.getQueryData(key);
        setCalls.push({ key, value: updater(current) });
      },
      invalidateQueries: vi.fn(),
    };

    await __liveUpdatesTestUtils.hydrateVisibleIssueComment(
      queryClient as never,
      "/PAP/issues/PAP-759",
      {
        entityType: "issue",
        entityId: "issue-1",
        action: "issue.comment_added",
        details: {
          identifier: "PAP-759",
          commentId: "comment-2",
        },
      },
      { isForegrounded: true },
    );

    expect(getCommentMock).toHaveBeenCalledWith("PAP-759", "comment-2");
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.key).toEqual(queryKeys.issues.comments("PAP-759"));
    expect(setCalls[0]?.value).toEqual({
      pages: [[
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Second comment",
          createdAt: "2026-04-13T15:00:00.000Z",
          updatedAt: "2026-04-13T15:00:00.000Z",
        },
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "First comment",
          createdAt: "2026-04-13T14:00:00.000Z",
          updatedAt: "2026-04-13T14:00:00.000Z",
        },
      ]],
      pageParams: [null],
    });
  });
});

describe("LiveUpdatesProvider visible issue toast suppression", () => {
  it("suppresses activity toasts for the issue page currently in view", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-1",
          details: { identifier: "PAP-759" },
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressActivityToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          entityType: "issue",
          entityId: "issue-2",
          details: { identifier: "PAP-760" },
        },
        { isForegrounded: true },
      ),
    ).toBe(false);
  });

  it("suppresses run and agent status toasts for the assignee of the visible issue", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            assigneeAgentId: "agent-1",
          };
        }
        return undefined;
      },
    };

    expect(
      __liveUpdatesTestUtils.shouldSuppressRunStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          runId: "run-1",
          agentId: "agent-1",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);

    expect(
      __liveUpdatesTestUtils.shouldSuppressAgentStatusToastForVisibleIssue(
        queryClient as never,
        "/PAP/issues/PAP-759",
        {
          agentId: "agent-1",
          status: "running",
        },
        { isForegrounded: true },
      ),
    ).toBe(true);
  });
});

describe("LiveUpdatesProvider run lifecycle toasts", () => {
  it("does not build start or success toasts for agent runs", () => {
    const queryClient = {
      getQueryData: () => [],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "running",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toBeNull();

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "succeeded",
        },
        () => "CodexCoder",
      ),
    ).toBeNull();
  });

  it("still builds failure toasts for agent errors and failed runs", () => {
    const queryClient = {
      getQueryData: () => [
        {
          id: "agent-1",
          title: "Software Engineer",
        },
      ],
    };

    expect(
      __liveUpdatesTestUtils.buildAgentStatusToast(
        {
          agentId: "agent-1",
          status: "error",
        },
        () => "CodexCoder",
        queryClient as never,
        "company-1",
      ),
    ).toMatchObject({
      title: "CodexCoder errored",
      body: "Software Engineer",
      tone: "error",
    });

    expect(
      __liveUpdatesTestUtils.buildRunStatusToast(
        {
          runId: "run-1",
          agentId: "agent-1",
          status: "failed",
          error: "boom",
        },
        () => "CodexCoder",
      ),
    ).toMatchObject({
      title: "CodexCoder run failed",
      body: "boom",
      tone: "error",
    });
  });
});

describe("applyRunLifecycleToCompanyLiveRuns", () => {
  function makeClient(initial: Array<{ id: string; status: string }>) {
    const cache = new Map<string, unknown>([
      [JSON.stringify(queryKeys.liveRuns("company-1")), initial],
    ]);
    const client = {
      getQueryData: (key: unknown) => cache.get(JSON.stringify(key)),
      setQueryData: (key: unknown, updater: unknown) => {
        const cacheKey = JSON.stringify(key);
        const current = cache.get(cacheKey);
        cache.set(cacheKey, typeof updater === "function" ? updater(current) : updater);
      },
    };
    const read = () => cache.get(JSON.stringify(queryKeys.liveRuns("company-1")));
    return { client, read };
  }

  it("removes a run on a terminal status (patched, no refetch needed)", () => {
    const { client, read } = makeClient([{ id: "run-1", status: "running" }, { id: "run-2", status: "running" }]);
    const patched = __liveUpdatesTestUtils.applyRunLifecycleToCompanyLiveRuns(
      client as never,
      "company-1",
      { runId: "run-1", status: "succeeded" },
    );
    expect(patched).toBe(true);
    expect(read()).toEqual([{ id: "run-2", status: "running" }]);
  });

  it("patches status in place for a run already in the list", () => {
    const { client, read } = makeClient([{ id: "run-1", status: "queued" }]);
    const patched = __liveUpdatesTestUtils.applyRunLifecycleToCompanyLiveRuns(
      client as never,
      "company-1",
      { runId: "run-1", status: "running" },
    );
    expect(patched).toBe(true);
    expect(read()).toEqual([{ id: "run-1", status: "running" }]);
  });

  it("reports not-patched for a genuinely new run so the caller refetches", () => {
    const { client, read } = makeClient([{ id: "run-1", status: "running" }]);
    const patched = __liveUpdatesTestUtils.applyRunLifecycleToCompanyLiveRuns(
      client as never,
      "company-1",
      { runId: "run-new", status: "running" },
    );
    expect(patched).toBe(false);
    expect(read()).toEqual([{ id: "run-1", status: "running" }]); // unchanged
  });
});

describe("LiveUpdatesProvider summary slot invalidation", () => {
  it("invalidates the slot and revisions queries on summary_slot.write", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "summary_slot",
        entityId: "slot-1",
        action: "summary_slot.write",
        details: {
          scopeKind: "project",
          scopeId: "project-1",
          slotKey: "header",
          revisionId: "rev-2",
        },
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.summarySlots.detail("company-1", "project", "header", "project-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.summarySlots.revisions("company-1", "project", "header", "project-1"),
    });
  });

  it("maps a null scopeId to a company-scoped slot key", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "summary_slot",
        entityId: "slot-1",
        action: "summary_slot.write",
        details: { scopeKind: "company", scopeId: null, slotKey: "header" },
      },
      { userId: null, agentId: null },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.summarySlots.detail("company-1", "company", "header", null),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.summarySlots.revisions("company-1", "company", "header", null),
    });
  });

  it("skips slot invalidation when scope details are missing", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "summary_slot",
        entityId: "slot-1",
        action: "summary_slot.write",
        details: null,
      },
      { userId: null, agentId: null },
    );

    expect(
      invalidations.some(
        (entry) =>
          Array.isArray((entry as { queryKey?: unknown[] }).queryKey) &&
          (entry as { queryKey: unknown[] }).queryKey[0] === "summary-slots",
      ),
    ).toBe(false);
  });
});

describe("dispatchLiveEventToSubscribers", () => {
  const baseEvent = {
    id: 1,
    companyId: "company-1",
    type: "heartbeat.run.progress" as const,
    createdAt: "2026-07-15T00:00:00.000Z",
    payload: { issueId: "issue-1" },
  };

  it("delivers events for the active company to every subscriber", () => {
    const received: unknown[] = [];
    const subscribers = new Set<(event: never) => void>([
      (event) => received.push(["a", event]),
      (event) => received.push(["b", event]),
    ]);

    __liveUpdatesTestUtils.dispatchLiveEventToSubscribers(
      subscribers as never,
      "company-1",
      baseEvent as never,
    );

    expect(received).toHaveLength(2);
  });

  it("drops events for other companies", () => {
    const received: unknown[] = [];
    const subscribers = new Set<(event: never) => void>([() => received.push("hit")]);

    __liveUpdatesTestUtils.dispatchLiveEventToSubscribers(
      subscribers as never,
      "company-2",
      baseEvent as never,
    );

    expect(received).toHaveLength(0);
  });

  it("isolates a throwing subscriber from the rest", () => {
    const received: string[] = [];
    const subscribers = new Set<(event: never) => void>([
      () => {
        throw new Error("boom");
      },
      () => received.push("still-called"),
    ]);

    expect(() =>
      __liveUpdatesTestUtils.dispatchLiveEventToSubscribers(
        subscribers as never,
        "company-1",
        baseEvent as never,
      ),
    ).not.toThrow();
    expect(received).toEqual(["still-called"]);
  });
});
