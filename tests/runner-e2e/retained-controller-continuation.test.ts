import { describe, expect, it } from "vitest";
import { gradeRetainedControllerContinuation, retainedControllerRun } from "./retained-controller-continuation.js";

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
