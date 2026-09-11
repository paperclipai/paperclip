import { describe, expect, it } from "vitest";
import { isClosedIsolatedExecutionWorkspace } from "../execution-workspace-guards.js";

describe("isClosedIsolatedExecutionWorkspace", () => {
  it("returns false for null/undefined", () => {
    expect(isClosedIsolatedExecutionWorkspace(null)).toBe(false);
    expect(isClosedIsolatedExecutionWorkspace(undefined)).toBe(false);
  });

  it("returns false for non-isolated workspace modes", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "shared_workspace" as const,
        status: "archived" as const,
        closedAt: new Date(),
        name: "test",
      }),
    ).toBe(false);
  });

  it("returns true for archived status", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace" as const,
        status: "archived" as const,
        closedAt: null,
        name: "test",
      }),
    ).toBe(true);
  });

  it("returns true for cleanup_failed status", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace" as const,
        status: "cleanup_failed" as const,
        closedAt: null,
        name: "test",
      }),
    ).toBe(true);
  });

  it("returns true when closedAt is set even with active status", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace" as const,
        status: "active" as const,
        closedAt: new Date(),
        name: "test",
      }),
    ).toBe(true);
  });

  it("returns false for active status with null closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace" as const,
        status: "active" as const,
        closedAt: null,
        name: "test",
      }),
    ).toBe(false);
  });

  it("returns false for idle status with null closedAt", () => {
    expect(
      isClosedIsolatedExecutionWorkspace({
        mode: "isolated_workspace" as const,
        status: "idle" as const,
        closedAt: null,
        name: "test",
      }),
    ).toBe(false);
  });
});
