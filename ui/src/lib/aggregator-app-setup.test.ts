import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { aggregatorAppSetupTask, aggregatorSetupAgent } from "./aggregator-app-setup";

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return { id, name: id, role: "general", status: "active", reportsTo: null, createdAt: new Date("2026-01-01"), ...overrides } as Agent;
}

describe("aggregator setup task assignee", () => {
  it("prefers a named Default agent over other agents", () => {
    expect(aggregatorSetupAgent([
      agent("ceo", { role: "ceo", createdAt: new Date(0) }),
      agent("default", { name: " Default Agent ", reportsTo: "ceo" }),
    ])?.id).toBe("default");
  });

  it("chooses the highest ranking default and then the oldest at that rank", () => {
    const agents = [
      agent("new", { name: "Default agent", createdAt: new Date("2026-09-01") }),
      agent("report", { name: "Default agent", reportsTo: "old", createdAt: new Date(0) }),
      agent("old", { name: "Default agent" }),
    ];
    expect(aggregatorSetupAgent(agents)?.id).toBe("old");
    expect(aggregatorSetupAgent([...agents].reverse())?.id).toBe("old");
  });

  it("falls back to leadership, then age and a stable ID when no default exists", () => {
    expect(aggregatorSetupAgent([agent("engineer", { createdAt: new Date(0) }), agent("ceo", { role: "ceo" })])?.id).toBe("ceo");
    expect(aggregatorSetupAgent([agent("new", { createdAt: new Date("2026-09-01") }), agent("old")])?.id).toBe("old");
    expect(aggregatorSetupAgent([agent("b"), agent("a")])?.id).toBe("a");
  });

  it("skips agents the task picker cannot assign", () => {
    expect(aggregatorSetupAgent([
      agent("terminated", { name: "Default agent", status: "terminated" }),
      agent("pending", { name: "Default agent", status: "pending_approval" }),
      agent("invalid", { name: "Default agent", orgChainHealth: { status: "invalid_org_chain" } as Agent["orgChainHealth"] }),
      agent("available"),
    ])?.id).toBe("available");
    expect(aggregatorSetupAgent([])).toBeUndefined();
  });

  it("preselects the chosen agent for either provider without mutating the roster", () => {
    const agents = [agent("b"), agent("a")];
    for (const provider of ["composio", "arcade"] as const) {
      expect(aggregatorAppSetupTask("Circleback", { provider, toolkit: "circleback", logoUrl: "https://example.com/logo.png", docsUrl: "https://example.com/docs" }, undefined, agents)).toMatchObject({ assigneeAgentId: "a", navigateOnCreate: true });
    }
    expect(agents.map(({ id }) => id)).toEqual(["b", "a"]);
  });
});
