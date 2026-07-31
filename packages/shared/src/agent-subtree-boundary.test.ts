import { describe, expect, it } from "vitest";
import {
  AGENT_SUBTREE_MAX_DEPTH,
  agentIsInSubtree,
  agentIsWithinIssueWriteBoundary,
  type AgentSubtreeNode,
} from "./agent-eligibility.js";

// Org chart used across the boundary tests:
//   ceo (root)
//   ├── cto
//   │   └── eng
//   └── da
function orgChart(): Map<string, AgentSubtreeNode> {
  return new Map<string, AgentSubtreeNode>([
    ["ceo", { id: "ceo", reportsTo: null }],
    ["cto", { id: "cto", reportsTo: "ceo" }],
    ["eng", { id: "eng", reportsTo: "cto" }],
    ["da", { id: "da", reportsTo: "ceo" }],
  ]);
}

describe("agentIsInSubtree", () => {
  it("treats an agent as inside its own subtree", () => {
    expect(agentIsInSubtree(orgChart(), "cto", "cto")).toBe(true);
  });

  it("includes transitive reports of the root", () => {
    const org = orgChart();
    expect(agentIsInSubtree(org, "ceo", "cto")).toBe(true);
    expect(agentIsInSubtree(org, "ceo", "eng")).toBe(true);
    expect(agentIsInSubtree(org, "cto", "eng")).toBe(true);
  });

  it("excludes ancestors and siblings", () => {
    const org = orgChart();
    // A subordinate is not in a subordinate-rooted subtree of its manager.
    expect(agentIsInSubtree(org, "eng", "cto")).toBe(false);
    // Siblings are unrelated.
    expect(agentIsInSubtree(org, "da", "cto")).toBe(false);
  });

  it("returns false for agents missing from the hierarchy", () => {
    expect(agentIsInSubtree(orgChart(), "cto", "ghost")).toBe(false);
  });

  it("terminates on reporting cycles instead of looping forever", () => {
    const cyclic = new Map<string, AgentSubtreeNode>([
      ["a", { id: "a", reportsTo: "b" }],
      ["b", { id: "b", reportsTo: "a" }],
    ]);
    expect(agentIsInSubtree(cyclic, "root", "a")).toBe(false);
  });

  it("stops walking after the maximum depth", () => {
    // Build a chain longer than the guard depth; the far end must not resolve
    // to a root beyond the depth limit.
    const chain = new Map<string, AgentSubtreeNode>();
    const length = AGENT_SUBTREE_MAX_DEPTH + 5;
    for (let i = 0; i < length; i += 1) {
      chain.set(`n${i}`, { id: `n${i}`, reportsTo: i === 0 ? null : `n${i - 1}` });
    }
    // The deepest node reports (transitively) to n0, but only within the depth
    // budget; beyond AGENT_SUBTREE_MAX_DEPTH hops the walk gives up.
    expect(agentIsInSubtree(chain, "n0", `n${length - 1}`)).toBe(false);
  });
});

describe("agentIsWithinIssueWriteBoundary", () => {
  it("is the exact deadlock guard: an out-of-boundary run agent is rejected", () => {
    // QUA-5362 / QUA-5364: a CTO run bound to a CEO-assigned issue is outside
    // the write boundary — this is the case the execution-binding guard must
    // catch before the run is dispatched.
    expect(agentIsWithinIssueWriteBoundary(orgChart(), "cto", "ceo")).toBe(false);
  });

  it("allows the assignee itself (allow_self)", () => {
    expect(agentIsWithinIssueWriteBoundary(orgChart(), "ceo", "ceo")).toBe(true);
    expect(agentIsWithinIssueWriteBoundary(orgChart(), "cto", "cto")).toBe(true);
  });

  it("allows a manager of the assignee", () => {
    const org = orgChart();
    expect(agentIsWithinIssueWriteBoundary(org, "ceo", "eng")).toBe(true);
    expect(agentIsWithinIssueWriteBoundary(org, "cto", "eng")).toBe(true);
  });

  it("rejects siblings and subordinates of the assignee", () => {
    const org = orgChart();
    expect(agentIsWithinIssueWriteBoundary(org, "da", "cto")).toBe(false);
    expect(agentIsWithinIssueWriteBoundary(org, "eng", "cto")).toBe(false);
  });

  it("treats an unassigned issue as an open boundary", () => {
    expect(agentIsWithinIssueWriteBoundary(orgChart(), "cto", null)).toBe(true);
  });
});
