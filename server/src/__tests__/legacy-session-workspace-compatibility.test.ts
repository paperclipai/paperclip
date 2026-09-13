import { describe, expect, it } from "vitest";
import { hasMatchingLegacySessionWorkspace } from "../services/legacy-session-workspace-compatibility.js";

const proof = () => ({
  companyId: "company", agentId: "agent", responsibleUserId: "user", taskId: "task",
  workspaceId: "workspace", sessionDisplayId: "conversation", sessionFingerprint: "old-session",
  workspaceFingerprint: "same-effective-workspace", fingerprintVersion: 1,
  previousRun: {
    companyId: "company", agentId: "agent", responsibleUserId: "user", status: "succeeded",
    sessionIdAfter: "conversation", contextSnapshot: { taskId: "task", executionWorkspaceId: "workspace" },
    resultJson: { configFreshness: {
      session: { fingerprintVersion: 1, nextFingerprint: "old-session" },
      workspace: { fingerprintVersion: 1, nextFingerprint: "same-effective-workspace" },
    } },
  },
});

describe("historical session workspace evidence", () => {
  it("recognizes the same effective contract recorded by the session's successful run", () => {
    expect(hasMatchingLegacySessionWorkspace(proof())).toBe(true);
  });
  it.each(["companyId", "agentId", "responsibleUserId", "taskId", "workspaceId", "sessionDisplayId",
    "sessionFingerprint", "workspaceFingerprint"] as const)("rejects a changed %s", key => {
    expect(hasMatchingLegacySessionWorkspace({ ...proof(), [key]: "different" })).toBe(false);
  });
  it("rejects missing, failed, ambiguous, or incompatible historical evidence", () => {
    expect(hasMatchingLegacySessionWorkspace({ ...proof(), previousRun: null })).toBe(false);
    const failed = proof(); failed.previousRun.status = "failed";
    expect(hasMatchingLegacySessionWorkspace(failed)).toBe(false);
    const missing = proof(); missing.previousRun.resultJson = {} as typeof missing.previousRun.resultJson;
    expect(hasMatchingLegacySessionWorkspace(missing)).toBe(false);
    const ambiguous = proof(); Object.assign(ambiguous.previousRun.contextSnapshot, { issueId: "another-task" });
    expect(hasMatchingLegacySessionWorkspace(ambiguous)).toBe(false);
    expect(hasMatchingLegacySessionWorkspace({ ...proof(), fingerprintVersion: 2 })).toBe(false);
  });
});
