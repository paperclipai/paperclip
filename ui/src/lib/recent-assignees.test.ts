import { describe, expect, it } from "vitest";
import { sortAgentsByRecency } from "./recent-assignees.js";

// sortAgentsByRecency is a pure function that does not depend on localStorage.

describe("sortAgentsByRecency", () => {
  const agents = [
    { id: "agent-1", name: "Alice" },
    { id: "agent-2", name: "Bob" },
    { id: "agent-3", name: "Carol" },
  ];

  it("sorts agents with recent IDs to the front in recency order", () => {
    const result = sortAgentsByRecency(agents, ["agent-3", "agent-1"]);
    expect(result[0]?.id).toBe("agent-3");
    expect(result[1]?.id).toBe("agent-1");
    expect(result[2]?.id).toBe("agent-2");
  });

  it("agents not in recentIds are sorted by name alphabetically after recent ones", () => {
    const result = sortAgentsByRecency(
      [
        { id: "z-agent", name: "Zara" },
        { id: "a-agent", name: "Aaron" },
        { id: "recent", name: "Recent" },
      ],
      ["recent"],
    );
    expect(result[0]?.id).toBe("recent");
    expect(result[1]?.id).toBe("a-agent");
    expect(result[2]?.id).toBe("z-agent");
  });

  it("returns all agents sorted alphabetically when recentIds is empty", () => {
    const result = sortAgentsByRecency(agents, []);
    expect(result.map((a) => a.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("returns an empty array when agents is empty", () => {
    expect(sortAgentsByRecency([], ["agent-1"])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const original = [...agents];
    sortAgentsByRecency(agents, ["agent-2"]);
    expect(agents).toEqual(original);
  });

  it("handles recentIds with IDs not present in agents (ignored)", () => {
    const result = sortAgentsByRecency(agents, ["nonexistent", "agent-2"]);
    expect(result[0]?.id).toBe("agent-2");
  });

  it("maintains relative recent order when multiple agents are recent", () => {
    const result = sortAgentsByRecency(agents, ["agent-2", "agent-3", "agent-1"]);
    expect(result[0]?.id).toBe("agent-2");
    expect(result[1]?.id).toBe("agent-3");
    expect(result[2]?.id).toBe("agent-1");
  });
});
