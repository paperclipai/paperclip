import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import {
  buildSidebarAgentTree,
  collectExpandableSidebarAgentIds,
  normalizeExpandedSidebarAgentIds,
} from "./sidebar-agent-tree";

function makeAgent(id: string, name: string, reportsTo: string | null = null): Agent {
  return {
    id,
    companyId: "company-1",
    name,
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    urlKey: name.toLowerCase(),
  };
}

describe("buildSidebarAgentTree", () => {
  it("nests reports under their manager while preserving sibling order", () => {
    const ceo = makeAgent("agent-1", "CEO");
    const cto = makeAgent("agent-2", "CTO", ceo.id);
    const cmo = makeAgent("agent-3", "CMO", ceo.id);
    const engineer = makeAgent("agent-4", "Engineer", cto.id);

    const tree = buildSidebarAgentTree([ceo, cmo, cto, engineer]);

    expect(tree.map((node) => node.agent.name)).toEqual(["CEO"]);
    expect(tree[0]?.children.map((node) => node.agent.name)).toEqual(["CMO", "CTO"]);
    expect(tree[0]?.children[1]?.children.map((node) => node.agent.name)).toEqual(["Engineer"]);
  });

  it("keeps agents with missing managers visible at the root", () => {
    const orphan = makeAgent("agent-1", "Orphan", "missing-manager");
    const root = makeAgent("agent-2", "Root");

    const tree = buildSidebarAgentTree([orphan, root]);

    expect(tree.map((node) => node.agent.name)).toEqual(["Orphan", "Root"]);
  });
});

describe("sidebar agent tree expansion helpers", () => {
  it("returns only managers as expandable ids", () => {
    const ceo = makeAgent("agent-1", "CEO");
    const cto = makeAgent("agent-2", "CTO", ceo.id);
    const engineer = makeAgent("agent-3", "Engineer", cto.id);
    const tree = buildSidebarAgentTree([ceo, cto, engineer]);

    expect(collectExpandableSidebarAgentIds(tree)).toEqual([ceo.id, cto.id]);
  });

  it("forces the active agent ancestor chain to stay expanded", () => {
    const ceo = makeAgent("agent-1", "CEO");
    const cto = makeAgent("agent-2", "CTO", ceo.id);
    const engineer = makeAgent("agent-3", "Engineer", cto.id);
    const tree = buildSidebarAgentTree([ceo, cto, engineer]);

    expect(normalizeExpandedSidebarAgentIds(tree, [], engineer.id)).toEqual([ceo.id, cto.id]);
  });

  it("filters out ids that are not expandable managers", () => {
    const ceo = makeAgent("agent-1", "CEO");
    const cto = makeAgent("agent-2", "CTO", ceo.id);
    const engineer = makeAgent("agent-3", "Engineer", cto.id);
    const tree = buildSidebarAgentTree([ceo, cto, engineer]);

    expect(normalizeExpandedSidebarAgentIds(tree, [engineer.id, "missing", ceo.id], null)).toEqual([ceo.id]);
  });
});
