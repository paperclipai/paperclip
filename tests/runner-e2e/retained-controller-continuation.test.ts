import { describe, expect, it, vi } from "vitest";
import { gradeRetainedControllerContinuation, retainedControllerRun, retainedControllerFollowupTransport, submitRetainedControllerComment, onePersistedRetainedControllerComment } from "./retained-controller-continuation.js";

import { runnerMatrix } from "./catalog.js";

function fixture() {
  const before = retainedControllerRun({ id: "a", companyId: "company", agentId: "agent", nativeIssueId: "task",
    runtimeMode: "native", status: "succeeded", nativeSessionId: "private-native-session", sessionIdAfter: "private-provider-session",
    finishedAt: "2026-10-30T00:00:00Z" });
  return { before, after: { ...before, runId: "b", finishedAt: "2026-10-30T00:01:00Z" },
    outage: { schema: "paperclip.e2e.controller-outage/v1" as const, requestId: "retained", signal: "SIGKILL" as const,
      holdMs: 1000, startedAt: "2026-10-30T00:00:01Z", previousPid: 1, replacementPid: 2,
      stoppedAfterMs: 0, replacementStartedAfterMs: 1000, readyAfterMs: 2000, cacheDiscarded: true },
    requestedAt: "2026-10-30T00:00:04Z", completedTool: true, usefulReply: true };
}

describe("retained controller continuation evidence", () => {
  it("accepts a new useful turn after a completed source and cache retirement", () => {
    expect(gradeRetainedControllerContinuation(fixture())[0]?.passed).toBe(true);
    expect(JSON.stringify(fixture())).not.toContain("private-provider-session");
  });
  it.each(["provider", "native", "same-run", "before-completion", "no-cache-loss", "no-tool", "no-answer"])("rejects %s evidence", fault => {
    const input = fixture();
    if (fault === "provider") input.after.providerSessionSha256 = "different";
    if (fault === "native") input.after.nativeSessionSha256 = null;
    if (fault === "same-run") input.after.runId = input.before.runId;
    if (fault === "before-completion") input.before.finishedAt = "2026-10-30T00:00:10Z";
    if (fault === "no-cache-loss") input.outage.cacheDiscarded = false;
    if (fault === "no-tool") input.completedTool = false;
    if (fault === "no-answer") input.usefulReply = false;
    expect(gradeRetainedControllerContinuation(input)[0]?.passed).toBe(false);
  });
});

describe("post-controller API follow-up selection", () => {
  const execution = runnerMatrix.find(cell => cell.id === "daytona-restart-continuity.runner-codex.daytona.recover-controller")!;
  it("selects only the explicit dedicated definition and defaults to the browser", () => {
    expect(retainedControllerFollowupTransport(execution)).toBe("task_comment_api");
    for (const changed of [
      { ...execution, suite: { ...execution.suite, id: "everyday-workflows" } },
      { ...execution, task: { ...execution.task, id: "another-case" } },
      { ...execution, suite: { ...execution.suite, definitionMetadata: { retainedControllerContinuation: true } } },
      { ...execution, suite: { ...execution.suite, definitionMetadata: { retainedControllerFollowupTransport: "task_comment_api" } } },
    ]) expect(retainedControllerFollowupTransport(changed)).toBe("browser");
  });
  it("posts one ordinary authenticated comment request with a stable client request ID", async () => {
    const post = vi.fn(async () => ({ id: "saved-user-comment" }));
    const api = { post } as unknown as Parameters<typeof submitRetainedControllerComment>[0];
    await expect(submitRetainedControllerComment(api, "task-id", "Exact original follow-up.", "request-id"))
      .resolves.toEqual({ id: "saved-user-comment" });
    expect(post).toHaveBeenCalledExactlyOnceWith("/api/issues/task-id/comments", {
      body: "Exact original follow-up.", reopen: true, clientRequestId: "request-id",
    });
  });
  it("requires exactly the matching persisted user comment", () => {
    const comment = { id: "comment", body: "Exact follow-up", authorType: "user" };
    const proof = { added: [comment], commentId: comment.id, body: comment.body };
    expect(onePersistedRetainedControllerComment(proof)).toBe(true);
    expect(onePersistedRetainedControllerComment({ ...proof, commentId: "" })).toBe(false);
    for (const added of [[], [comment, { ...comment, id: "duplicate" }], [{ ...comment, id: "other" }],
      [{ ...comment, body: "changed" }], [{ ...comment, authorType: "system" }], [{ ...comment, authorAgentId: "agent" }]]) {
      expect(onePersistedRetainedControllerComment({ ...proof, added })).toBe(false);
    }
  });
});
