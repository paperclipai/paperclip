// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { __liveUpdatesTestUtils } from "./LiveUpdatesProvider";
import { queryKeys } from "../lib/queryKeys";

describe("LiveUpdatesProvider issue invalidation", () => {
  it("refreshes touched inbox queries for issue activity", () => {
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
        details: null,
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.inboxSummary("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.dashboard("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listTouchedByMe("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.listUnreadTouchedByMe("company-1"),
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.issues.list("company-1"),
    });
  });

  it("refreshes rail state and exact filtered issue queries affected by issue activity", () => {
    const invalidations: unknown[] = [];
    const matchingIdsKey = queryKeys.issues.filtered("company-1", {
      ids: ["issue-1", "issue-9"],
      includeReviewSignals: false,
    });
    const dashboardRecentKey = queryKeys.issues.filtered("company-1", {
      sort: "updated_desc",
      limit: 10,
      includeReviewSignals: false,
    });
    const unrelatedKey = queryKeys.issues.filtered("company-1", {
      ids: ["issue-2"],
      includeReviewSignals: false,
    });
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => undefined,
      getQueryCache: () => ({
        findAll: () => [
          { queryKey: matchingIdsKey },
          { queryKey: dashboardRecentKey },
          { queryKey: unrelatedKey },
        ],
      }),
    };

    __liveUpdatesTestUtils.invalidateActivityQueries(
      queryClient as never,
      "company-1",
      {
        entityType: "issue",
        entityId: "issue-1",
        details: null,
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.railState,
    });
    expect(invalidations).toContainEqual({
      queryKey: matchingIdsKey,
    });
    expect(invalidations).toContainEqual({
      queryKey: dashboardRecentKey,
    });
    expect(invalidations).not.toContainEqual({
      queryKey: unrelatedKey,
    });
  });

  it("refreshes the parent issue detail when a child issue activity includes parent context", () => {
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
        entityId: "issue-child-1",
        details: {
          parentId: "issue-root-1",
        },
      },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.issues.detail("issue-root-1"),
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
  it("refreshes summary queries instead of full heartbeat history on heartbeat activity", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => [],
    };

    __liveUpdatesTestUtils.invalidateHeartbeatQueries(
      queryClient as never,
      "company-1",
      { agentId: "agent-1" },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.liveRuns("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: ["companies", "company-1", "run-activity"],
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.inboxSummary("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.railState,
    });
    expect(invalidations).not.toContainEqual({
      queryKey: queryKeys.heartbeats("company-1"),
    });
  });

  it("refreshes inbox summary and rail state on agent status updates", () => {
    const invalidations: unknown[] = [];
    const queryClient = {
      invalidateQueries: (input: unknown) => {
        invalidations.push(input);
      },
      getQueryData: () => [],
    };

    __liveUpdatesTestUtils.invalidateAgentStatusQueries(
      queryClient as never,
      "company-1",
      { agentId: "agent-1", status: "error" },
    );

    expect(invalidations).toContainEqual({
      queryKey: queryKeys.inboxSummary("company-1"),
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.railState,
    });
    expect(invalidations).toContainEqual({
      queryKey: queryKeys.agents.detail("agent-1"),
    });
  });

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

describe("LiveUpdatesProvider issue activity toasts", () => {
  it("uses a success toast when an issue moves to done", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-759"))) {
          return {
            id: "issue-1",
            identifier: "PAP-759",
            title: "Ship the release",
          };
        }
        return undefined;
      },
    };

    expect(
      // buildActivityToast is intentionally exercised via test utils so status-tone
      // mapping stays covered without mounting the provider.
      (__liveUpdatesTestUtils as { buildActivityToast?: (...args: unknown[]) => unknown }).buildActivityToast?.(
        queryClient,
        "company-1",
        {
          entityType: "issue",
          entityId: "issue-1",
          action: "issue.updated",
          actorType: "agent",
          actorId: "agent-1",
          details: {
            identifier: "PAP-759",
            title: "Ship the release",
            status: "done",
            _previous: {
              status: "in_review",
            },
          },
        },
        {
          userId: null,
          agentId: null,
        },
      ),
    ).toMatchObject({
      title: "Agent agent-1 updated PAP-759",
      tone: "success",
    });
  });

  it("uses an error toast when an issue moves to blocked", () => {
    const queryClient = {
      getQueryData: (key: unknown) => {
        if (JSON.stringify(key) === JSON.stringify(queryKeys.issues.detail("PAP-760"))) {
          return {
            id: "issue-2",
            identifier: "PAP-760",
            title: "Fix the flaky deploy",
          };
        }
        return undefined;
      },
    };

    expect(
      (__liveUpdatesTestUtils as { buildActivityToast?: (...args: unknown[]) => unknown }).buildActivityToast?.(
        queryClient,
        "company-1",
        {
          entityType: "issue",
          entityId: "issue-2",
          action: "issue.updated",
          actorType: "agent",
          actorId: "agent-2",
          details: {
            identifier: "PAP-760",
            title: "Fix the flaky deploy",
            status: "blocked",
            _previous: {
              status: "in_progress",
            },
          },
        },
        {
          userId: null,
          agentId: null,
        },
      ),
    ).toMatchObject({
      title: "Agent agent-2 updated PAP-760",
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
