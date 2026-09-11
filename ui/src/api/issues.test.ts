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
