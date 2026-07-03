import { describe, expect, it } from "vitest";
import {
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
} from "./execution-workspace-guards.js";

describe("isClosedIsolatedExecutionWorkspace", () => {
  it("returns false for null or undefined workspaces", () => {
    expect(isClosedIsolatedExecutionWorkspace(null)).toBe(false);
    expect(isClosedIsolatedExecutionWorkspace(undefined)).toBe(false);
  });

  it("returns false for non-isolated workspaces even when archived", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "shared_workspace", status: "archived", closedAt: new Date() }),
    ).toBe(false);
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "operator_branch", status: "cleanup_failed", closedAt: null }),
    ).toBe(false);
  });

  it("returns false for an open isolated workspace", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "isolated_workspace", status: "active", closedAt: null }),
    ).toBe(false);
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "isolated_workspace", status: "in_review", closedAt: null }),
    ).toBe(false);
  });

  it("treats a set closedAt as closed regardless of status", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "isolated_workspace", status: "active", closedAt: new Date() }),
    ).toBe(true);
  });

  it("treats archived and cleanup_failed statuses as closed even without closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "isolated_workspace", status: "archived", closedAt: null }),
    ).toBe(true);
    expect(
      isClosedIsolatedExecutionWorkspace({ mode: "isolated_workspace", status: "cleanup_failed", closedAt: null }),
    ).toBe(true);
  });
});

describe("getClosedIsolatedExecutionWorkspaceMessage", () => {
  it("interpolates the workspace name", () => {
    const message = getClosedIsolatedExecutionWorkspaceMessage({ name: "Feature Sprint" });
    expect(message).toContain('"Feature Sprint"');
    expect(message).toContain("closed workspace");
  });
});
