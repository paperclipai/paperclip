import { expect, it } from "vitest";
import { parseWorkspaceRestoreMarkerDetail, workspaceRestoreMarkerDetail } from "./workspace-restore-marker";

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

it("recognizes every generated restore variant without modifying result metadata", () => {
  for (const savedPlan of [false, true]) {
    for (const hasResponse of [false, true]) {
      for (const finalResponseRecorded of [undefined, false, true]) {
        for (const workspaceRestorePath of [undefined, ".claude/skills/paperclip", "./src/app.ts", "/host/private"]) {
          const result = Object.freeze({ finalResponseRecorded, workspaceRestorePath, errorCode: "restore_RAW_error", response: "Original response" });
          const original = JSON.stringify(result);
          const raw = workspaceRestoreMarkerDetail({ result, savedPlan, hasResponse });
          expect(parseWorkspaceRestoreMarkerDetail(raw)).toEqual({
            savedPlan,
            missingFinalResponse: !hasResponse && finalResponseRecorded === false,
            relativePath: workspaceRestorePath === ".claude/skills/paperclip" ? workspaceRestorePath : workspaceRestorePath === "./src/app.ts" ? "src/app.ts" : null,
          });
          expect(JSON.stringify(result)).toBe(original);
        }
      }
    }
  }
});

it.each([
  "Workspace restore failed.",
  "Custom: Workspace restore failed. Workspace files need recovery.",
  "Workspace restore failed. Workspace files need recovery. Extra provider detail.",
  "Workspace restore failed. Workspace files need recovery.\n",
  ...["/host/secret", "../escape", "./src/app.ts", "tmp/private-clone/file", "file -> /secret"].map((path) =>
    `Workspace restore failed. Workspace files need recovery. Affected path: ${path}.`),
])("does not parse noncanonical detail: %s", (value) => {
  expect(parseWorkspaceRestoreMarkerDetail(value)).toBeNull();
});
