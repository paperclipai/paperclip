import { describe, expect, it } from "vitest";
import { buildWakeContextSuffix } from "@paperclipai/adapter-utils/server-utils";

describe("buildWakeContextSuffix", () => {
  it("returns empty string when context has no wake fields", () => {
    expect(buildWakeContextSuffix({})).toBe("");
    expect(buildWakeContextSuffix({ paperclipWorkspace: { cwd: "/foo" } })).toBe("");
  });

  it("includes task_id from taskId", () => {
    const result = buildWakeContextSuffix({ taskId: "task-abc" });
    expect(result).toContain("[Paperclip wake context]");
    expect(result).toContain("task_id: task-abc");
  });

  it("falls back to issueId when taskId is absent", () => {
    const result = buildWakeContextSuffix({ issueId: "issue-xyz" });
    expect(result).toContain("task_id: issue-xyz");
  });

  it("prefers taskId over issueId", () => {
    const result = buildWakeContextSuffix({ taskId: "task-abc", issueId: "issue-xyz" });
    expect(result).toContain("task_id: task-abc");
    expect(result).not.toContain("issue-xyz");
  });

  it("includes wake_reason", () => {
    const result = buildWakeContextSuffix({ wakeReason: "issue_commented" });
    expect(result).toContain("wake_reason: issue_commented");
  });

  it("includes wake_comment_id from wakeCommentId", () => {
    const result = buildWakeContextSuffix({ wakeCommentId: "comment-1" });
    expect(result).toContain("wake_comment_id: comment-1");
  });

  it("falls back to commentId when wakeCommentId is absent", () => {
    const result = buildWakeContextSuffix({ commentId: "comment-2" });
    expect(result).toContain("wake_comment_id: comment-2");
  });

  it("includes approval fields", () => {
    const result = buildWakeContextSuffix({ approvalId: "appr-1", approvalStatus: "approved" });
    expect(result).toContain("approval_id: appr-1");
    expect(result).toContain("approval_status: approved");
  });

  it("includes linked_issue_ids as comma-separated list", () => {
    const result = buildWakeContextSuffix({ issueIds: ["id-1", "id-2", "id-3"] });
    expect(result).toContain("linked_issue_ids: id-1, id-2, id-3");
  });

  it("skips non-string entries in issueIds", () => {
    const result = buildWakeContextSuffix({ issueIds: ["id-1", null, 42, "id-2"] });
    expect(result).toContain("linked_issue_ids: id-1, id-2");
  });

  it("renders all fields together", () => {
    const result = buildWakeContextSuffix({
      taskId: "task-abc",
      wakeReason: "issue_commented",
      wakeCommentId: "comment-1",
      approvalId: "appr-1",
      approvalStatus: "approved",
      issueIds: ["id-1", "id-2"],
    });
    expect(result).toBe(
      "\n\n[Paperclip wake context]\n" +
      "task_id: task-abc\n" +
      "wake_reason: issue_commented\n" +
      "wake_comment_id: comment-1\n" +
      "approval_id: appr-1\n" +
      "approval_status: approved\n" +
      "linked_issue_ids: id-1, id-2",
    );
  });

  it("strips embedded newlines from string values", () => {
    const result = buildWakeContextSuffix({ wakeReason: "issue\ncommented" });
    expect(result).toContain("wake_reason: issue commented");
    expect(result).not.toContain("\nissue");
  });

  it("ignores empty string values", () => {
    expect(buildWakeContextSuffix({ taskId: "", wakeReason: "  " })).toBe("");
  });
});
