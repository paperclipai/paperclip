import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  api: mockApi,
}));

import { issuesApi } from "./issues";
import { ApiError } from "./client";
import { CommentSubmissionUnknownError } from "../lib/comment-submit-result";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
    mockApi.patch.mockReset();
    mockApi.get.mockResolvedValue([]);
    mockApi.post.mockResolvedValue({
      id: "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      issueId: "5e5f9946-c706-4785-8988-d4d6f0f499ab",
      body: "Saved fixture",
    });
    mockApi.patch.mockResolvedValue({});
  });

  it.each([null, "stopped-run"])("dispatches a stopped queue using its current revision (%s)", async (target) => {
    mockApi.get.mockResolvedValueOnce({ queueId: "queue-1", targetRunId: null, revision: "revision-2" });
    await issuesApi.interruptLatestQueuedComments("issue-1", target);
    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/queued-comments/interrupt", {
      queueId: "queue-1", targetRunId: null, revision: "revision-2",
    });
  });

  it.each([
    { queueId: null, targetRunId: null, revision: "empty" },
    { queueId: "queue-1", targetRunId: "new-run", revision: "changed" },
  ])("rejects a changed or empty queue before interruption", async queue => {
    mockApi.get.mockResolvedValueOnce(queue);
    await expect(issuesApi.interruptLatestQueuedComments("issue-1", "old-run")).rejects.toThrow("queued messages changed");
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it("fetches all pages of tasks created from the source without filtering parentage", async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `task-${index}` }));
    mockApi.get.mockResolvedValueOnce(firstPage).mockResolvedValueOnce([{ id: "last-task" }]);
    const result = await issuesApi.listAll("company-1", { createdFromIssueId: "source-1" });
    expect(result).toHaveLength(501);
    expect(mockApi.get).toHaveBeenNthCalledWith(1, "/companies/company-1/issues?createdFromIssueId=source-1&limit=500&sortField=id&sortDir=asc");
    expect(mockApi.get).toHaveBeenNthCalledWith(2, "/companies/company-1/issues?createdFromIssueId=source-1&limit=500&sortField=id&sortDir=asc&afterId=task-499");
  });

  it("passes parentId through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      parentId: "issue-parent-1",
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?parentId=issue-parent-1&limit=25",
    );
  });

  it("sends explicit attachment receipt IDs with the atomic comment request", async () => {
    const ids = [
      "9af8228f-0be7-45ae-a104-6fbe0af6f1d3",
      "5e5f9946-c706-4785-8988-d4d6f0f499ab",
    ];
    await issuesApi.addComment("issue-1", "Inspect these", true, false, ids);
    expect(mockApi.post).toHaveBeenCalledWith("/issues/issue-1/comments", {
      body: "Inspect these",
      reopen: true,
      interrupt: false,
      attachmentIds: ids,
    });
    await issuesApi.addComment(
      "issue-1",
      "[old](/api/attachments/old/content)",
    );
    expect(mockApi.post).toHaveBeenLastCalledWith("/issues/issue-1/comments", {
      body: "[old](/api/attachments/old/content)",
    });
  });

  it.each([
    new TypeError("Failed to fetch"),
    new SyntaxError("Unexpected end of JSON"),
    new ApiError("Internal", 500, {}),
  ])(
    "treats missing or invalid comment receipts as unknown %#",
    async (error) => {
      mockApi.post.mockRejectedValueOnce(error);
      await expect(
        issuesApi.addComment("issue-1", "saved maybe"),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", {
          comment: "saved maybe",
          assigneeUserId: "another",
        }),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", { title: "ordinary update" }),
      ).rejects.toBe(error);
    },
  );

  it.each([409, 422])(
    "retains a known HTTP%d comment rejection",
    async (status) => {
      const error = new ApiError("Rejected", status, {});
      mockApi.post.mockRejectedValueOnce(error);
      await expect(issuesApi.addComment("issue-1", "not saved")).rejects.toBe(
        error,
      );
      mockApi.patch.mockRejectedValueOnce(error);
      await expect(
        issuesApi.update("issue-1", { comment: "not saved" }),
      ).rejects.toBe(error);
    },
  );

  it.each([null, {}, { id: "not-a-comment", body: "text" }])(
    "does not confirm a parsed but missing comment receipt %#",
    async (receipt) => {
      mockApi.post.mockResolvedValueOnce(receipt);
      await expect(
        issuesApi.addComment("issue-1", "saved maybe"),
      ).rejects.toBeInstanceOf(CommentSubmissionUnknownError);
    },
  );
  it("passes descendantOf through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      descendantOf: "issue-root-1",
      includeBlockedBy: true,
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?descendantOf=issue-root-1&includeBlockedBy=true&limit=25",
    );
  });

  it("passes generic workspaceId filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      workspaceId: "workspace-1",
      limit: 1000,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?workspaceId=workspace-1&limit=1000",
    );
  });

  it("passes pagination offsets through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { limit: 500, offset: 1500 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&offset=1500",
    );
  });

  it("passes issue list sort options through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      limit: 500,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?limit=500&sortField=updated&sortDir=desc",
    );
  });

  it("requests the compact issue list view explicitly", async () => {
    await issuesApi.listCompact("company-1", {
      touchedByUserId: "me",
      includeLiveDescendantSummary: true,
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?touchedByUserId=me&includeLiveDescendantSummary=true&limit=100&sortField=updated&sortDir=desc&view=compact",
    );
  });

  it("passes plan document filters through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", { hasPlanDocument: false, limit: 25 });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?hasPlanDocument=false&limit=25",
    );
  });

  it("passes live descendant summary opt-in through to the company issues endpoint", async () => {
    await issuesApi.list("company-1", {
      includeLiveDescendantSummary: true,
      limit: 25,
    });

    expect(mockApi.get).toHaveBeenCalledWith(
      "/companies/company-1/issues?includeLiveDescendantSummary=true&limit=25",
    );
  });

  it("posts recovery action resolution to the source issue endpoint", async () => {
    await issuesApi.resolveRecoveryAction("issue-1", {
      actionId: "00000000-0000-0000-0000-0000000000aa",
      outcome: "restored",
      sourceIssueStatus: "done",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/recovery-actions/resolve",
      {
        actionId: "00000000-0000-0000-0000-0000000000aa",
        outcome: "restored",
        sourceIssueStatus: "done",
      },
    );
  });

  it("posts stalled review decisions to the dedicated endpoint", async () => {
    await issuesApi.decideStalledReview("issue-1", {
      action: "request_changes",
      note: "Please cover the race condition.",
    });

    expect(mockApi.post).toHaveBeenCalledWith(
      "/issues/issue-1/stalled-review-decision",
      {
        action: "request_changes",
        note: "Please cover the race condition.",
      },
    );
  });
});

