import { describe, expect, it } from "vitest";

import type { Agent } from "@paperclipai/shared";

import { buildAgentTree, flattenAgentTree } from "./agentTree";

function agent(id: string, reportsTo: string | null, name = id): Agent {
  const now = new Date("2026-08-19T00:00:00.000Z");
  return {
    id,
    companyId: "c1",
    name,
    urlKey: id,
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
  } as Agent;
}

const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);

describe("buildAgentTree", () => {
  it("nests reports under their manager and marks CEOs (no manager) as roots", () => {
    const ceo = agent("ceo", null);
    const lead = agent("lead", "ceo");
    const ic = agent("ic", "lead");

    const tree = buildAgentTree([ic, lead, ceo]);

    expect(tree).toHaveLength(1);
    expect(tree[0].agent.id).toBe("ceo");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].reports[0].agent.id).toBe("lead");
    expect(tree[0].reports[0].depth).toBe(1);
    expect(tree[0].reports[0].reports[0].agent.id).toBe("ic");
    expect(tree[0].reports[0].reports[0].depth).toBe(2);
  });

  it("treats a dangling manager pointer as a root so the agent stays visible", () => {
    const orphan = agent("orphan", "ghost-manager-not-in-list");
    const tree = buildAgentTree([orphan]);
    expect(tree).toHaveLength(1);
    expect(tree[0].agent.id).toBe("orphan");
    expect(tree[0].depth).toBe(0);
  });

  it("keeps every agent visible even under a pure reportsTo cycle", () => {
    const a = agent("a", "b");
    const b = agent("b", "a");
    const flat = flattenAgentTree(buildAgentTree([a, b]));
    expect(flat.map((n) => n.agent.id).sort()).toEqual(["a", "b"]);
  });

  it("orders siblings with the provided comparator (sort mode preserved)", () => {
    const ceo = agent("ceo", null, "Zeus");
    const alice = agent("alice", "ceo", "Alice");
    const bob = agent("bob", "ceo", "Bob");

    const flat = flattenAgentTree(buildAgentTree([bob, alice, ceo], byName));
    expect(flat.map((n) => n.agent.name)).toEqual(["Zeus", "Alice", "Bob"]);
  });

  it("supports multiple CEOs (forest)", () => {
    const tree = buildAgentTree(
      [agent("c2", null, "C2"), agent("c1", null, "C1"), agent("r1", "c1", "R1")],
      byName,
    );
    expect(tree.map((n) => n.agent.name)).toEqual(["C1", "C2"]);
    expect(tree[0].reports[0].agent.name).toBe("R1");
  });
});
