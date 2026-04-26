import { describe, expect, it } from "vitest";
import {
  isClosedIsolatedExecutionWorkspace,
  getClosedIsolatedExecutionWorkspaceMessage,
} from "./execution-workspace-guards.js";

// ============================================================================
// isClosedIsolatedExecutionWorkspace
// ============================================================================

describe("isClosedIsolatedExecutionWorkspace", () => {
  it("returns false for null", () => {
    expect(isClosedIsolatedExecutionWorkspace(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isClosedIsolatedExecutionWorkspace(undefined)).toBe(false);
  });

  it("returns false when mode is not isolated_workspace", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "shared_workspace",
        closedAt: new Date("2024-01-01T00:00:00Z"),
        status: "archived",
      }),
    ).toBe(false);
  });

  it("returns true when mode is isolated_workspace and closedAt is set", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        closedAt: new Date("2024-01-01T00:00:00Z"),
        status: "active",
      }),
    ).toBe(true);
  });

  it("returns true when mode is isolated_workspace and status is archived", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        closedAt: null,
        status: "archived",
      }),
    ).toBe(true);
  });

  it("returns true when mode is isolated_workspace and status is cleanup_failed", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        closedAt: null,
        status: "cleanup_failed",
      }),
    ).toBe(true);
  });

  it("returns false when mode is isolated_workspace but closedAt is null and status is active", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace",
        closedAt: null,
        status: "active",
      }),
    ).toBe(false);
  });
});

// ============================================================================
// getClosedIsolatedExecutionWorkspaceMessage
// ============================================================================

describe("getClosedIsolatedExecutionWorkspaceMessage", () => {
  it("includes the workspace name in the message", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "my-workspace" });
    expect(msg).toContain("my-workspace");
  });

  it("mentions the workspace is closed", () => {
    const msg = getClosedIsolatedExecutionWorkspaceMessage({ name: "my-workspace" });
    expect(msg.toLowerCase()).toContain("closed");
  });
});