describe("interaction resolution replay", () => {
  const alreadyResolved = () =>
    new ApiError("Interaction has already been resolved", 409, {
      error: "Interaction has already been resolved",
      code: "interaction_already_resolved",
    });
  const outage = () => new ApiError("Paperclip is restarting", 503, { error: "tenant_app_unavailable" });

  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.post.mockReset();
  });

  it("treats already-resolved after a transient failure as success when the resolution matches", async () => {
    const accepted = { id: "interaction-1", status: "accepted" };
    mockApi.post.mockRejectedValueOnce(outage()).mockRejectedValueOnce(alreadyResolved());
    mockApi.get.mockResolvedValue([accepted]);
    await expect(issuesApi.acceptInteraction("issue-1", "interaction-1")).rejects.toMatchObject({ status: 503 });
    await expect(issuesApi.acceptInteraction("issue-1", "interaction-1")).resolves.toEqual(accepted);
    expect(mockApi.get).toHaveBeenCalledWith("/issues/issue-1/interactions");
  });

  it("keeps the conflict when the card was resolved differently", async () => {
    mockApi.post.mockRejectedValueOnce(outage()).mockRejectedValueOnce(alreadyResolved());
    mockApi.get.mockResolvedValue([{ id: "interaction-2", status: "rejected" }]);
    await expect(issuesApi.acceptInteraction("issue-1", "interaction-2")).rejects.toBeInstanceOf(ApiError);
    await expect(issuesApi.acceptInteraction("issue-1", "interaction-2")).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the conflict when no transient failure came first", async () => {
    mockApi.post.mockRejectedValueOnce(alreadyResolved());
    mockApi.get.mockResolvedValue([{ id: "interaction-3", status: "answered" }]);
    await expect(issuesApi.respondToInteraction("issue-1", "interaction-3", { answers: [] })).rejects.toMatchObject({ status: 409 });
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});
