// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getProjectOrderStorageKey, sortProjectsByStoredOrder } from "./project-order";
import type { Project } from "@paperclipai/shared";

// ============================================================================
// Minimal Project factory for testing sort functions
// ============================================================================

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    companyId: "company-1",
    description: null,
    status: "active",
    urlKey: id,
    color: null,
    iconName: null,
    issuePrefix: null,
    workspaceStrategyType: null,
    workspaceCwd: null,
    workspaceBranchTemplate: null,
    workspaceBaseRef: null,
    worktreeParentDir: null,
    repoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    deletedAt: null,
    billingCode: null,
  } as unknown as Project;
}

// ============================================================================
// getProjectOrderStorageKey
// ============================================================================

describe("getProjectOrderStorageKey", () => {
  it("generates a storage key with company and user id", () => {
    const key = getProjectOrderStorageKey("company-1", "user-1");
    expect(key).toContain("company-1");
    expect(key).toContain("user-1");
    expect(key).toMatch(/^paperclip\.projectOrder:/);
  });

  it("uses 'anonymous' when userId is null", () => {
    const key = getProjectOrderStorageKey("company-1", null);
    expect(key).toContain("anonymous");
  });

  it("uses 'anonymous' when userId is undefined", () => {
    const key = getProjectOrderStorageKey("company-1", undefined);
    expect(key).toContain("anonymous");
  });

  it("uses 'anonymous' when userId is empty string", () => {
    const key = getProjectOrderStorageKey("company-1", "");
    expect(key).toContain("anonymous");
  });

  it("trims whitespace from userId", () => {
    const key = getProjectOrderStorageKey("company-1", "  user-2  ");
    expect(key).toContain("user-2");
    expect(key).not.toContain("  ");
  });

  it("produces different keys for different companies", () => {
    const key1 = getProjectOrderStorageKey("company-1", "user-1");
    const key2 = getProjectOrderStorageKey("company-2", "user-1");
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different users", () => {
    const key1 = getProjectOrderStorageKey("company-1", "user-1");
    const key2 = getProjectOrderStorageKey("company-1", "user-2");
    expect(key1).not.toBe(key2);
  });
});

// ============================================================================
// sortProjectsByStoredOrder
// ============================================================================

describe("sortProjectsByStoredOrder", () => {
  it("returns an empty array for empty input", () => {
    expect(sortProjectsByStoredOrder([], ["id-1"])).toEqual([]);
  });

  it("returns projects in original order when orderedIds is empty", () => {
    const projects = [makeProject("b", "B"), makeProject("a", "A"), makeProject("c", "C")];
    const sorted = sortProjectsByStoredOrder(projects, []);
    // No reordering when orderedIds is empty
    expect(sorted.map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("places stored-order IDs first in the given order", () => {
    const projects = [
      makeProject("alpha", "Alpha"),
      makeProject("beta", "Beta"),
      makeProject("gamma", "Gamma"),
    ];
    const sorted = sortProjectsByStoredOrder(projects, ["gamma", "beta"]);
    expect(sorted[0]?.id).toBe("gamma");
    expect(sorted[1]?.id).toBe("beta");
    expect(sorted[2]?.id).toBe("alpha");
  });

  it("ignores stored IDs that don't match any project", () => {
    const projects = [makeProject("a", "A"), makeProject("b", "B")];
    const sorted = sortProjectsByStoredOrder(projects, ["nonexistent", "b"]);
    expect(sorted[0]?.id).toBe("b");
    expect(sorted).toHaveLength(2);
  });

  it("appends unordered projects at the end in original input order", () => {
    const projects = [
      makeProject("alpha", "Alpha"),
      makeProject("beta", "Beta"),
      makeProject("gamma", "Gamma"),
    ];
    // Only gamma is explicitly ordered; alpha and beta go at end in input order
    const sorted = sortProjectsByStoredOrder(projects, ["gamma"]);
    expect(sorted[0]?.id).toBe("gamma");
    expect(sorted[1]?.id).toBe("alpha");
    expect(sorted[2]?.id).toBe("beta");
  });

  it("handles a single project", () => {
    const projects = [makeProject("solo", "Solo")];
    expect(sortProjectsByStoredOrder(projects, ["solo"])).toHaveLength(1);
    expect(sortProjectsByStoredOrder(projects, ["solo"])[0]?.id).toBe("solo");
  });

  it("handles all projects being in stored order", () => {
    const projects = [makeProject("a", "A"), makeProject("b", "B"), makeProject("c", "C")];
    const sorted = sortProjectsByStoredOrder(projects, ["c", "a", "b"]);
    expect(sorted.map((p) => p.id)).toEqual(["c", "a", "b"]);
  });
});
