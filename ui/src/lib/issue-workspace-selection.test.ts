import { describe, expect, it } from "vitest";
import {
  buildWorkspaceSelectionUpdate,
  currentWorkspaceSelection,
} from "./issue-workspace-selection";

describe("issue workspace selection", () => {
  it("builds the true project-default update", () => {
    expect(buildWorkspaceSelectionUpdate(null, null, null)).toEqual({
      executionWorkspacePreference: null,
      executionWorkspaceId: null,
      executionWorkspaceSettings: null,
    });
  });

  it("builds a new isolated workspace update", () => {
    expect(buildWorkspaceSelectionUpdate("isolated_workspace", null, null)).toEqual({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });
  });

  it("builds a reuse-existing update with the reused workspace mode", () => {
    expect(buildWorkspaceSelectionUpdate("reuse_existing", "workspace-1", "operator_branch")).toEqual({
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: "workspace-1",
      executionWorkspaceSettings: {
        mode: "operator_branch",
        environmentId: null,
      },
    });
  });

  it("does not build a reuse-existing update without a workspace id", () => {
    expect(buildWorkspaceSelectionUpdate("reuse_existing", null, "isolated_workspace")).toBeNull();
  });

  it("keeps the old card's shared-workspace payload available", () => {
    expect(buildWorkspaceSelectionUpdate("shared_workspace", null, null)).toEqual({
      executionWorkspacePreference: "shared_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: {
        mode: "shared_workspace",
        environmentId: null,
      },
    });
  });

  it("presents a bound isolated workspace as reuse existing", () => {
    expect(currentWorkspaceSelection({
      executionWorkspaceId: "workspace-1",
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      currentExecutionWorkspace: null,
    }, null)).toBe("reuse_existing");
  });
});
