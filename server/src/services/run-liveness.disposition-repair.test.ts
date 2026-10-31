import { describe, expect, it } from "vitest";
import { classifyRunLiveness } from "./run-liveness.js";

describe("disposition repair liveness", () => {
  const evidence = {
    issueCommentsCreated: 1,
    activityEventsCreated: 1,
    workspaceOperationsCreated: 1,
    latestEvidenceAt: new Date("2026-10-31T12:00:00Z"),
  };
  const issue = { status: "todo", title: "Implement source fix", description: "Write code and tests" };

  it("does not credit a status and comment only repair as deliverable progress", () => {
    expect(classifyRunLiveness({
      runStatus: "succeeded", issue, evidence,
      contextSnapshot: { source: "issue.deliberate_wait_disposition_repair", legacyDispositionEpisode: { id: "source", attempt: 2 } },
      issueCommentBodies: ["Returned the task to todo. Next: implement code."],
    })).toMatchObject({ livenessState: "needs_followup", lastUsefulActionAt: null });
  });

  it("keeps ordinary concrete work and a terminal repair disposition distinct", () => {
    expect(classifyRunLiveness({ runStatus: "succeeded", issue, evidence }).livenessState).toBe("advanced");
    expect(classifyRunLiveness({
      runStatus: "succeeded", issue: { ...issue, status: "done" }, evidence,
      contextSnapshot: { source: "issue.deliberate_wait_disposition_repair" },
    }).livenessState).toBe("completed");
  });
});
