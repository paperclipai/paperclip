import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGet = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
const mockPatch = vi.hoisted(() => vi.fn());

vi.mock("./client", () => ({
  api: {
    get: mockGet,
    post: mockPost,
    postForm: vi.fn(),
    put: vi.fn(),
    patch: mockPatch,
    delete: vi.fn(),
  },
}));

import { issuesApi } from "./issues";

describe("issuesApi.list", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockPatch.mockReset();
    mockGet.mockResolvedValue([]);
    mockPost.mockResolvedValue({});
    mockPatch.mockResolvedValue({});
  });

  it("does not exclude recovery sources with open successors by default", async () => {
    await issuesApi.list("company-1");

    expect(mockGet).toHaveBeenCalledWith("/companies/company-1/issues");
  });

  it("allows callers to opt into excluding recovery source issues", async () => {
    await issuesApi.list("company-1", { excludeRecoverySourcesWithOpenSuccessors: true });

    expect(mockGet).toHaveBeenCalledWith(
      "/companies/company-1/issues?excludeRecoverySourcesWithOpenSuccessors=true",
    );
  });

  it("requests issue-scoped file previews with encoded paths", async () => {
    await issuesApi.getFilePreview("issue-1", "ops/listings/wallapop draft.txt");

    expect(mockGet).toHaveBeenCalledWith(
      "/issues/issue-1/file-preview?path=ops%2Flistings%2Fwallapop+draft.txt",
    );
  });

  it("routes closed-issue reopen comments through reopen_issue and returns the created comment", async () => {
    mockPost.mockResolvedValueOnce({
      type: "reopen_issue",
      issue: { id: "issue-1", status: "todo" },
      comment: {
        id: "comment-1",
        body: "Reopening for follow-up.",
      },
    });

    const comment = await issuesApi.addCommentWorkflowAware("issue-1", "done", "Reopening for follow-up.", true);

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/actions", {
      type: "reopen_issue",
      payload: { body: "Reopening for follow-up." },
    });
    expect(comment).toMatchObject({
      id: "comment-1",
      body: "Reopening for follow-up.",
    });
  });

  it("keeps ordinary comments on the comment route and strips meaningless reopen flags on open issues", async () => {
    await issuesApi.addCommentWorkflowAware("issue-1", "todo", "Still working.", true);

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/comments", {
      body: "Still working.",
    });
  });

  it("routes closed-issue comment handoffs through handoff_issue and normalizes the response", async () => {
    mockPost.mockResolvedValueOnce({
      type: "handoff_issue",
      issue: {
        id: "issue-1",
        status: "todo",
        assigneeAgentId: "agent-2",
      },
      comment: {
        id: "comment-2",
        body: "[HANDOFF] Taking the follow-up.",
      },
      warnings: [{ code: "wake", message: "wake queued" }],
    });

    const result = await issuesApi.addCommentAndReassignWorkflowAware("issue-1", "done", {
      body: "[HANDOFF] Taking the follow-up.",
      reopen: true,
      assigneeAgentId: "agent-2",
    });

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/actions", {
      type: "handoff_issue",
      payload: {
        body: "[HANDOFF] Taking the follow-up.",
        reopen: true,
        assigneeAgentId: "agent-2",
      },
    });
    expect(result).toMatchObject({
      id: "issue-1",
      status: "todo",
      assigneeAgentId: "agent-2",
      comment: {
        id: "comment-2",
      },
      warnings: [{ code: "wake", message: "wake queued" }],
    });
  });

  it("keeps open-issue comment handoffs on the patch path without injecting workflow status changes", async () => {
    await issuesApi.addCommentAndReassignWorkflowAware("issue-1", "todo", {
      body: "Please take this.",
      reopen: true,
      assigneeAgentId: "agent-2",
    });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", {
      comment: "Please take this.",
      assigneeAgentId: "agent-2",
    });
    expect(mockPost).not.toHaveBeenCalledWith("/issues/issue-1/actions", expect.anything());
  });

  it("routes pure done transitions through the typed action endpoint", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "in_review", { status: "done" });

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/actions", {
      type: "complete_issue",
      payload: {},
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("keeps cancelled-to-done transitions on the patch path", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "cancelled", { status: "done" });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", { status: "done" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("keeps already-done status selections on the patch path", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "done", { status: "done" });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", { status: "done" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("keeps unknown-status completion requests on the patch path", async () => {
    await issuesApi.updateWorkflowAware("issue-1", undefined, { status: "done" });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", { status: "done" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("routes open review handoffs through the typed action endpoint", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "in_progress", {
      status: "in_review",
      comment: "Ready for QA",
    });

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/actions", {
      type: "enter_review",
      payload: { body: "Ready for QA" },
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("routes closed-to-open transitions through reopen_issue", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "done", { status: "blocked" });

    expect(mockPost).toHaveBeenCalledWith("/issues/issue-1/actions", {
      type: "reopen_issue",
      payload: { status: "blocked" },
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it("keeps ordinary open-to-open status changes on the patch path", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "todo", { status: "blocked" });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", { status: "blocked" });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("keeps compound updates on the patch path", async () => {
    await issuesApi.updateWorkflowAware("issue-1", "done", {
      status: "todo",
      assigneeAgentId: "agent-2",
    });

    expect(mockPatch).toHaveBeenCalledWith("/issues/issue-1", {
      status: "todo",
      assigneeAgentId: "agent-2",
    });
    expect(mockPost).not.toHaveBeenCalled();
  });
});
