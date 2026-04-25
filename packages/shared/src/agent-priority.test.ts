import { describe, expect, it } from "vitest";
import {
  agentPriorityTierRank,
  bumpAgentPriorityTier,
  isAgentPriorityTier,
  readAgentPriorityTier,
  resolveDefaultAgentPriorityTier,
} from "./agent-priority.js";

describe("isAgentPriorityTier", () => {
  it.each([
    ["p0", true],
    ["p1", true],
    ["p2", true],
    ["p3", true],
    ["p4", false],
    ["", false],
    [null, false],
    [undefined, false],
    [123, false],
  ])("treats %p as %p", (input, expected) => {
    expect(isAgentPriorityTier(input)).toBe(expected);
  });
});

describe("resolveDefaultAgentPriorityTier", () => {
  it("returns role-based defaults", () => {
    expect(resolveDefaultAgentPriorityTier({ role: "ceo", name: "CEO" })).toBe(
      "p0",
    );
    expect(
      resolveDefaultAgentPriorityTier({ role: "engineer", name: "Engineer" }),
    ).toBe("p1");
    expect(
      resolveDefaultAgentPriorityTier({ role: "pm", name: "PRDWriter" }),
    ).toBe("p2");
    expect(
      resolveDefaultAgentPriorityTier({
        role: "researcher",
        name: "TechResearcher",
      }),
    ).toBe("p3");
  });

  it("applies the InsightAnalyst name override even though role=researcher", () => {
    expect(
      resolveDefaultAgentPriorityTier({
        role: "researcher",
        name: "InsightAnalyst",
      }),
    ).toBe("p2");
    expect(
      resolveDefaultAgentPriorityTier({
        role: "researcher",
        name: "insight-analyst",
      }),
    ).toBe("p2");
    expect(
      resolveDefaultAgentPriorityTier({
        role: "researcher",
        name: "Insight Analyst",
      }),
    ).toBe("p2");
  });

  it("falls back to p2 for unknown role + name", () => {
    expect(
      resolveDefaultAgentPriorityTier({ role: "unknown", name: "Random" }),
    ).toBe("p2");
    expect(resolveDefaultAgentPriorityTier({ role: null, name: null })).toBe(
      "p2",
    );
  });
});

describe("readAgentPriorityTier", () => {
  it("prefers a stored valid tier over the default", () => {
    expect(
      readAgentPriorityTier(
        { priorityTier: "p0" },
        { role: "engineer", name: "Engineer" },
      ),
    ).toBe("p0");
  });

  it("ignores an invalid stored tier and falls back to defaults", () => {
    expect(
      readAgentPriorityTier(
        { priorityTier: "p9" },
        { role: "engineer", name: "Engineer" },
      ),
    ).toBe("p1");
  });

  it("handles null/undefined metadata", () => {
    expect(readAgentPriorityTier(null, { role: "ceo", name: "CEO" })).toBe(
      "p0",
    );
    expect(readAgentPriorityTier(undefined, { role: "ceo", name: "CEO" })).toBe(
      "p0",
    );
  });
});

describe("bumpAgentPriorityTier", () => {
  it("walks one step toward p0", () => {
    expect(bumpAgentPriorityTier("p3")).toBe("p2");
    expect(bumpAgentPriorityTier("p2")).toBe("p1");
    expect(bumpAgentPriorityTier("p1")).toBe("p0");
  });

  it("stays at p0", () => {
    expect(bumpAgentPriorityTier("p0")).toBe("p0");
  });
});

describe("agentPriorityTierRank", () => {
  it("orders p0 lowest (most-important)", () => {
    expect(agentPriorityTierRank("p0")).toBe(0);
    expect(agentPriorityTierRank("p1")).toBe(1);
    expect(agentPriorityTierRank("p2")).toBe(2);
    expect(agentPriorityTierRank("p3")).toBe(3);
  });
});
