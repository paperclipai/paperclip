import { describe, expect, it } from "vitest";
import { legacyWorktreeRouteTarget } from "./App";

describe("legacy workspace route redirects", () => {
  it.each([
    ["/PAP/workspaces", "/PAP/worktrees"],
    ["/PAP/projects/app/workspaces", "/PAP/projects/app/worktrees"],
    ["/PAP/projects/app/workspaces/w-1", "/PAP/projects/app/worktrees/w-1"],
    ["/PAP/execution-workspaces/w-1/services", "/PAP/execution-worktrees/w-1/services"],
    ["/workspaces", "/worktrees"],
    ["/execution-workspaces/w-1/issues", "/execution-worktrees/w-1/issues"],
  ])("redirects %s and preserves suffixes", (pathname, expectedPathname) => {
    expect(legacyWorktreeRouteTarget({ pathname, search: "?tab=logs", hash: "#tail" })).toBe(
      `${expectedPathname}?tab=logs#tail`,
    );
  });
});
