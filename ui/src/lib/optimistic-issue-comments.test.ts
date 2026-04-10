import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  applyOptimisticIssueFieldUpdate,
  applyOptimisticIssueFieldUpdateToCollection,
  applyOptimisticIssueCommentUpdate,
  createOptimisticIssueComment,
  flattenIssueCommentPages,
  getNextIssueCommentPageParam,
  isQueuedIssueComment,
  matchesIssueRef,
  mergeIssueComments,
  upsertIssueComment,
  upsertIssueCommentInPages,
} from "./optimistic-issue-comments";

describe("optimistic issue comments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a pending optimistic comment for the current user", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toMatch(/^optimistic-/);
    expect(comment.clientId).toBe(comment.id);
    expect(comment.clientStatus).toBe("pending");
    expect(comment.authorUserId).toBe("board-1");
    expect(comment.authorAgentId).toBeNull();
  });

  it("falls back when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_746_000_000_000);
    const mathSpy = vi.spyOn(Math, "random").mockReturnValue(0.123456789);

    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Working on it",
      authorUserId: "board-1",
    });

    expect(comment.id).toBe("optimistic-1746000000000-4fzzzxjy");
    expect(comment.clientId).toBe(comment.id);

    nowSpy.mockRestore();
    mathSpy.mockRestore();
  });

  it("supports queued optimistic comments for active-run follow-ups", () => {
    const comment = createOptimisticIssueComment({
      companyId: "company-1",
      issueId: "issue-1",
      body: "Queue this",
      authorUserId: "board-1",
      clientStatus: "queued",
      queueTargetRunId: "run-1",
    });

    expect(comment.clientStatus).toBe("queued");
    expect(comment.queueTargetRunId).toBe("run-1");
  });

  it("merges optimistic comments into the server thread in chronological order", () => {
    const merged = mergeIssueComments(
      [
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Second",
          createdAt: new Date("2026-03-28T14:00:02.000Z"),
          updatedAt: new Date("2026-03-28T14:00:02.000Z"),
        },
      ],
      [
        {
          id: "optimistic-1",
          clientId: "optimistic-1",
          clientStatus: "pending",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "First",
          createdAt: new Date("2026-03-28T14:00:01.000Z"),
          updatedAt: new Date("2026-03-28T14:00:01.000Z"),
        },
      ],
    );

    expect(merged.map((comment) => comment.id)).toEqual(["optimistic-1", "comment-2"]);
  });

  it("upserts confirmed comments without creating duplicates", () => {
    const next = upsertIssueComment(
      [
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Original",
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
        },
      ],
      {
        id: "comment-1",
        companyId: "company-1",
        issueId: "issue-1",
        authorAgentId: null,
        authorUserId: "board-1",
        body: "Updated",
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:05.000Z"),
      },
    );

    expect(next).toHaveLength(1);
    expect(next[0]?.body).toBe("Updated");
  });

  it("flattens paged comments into one chronological thread", () => {
    const flattened = flattenIssueCommentPages([
      [
        {
          id: "comment-3",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Newest",
          createdAt: new Date("2026-03-28T14:00:03.000Z"),
          updatedAt: new Date("2026-03-28T14:00:03.000Z"),
        },
      ],
      [
        {
          id: "comment-1",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Oldest",
          createdAt: new Date("2026-03-28T14:00:01.000Z"),
          updatedAt: new Date("2026-03-28T14:00:01.000Z"),
        },
        {
          id: "comment-2",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: null,
          authorUserId: "board-1",
          body: "Middle",
          createdAt: new Date("2026-03-28T14:00:02.000Z"),
          updatedAt: new Date("2026-03-28T14:00:02.000Z"),
        },
      ],
    ]);

    expect(flattened.map((comment) => comment.id)).toEqual(["comment-1", "comment-2", "comment-3"]);
  });

  it("returns no next page param when the last page is missing", () => {
    expect(getNextIssueCommentPageParam(undefined, 50)).toBeUndefined();
  });

  it("returns the oldest id when the last page is full", () => {
    expect(
      getNextIssueCommentPageParam(
        [
          {
            id: "comment-2",
            companyId: "company-1",
            issueId: "issue-1",
            authorAgentId: null,
            authorUserId: "board-1",
            body: "Second",
            createdAt: new Date("2026-03-28T14:00:02.000Z"),
            updatedAt: new Date("2026-03-28T14:00:02.000Z"),
          },
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorAgentId: null,
            authorUserId: "board-1",
            body: "First",
            createdAt: new Date("2026-03-28T14:00:01.000Z"),
            updatedAt: new Date("2026-03-28T14:00:01.000Z"),
          },
        ],
        2,
      ),
    ).toBe("comment-1");
  });

  it("upserts paged comments without dropping older pages", () => {
    const nextPages = upsertIssueCommentInPages(
      [
        [
          {
            id: "comment-3",
            companyId: "company-1",
            issueId: "issue-1",
            authorAgentId: null,
            authorUserId: "board-1",
            body: "Newest",
            createdAt: new Date("2026-03-28T14:00:03.000Z"),
            updatedAt: new Date("2026-03-28T14:00:03.000Z"),
          },
        ],
        [
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorAgentId: null,
            authorUserId: "board-1",
            body: "Oldest",
            createdAt: new Date("2026-03-28T14:00:01.000Z"),
            updatedAt: new Date("2026-03-28T14:00:01.000Z"),
          },
        ],
      ],
      {
        id: "comment-4",
        companyId: "company-1",
        issueId: "issue-1",
        authorAgentId: null,
        authorUserId: "board-1",
        body: "Brand new",
        createdAt: new Date("2026-03-28T14:00:04.000Z"),
        updatedAt: new Date("2026-03-28T14:00:04.000Z"),
      },
    );

    expect(nextPages[0]?.map((comment) => comment.id)).toEqual(["comment-4", "comment-3"]);
    expect(nextPages[1]?.map((comment) => comment.id)).toEqual(["comment-1"]);
  });

  it("applies optimistic reopen and reassignment updates to the issue cache", () => {
    const next = applyOptimisticIssueCommentUpdate(
      {
        id: "issue-1",
        companyId: "company-1",
        projectId: null,
        projectWorkspaceId: null,
        goalId: null,
        parentId: null,
        title: "Fix comment flow",
        description: null,
        status: "done",
        priority: "medium",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: "board-1",
        issueNumber: 1,
        identifier: "PAP-1",
        originKind: "manual",
        originId: null,
        originRunId: null,
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
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      },
      {
        reopen: true,
        reassignment: {
          assigneeAgentId: null,
          assigneeUserId: "board-2",
        },
      },
    );

    expect(next?.status).toBe("todo");
    expect(next?.assigneeAgentId).toBeNull();
    expect(next?.assigneeUserId).toBe("board-2");
  });

  it("applies optimistic field updates for issue property edits", () => {
    const next = applyOptimisticIssueFieldUpdate(
      {
        id: "issue-1",
        companyId: "company-1",
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        goalId: null,
        parentId: null,
        title: "Fix property pane",
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: "board-1",
        issueNumber: 1,
        identifier: "PAP-1",
        originKind: "manual",
        originId: null,
        originRunId: null,
        requestDepth: 0,
        billingCode: null,
        assigneeAdapterOverrides: null,
        executionWorkspaceId: "exec-1",
        executionWorkspacePreference: "shared_workspace",
        executionWorkspaceSettings: null,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        hiddenAt: null,
        labelIds: ["label-1", "label-2"],
        labels: [
          {
            id: "label-1",
            companyId: "company-1",
            name: "One",
            color: "#111111",
            createdAt: new Date("2026-03-28T14:00:00.000Z"),
            updatedAt: new Date("2026-03-28T14:00:00.000Z"),
          },
          {
            id: "label-2",
            companyId: "company-1",
            name: "Two",
            color: "#222222",
            createdAt: new Date("2026-03-28T14:00:00.000Z"),
            updatedAt: new Date("2026-03-28T14:00:00.000Z"),
          },
        ],
        blockedBy: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "First blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          {
            id: "issue-3",
            identifier: "PAP-3",
            title: "Second blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [],
        project: {
          id: "project-1",
          companyId: "company-1",
          urlKey: "project-one",
          goalId: null,
          goalIds: [],
          goals: [],
          name: "Project one",
          description: null,
          status: "in_progress",
          leadAgentId: null,
          targetDate: null,
          color: null,
          env: null,
          pauseReason: null,
          pausedAt: null,
          executionWorkspacePolicy: null,
          codebase: {
            workspaceId: null,
            repoUrl: null,
            repoRef: null,
            defaultRef: null,
            repoName: null,
            localFolder: null,
            managedFolder: "/tmp/paperclip",
            effectiveLocalFolder: "/tmp/paperclip",
            origin: "local_folder",
          },
          workspaces: [],
          primaryWorkspace: null,
          archivedAt: null,
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
        },
        currentExecutionWorkspace: {
          id: "exec-1",
          companyId: "company-1",
          projectId: "project-1",
          projectWorkspaceId: null,
          sourceIssueId: "issue-1",
          mode: "shared_workspace",
          strategyType: "project_primary",
          branchName: null,
          status: "active",
          name: "Execution workspace",
          cwd: "/tmp/paperclip",
          repoUrl: null,
          baseRef: null,
          providerType: "local_fs",
          providerRef: null,
          derivedFromExecutionWorkspaceId: null,
          lastUsedAt: new Date("2026-03-28T14:00:00.000Z"),
          cleanupEligibleAt: null,
          cleanupReason: null,
          config: null,
          metadata: null,
          createdAt: new Date("2026-03-28T14:00:00.000Z"),
          updatedAt: new Date("2026-03-28T14:00:00.000Z"),
          openedAt: new Date("2026-03-28T14:00:00.000Z"),
          closedAt: null,
        },
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      },
      {
        status: "in_review",
        assigneeAgentId: null,
        assigneeUserId: "board-2",
        labelIds: ["label-2"],
        blockedByIssueIds: ["issue-3"],
        projectId: "project-2",
        executionWorkspaceId: "exec-2",
      },
    );

    expect(next?.status).toBe("in_review");
    expect(next?.assigneeAgentId).toBeNull();
    expect(next?.assigneeUserId).toBe("board-2");
    expect(next?.labelIds).toEqual(["label-2"]);
    expect(next?.labels?.map((label) => label.id)).toEqual(["label-2"]);
    expect(next?.blockedBy?.map((relation) => relation.id)).toEqual(["issue-3"]);
    expect(next?.projectId).toBe("project-2");
    expect(next?.project).toBeNull();
    expect(next?.executionWorkspaceId).toBe("exec-2");
    expect(next?.currentExecutionWorkspace).toBeNull();
  });

  it("matches issues by either uuid or identifier reference", () => {
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["issue-1"])).toBe(true);
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["PAP-1"])).toBe(true);
    expect(matchesIssueRef({ id: "issue-1", identifier: "PAP-1" } as const, ["issue-2", "PAP-2"])).toBe(false);
  });

  it("applies optimistic field updates across cached issue collections", () => {
    const issues: Issue[] = [
      {
        id: "issue-1",
        companyId: "company-1",
        projectId: null,
        projectWorkspaceId: null,
        goalId: null,
        parentId: null,
        title: "Fix property pane",
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: "board-1",
        issueNumber: 1,
        identifier: "PAP-1",
        originKind: "manual",
        originId: null,
        originRunId: null,
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
        labelIds: [],
        labels: [],
        blockedBy: [],
        blocks: [],
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      },
      {
        id: "issue-2",
        companyId: "company-1",
        projectId: null,
        projectWorkspaceId: null,
        goalId: null,
        parentId: null,
        title: "Leave me alone",
        description: null,
        status: "todo",
        priority: "medium",
        assigneeAgentId: "agent-2",
        assigneeUserId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        createdByAgentId: null,
        createdByUserId: "board-1",
        issueNumber: 2,
        identifier: "PAP-2",
        originKind: "manual",
        originId: null,
        originRunId: null,
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
        labelIds: [],
        labels: [],
        blockedBy: [],
        blocks: [],
        createdAt: new Date("2026-03-28T14:00:00.000Z"),
        updatedAt: new Date("2026-03-28T14:00:00.000Z"),
      },
    ];

    const next = applyOptimisticIssueFieldUpdateToCollection(issues, ["PAP-1"], { assigneeAgentId: "agent-9" });

    expect(next?.[0]?.assigneeAgentId).toBe("agent-9");
    expect(next?.[1]?.assigneeAgentId).toBe("agent-2");
  });

  it("treats comments without a run id as queued when they arrive during an active run", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        runId: null,
      }),
    ).toBe(true);
  });

  it("does not mark comments with an associated run as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        runId: "run-1",
      }),
    ).toBe(false);
  });

  it("does not mark interrupt comments as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        interruptedRunId: "run-1",
      }),
    ).toBe(false);
  });

  it("does not mark comments from the active run agent as queued", () => {
    expect(
      isQueuedIssueComment({
        comment: {
          createdAt: new Date("2026-03-28T16:20:05.000Z"),
          authorAgentId: "agent-1",
        },
        activeRunStartedAt: new Date("2026-03-28T16:20:00.000Z"),
        activeRunAgentId: "agent-1",
        runId: null,
      }),
    ).toBe(false);
  });
});
