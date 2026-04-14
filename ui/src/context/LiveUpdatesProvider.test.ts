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

describe("LiveUpdatesProvider socket helpers", () => {
  it("waits for the selected company object to catch up before connecting", () => {
    expect(__liveUpdatesTestUtils.resolveLiveCompanyId("company-1", null)).toBeNull();
    expect(__liveUpdatesTestUtils.resolveLiveCompanyId("company-1", "company-2")).toBeNull();
    expect(__liveUpdatesTestUtils.resolveLiveCompanyId("company-1", "company-1")).toBe("company-1");
  });

  it("defers close until onopen for sockets that are still connecting", () => {
    const socket = {
      readyState: 0,
      onopen: (() => undefined) as (() => void) | null,
      onmessage: (() => undefined) as (() => void) | null,
      onerror: (() => undefined) as (() => void) | null,
      onclose: (() => undefined) as (() => void) | null,
      close: vi.fn(),
    };

    __liveUpdatesTestUtils.closeSocketQuietly(socket as never, "provider_unmount");

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
    expect(socket.onopen).toBeTypeOf("function");
    expect(socket.onerror).toBeTypeOf("function");

    socket.onopen?.();

    expect(socket.close).toHaveBeenCalledWith(1000, "provider_unmount");
    expect(socket.onopen).toBeNull();
    expect(socket.onerror).toBeNull();
  });

  it("closes open sockets immediately without leaving handlers behind", () => {
    const socket = {
      readyState: 1,
      onopen: (() => undefined) as (() => void) | null,
      onmessage: (() => undefined) as (() => void) | null,
      onerror: (() => undefined) as (() => void) | null,
      onclose: (() => undefined) as (() => void) | null,
      close: vi.fn(),
    };

    __liveUpdatesTestUtils.closeSocketQuietly(socket as never, "stale_connection");

    expect(socket.close).toHaveBeenCalledWith(1000, "stale_connection");
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
  });
});
