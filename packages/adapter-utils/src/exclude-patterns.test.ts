import { describe, expect, it } from "vitest";
import { WORKSPACE_HEAVY_DIR_EXCLUDES, resolveSshWorkspaceSyncExcludes, shouldExcludePath } from "./exclude-patterns.js";

describe("resolveSshWorkspaceSyncExcludes", () => {
  it("applies heavy-dir excludes and the caller's excludes by default", () => {
    const excludes = resolveSshWorkspaceSyncExcludes({ workspaceExclude: [".venv", "node_modules"] });
    expect(excludes.repository).toEqual(WORKSPACE_HEAVY_DIR_EXCLUDES);
    expect(excludes.workspace).toEqual([...WORKSPACE_HEAVY_DIR_EXCLUDES, ".venv"]);
    expect(shouldExcludePath("pkg/node_modules/dep/index.js", excludes.workspace)).toBe(true);
    expect(shouldExcludePath("src/index.ts", excludes.workspace)).toBe(false);
  });

  it("applies only the caller's excludes in all-files mode", () => {
    expect(resolveSshWorkspaceSyncExcludes({ workspaceFileMode: "all", workspaceExclude: ["explicitly-excluded"] })).toEqual({
      workspace: ["explicitly-excluded"],
      repository: [],
    });
    expect(resolveSshWorkspaceSyncExcludes({ workspaceFileMode: "all" })).toEqual({ workspace: [], repository: [] });
  });
});
