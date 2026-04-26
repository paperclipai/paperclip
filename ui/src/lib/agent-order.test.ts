// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getAgentOrderStorageKey, sortAgentsByDefaultSidebarOrder, sortAgentsByStoredOrder } from "./agent-order";
import type { Agent } from "@paperclipai/shared";

// ============================================================================
// Minimal Agent factory for testing sort functions
// ============================================================================

function makeAgent(id: string, name: string, reportsTo: string | null = null): Agent {
  return {
    id,
    name,
    reportsTo,
    companyId: "company-1",
    role: "worker",
    kind: "instance",
    adapterType: "claude_local",
    adapterConfig: {},
    shortName: name,
    description: null,
    status: "active",
    urlKey: id,
    iconName: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    pausedAt: null,
    archivedAt: null,
    deletedAt: null,
    budgetUsedPct: 0,
    budgetCycleStart: null,
    budgetCycleEnd: null,
    budgetAmountUsd: null,
    ceoAgentId: null,
    chainOfCommand: [],
    primaryAgentId: null,
  } as unknown as Agent;
}

// ============================================================================
// getAgentOrderStorageKey
// ============================================================================

describe("getAgentOrderStorageKey", () => {
  it("generates a storage key with company and user id", () => {
    const key = getAgentOrderStorageKey("company-1", "user-1");
    expect(key).toContain("company-1");
    expect(key).toContain("user-1");
    expect(key).toMatch(/^paperclip\.agentOrder:/);
  });

  it("uses 'anonymous' when userId is null", () => {
    const key = getAgentOrderStorageKey("company-1", null);
    expect(key).toContain("anonymous");
  });

  it("uses 'anonymous' when userId is undefined", () => {
    const key = getAgentOrderStorageKey("company-1", undefined);
    expect(key).toContain("anonymous");
  });

  it("uses 'anonymous' when userId is empty string", () => {
    const key = getAgentOrderStorageKey("company-1", "");
    expect(key).toContain("anonymous");
  });

  it("trims whitespace from userId", () => {
    const key = getAgentOrderStorageKey("company-1", "  user-2  ");
    expect(key).toContain("user-2");
    expect(key).not.toContain("  ");
  });
});

// ============================================================================
// sortAgentsByDefaultSidebarOrder
// ============================================================================

describe("sortAgentsByDefaultSidebarOrder", () => {
  it("returns an empty array for empty input", () => {
    expect(sortAgentsByDefaultSidebarOrder([])).toEqual([]);
  });

  it("sorts root-level agents alphabetically", () => {
    const agents = [
      makeAgent("c", "Charlie"),
      makeAgent("a", "Alice"),
      makeAgent("b", "Bob"),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    expect(sorted.map((a) => a.name)).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("places children after their parent (BFS order)", () => {
    const agents = [
      makeAgent("child", "Child Agent", "parent"),
      makeAgent("parent", "Parent Agent"),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    const parentIdx = sorted.findIndex((a) => a.id === "parent");
    const childIdx = sorted.findIndex((a) => a.id === "child");
    expect(parentIdx).toBeLessThan(childIdx);
  });

  it("treats agents with non-existent parent as root", () => {
    const agents = [
      makeAgent("orphan", "Orphan", "nonexistent-parent"),
      makeAgent("root", "Root"),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    // Both should appear in the result
    expect(sorted).toHaveLength(2);
  });

  it("sorts multiple children alphabetically under their parent", () => {
    const agents = [
      makeAgent("child-c", "Charlie Child", "parent"),
      makeAgent("child-a", "Alice Child", "parent"),
      makeAgent("parent", "Parent"),
    ];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    const childAlice = sorted.findIndex((a) => a.id === "child-a");
    const childCharlie = sorted.findIndex((a) => a.id === "child-c");
    expect(childAlice).toBeLessThan(childCharlie);
  });

  it("handles a single agent", () => {
    const agents = [makeAgent("solo", "Solo Agent")];
    const sorted = sortAgentsByDefaultSidebarOrder(agents);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]?.id).toBe("solo");
  });

  it("does not mutate the original array", () => {
    const agents = [makeAgent("b", "B"), makeAgent("a", "A")];
    const copy = [...agents];
    sortAgentsByDefaultSidebarOrder(agents);
    expect(agents[0]?.id).toBe(copy[0]?.id);
    expect(agents[1]?.id).toBe(copy[1]?.id);
  });
});

// ============================================================================
// sortAgentsByStoredOrder
// ============================================================================

describe("sortAgentsByStoredOrder", () => {
  it("returns empty array for empty agents", () => {
    expect(sortAgentsByStoredOrder([], ["id-1"])).toEqual([]);
  });

  it("returns default sorted order when orderedIds is empty", () => {
    const agents = [makeAgent("b", "B"), makeAgent("a", "A")];
    const sorted = sortAgentsByStoredOrder(agents, []);
    expect(sorted.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("places stored-order IDs first in the given order", () => {
    const agents = [makeAgent("a", "A"), makeAgent("b", "B"), makeAgent("c", "C")];
    const sorted = sortAgentsByStoredOrder(agents, ["c", "b"]);
    expect(sorted[0]?.id).toBe("c");
    expect(sorted[1]?.id).toBe("b");
    // "a" should still appear, after the stored-order agents
    expect(sorted[2]?.id).toBe("a");
  });

  it("ignores stored IDs that don't match any agent", () => {
    const agents = [makeAgent("a", "A"), makeAgent("b", "B")];
    const sorted = sortAgentsByStoredOrder(agents, ["nonexistent", "b"]);
    expect(sorted[0]?.id).toBe("b");
    expect(sorted).toHaveLength(2);
  });

  it("appends unstored agents in default sort order after stored ones", () => {
    const agents = [
      makeAgent("charlie", "Charlie"),
      makeAgent("alice", "Alice"),
      makeAgent("bob", "Bob"),
    ];
    const sorted = sortAgentsByStoredOrder(agents, ["charlie"]);
    expect(sorted[0]?.id).toBe("charlie");
    // Remaining agents should be in alphabetical order
    expect(sorted[1]?.name).toBe("Alice");
    expect(sorted[2]?.name).toBe("Bob");
  });
});
