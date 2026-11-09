import { expect, it } from "vitest";
import { workspaceRestoreMarkerDetail } from "./workspace-restore-marker";

it("makes saved-plan claims only with durable evidence", () => {
  expect(workspaceRestoreMarkerDetail({ result: {}, savedPlan: true, hasResponse: true })).toContain("after the plan was saved");
  expect(workspaceRestoreMarkerDetail({ result: {}, savedPlan: false, hasResponse: false })).toBe("Workspace restore failed. Workspace files need recovery.");
});

it("separates explicit missing-response evidence from the restore failure", () => {
  expect(workspaceRestoreMarkerDetail({ result: { finalResponseRecorded: false }, savedPlan: false, hasResponse: false })).toContain("No final response was recorded.");
  expect(workspaceRestoreMarkerDetail({ result: { finalResponseRecorded: false }, savedPlan: false, hasResponse: true })).not.toContain("No final response");
});

it.each(["/host/secret", "../escape", "file -> /secret", "C:\\host\\secret", "tmp/private-clone/file"])("omits diagnostic path %s", (workspaceRestorePath) => {
  expect(workspaceRestoreMarkerDetail({ result: { workspaceRestorePath }, savedPlan: false, hasResponse: true })).not.toContain("Affected path");
});
