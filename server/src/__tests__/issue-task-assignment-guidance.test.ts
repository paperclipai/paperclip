import { describe, expect, it } from "vitest";
import { buildTaskAssignPermissionDeniedDetails, buildTaskAssignPermissionDeniedError } from "../routes/issues.js";

describe("buildTaskAssignPermissionDeniedDetails", () => {
  it("documents the unassigned-triage fallback", () => {
    expect(buildTaskAssignPermissionDeniedDetails()).toEqual({
      fallback: {
        mode: "unassigned_issue_for_triage",
        summary: "Create the issue unassigned and route triage through the parent issue thread.",
        steps: [
          "Retry without assigneeAgentId or assigneeUserId.",
          "Keep the issue in backlog or todo until someone with tasks:assign routes it.",
          "Add a parent-issue comment linking the child issue so CEO or manager triage can pick it up.",
        ],
      },
    });
  });
});

describe("buildTaskAssignPermissionDeniedError", () => {
  it("returns a 403 with actionable fallback details", () => {
    const err = buildTaskAssignPermissionDeniedError();

    expect(err.status).toBe(403);
    expect(err.message).toBe("Missing permission: tasks:assign");
    expect(err.details).toEqual(buildTaskAssignPermissionDeniedDetails());
  });
});
