import { describe, expect, it } from "vitest";
import { layoutHierarchy } from "./auto-layout";
import {
  commitNodePositions,
  defaultAgentGraphLayout,
  pruneLayout,
  syncEdges,
  syncNodes,
  type GraphAgent,
  type GraphFlowNode,
} from "./graph-nodes";
import { syntheticOrg } from "./synthetic-org";

function agents(count: number): GraphAgent[] {
  return syntheticOrg(count).map((member, index) => ({
    ...member,
    name: `Agent ${index}`,
    urlKey: `agent-${index}`,
    role: "engineer",
    title: null,
    status: "idle",
    adapterType: "claude_local",
    budgetMonthlyCents: 10_000,
    spentMonthlyCents: index,
  }));
}

function changedCount(before: readonly unknown[], after: readonly unknown[]): number {
  const seen = new Set(before);
  let changed = 0;
  for (const item of after) if (!seen.has(item)) changed += 1;
  return changed;
}

describe("syncNodes with 250 agents", () => {
  const roster = agents(250);
  const layout = defaultAgentGraphLayout();
  const autoPositions = layoutHierarchy(roster);
  const base = { agents: roster, layout, autoPositions, liveAgentIds: new Set<string>() };
  const nodes = syncNodes([], base);
  const edges = syncEdges([], base);

  it("builds one node per agent and one edge per reporting line", () => {
    expect(nodes).toHaveLength(250);
    expect(edges).toHaveLength(249);
  });

  it("keeps the position of a node that is being dragged when live data changes", () => {
    const dragged = roster[7]!;
    const idle = roster[9]!;
    const moving = nodes.map((node) => {
      if (node.id === dragged.id) return { ...node, dragging: true, position: { x: 4_321, y: 1_234 } };
      if (node.id === idle.id) return { ...node, position: { x: 9_999, y: 9_999 } };
      return node;
    });
    const next = syncNodes(moving, { ...base, liveAgentIds: new Set([dragged.id]) });
    const draggedNode = next.find((node) => node.id === dragged.id)!;
    expect(draggedNode.position).toEqual({ x: 4_321, y: 1_234 });
    expect(draggedNode.dragging).toBe(true);
    expect(draggedNode.data).toMatchObject({ live: true });
    expect(next.find((node) => node.id === idle.id)!.position).toEqual(autoPositions.get(idle.id));

    const unchanged = syncNodes(moving, { ...base, agents: roster.map((agent) => ({ ...agent })) });
    expect(unchanged.find((node) => node.id === dragged.id)).toBe(moving.find((node) => node.id === dragged.id));
  });

  it("returns the same arrays when nothing changed, even with a refetched roster", () => {
    const refetched = roster.map((agent) => ({ ...agent }));
    expect(syncNodes(nodes, { ...base, agents: refetched })).toBe(nodes);
    expect(syncEdges(edges, { ...base, agents: refetched })).toBe(edges);
  });

  it("replaces only the node of the agent whose live status changed", () => {
    const updated = roster.map((agent, index) => (index === 123 ? { ...agent, status: "running" } : { ...agent }));
    const nextNodes = syncNodes(nodes, { ...base, agents: updated });
    const nextEdges = syncEdges(edges, { ...base, agents: updated });
    expect(changedCount(nodes, nextNodes)).toBe(1);
    expect(changedCount(edges, nextEdges)).toBe(1);
    expect(nextNodes.find((node) => node.id === roster[123]!.id)?.data).toMatchObject({ live: true });
  });

  it("replaces only the node that went live through the live-run set", () => {
    const nextNodes = syncNodes(nodes, { ...base, liveAgentIds: new Set([roster[7]!.id]) });
    expect(changedCount(nodes, nextNodes)).toBe(1);
  });

  it("keeps selection and measured size when a node is replaced", () => {
    const selected = nodes.map((node, index) =>
      index === 5 ? ({ ...node, selected: true, measured: { width: 224, height: 96 } } as GraphFlowNode) : node,
    );
    const updated = roster.map((agent, index) => (index === 5 ? { ...agent, status: "error" } : agent));
    const next = syncNodes(selected, { ...base, agents: updated });
    expect(next[5]).toMatchObject({ selected: true, measured: { width: 224, height: 96 } });
  });

  it("moves only manually positioned nodes and hides hidden agents with their edges", () => {
    const moved = { ...layout, positions: { [roster[10]!.id]: { x: 999, y: 999 } } };
    const afterMove = syncNodes(nodes, { ...base, layout: moved });
    expect(changedCount(nodes, afterMove)).toBe(1);
    const hiddenLayout = { ...layout, hiddenAgentIds: [roster[1]!.id] };
    expect(syncNodes(nodes, { ...base, layout: hiddenLayout })).toHaveLength(249);
    expect(syncEdges(edges, { ...base, layout: hiddenLayout })).toHaveLength(249 - 1 - 6);
  });

  it("adds stickies and drafts as their own node types with a dashed reporting edge", () => {
    const withExtras = {
      ...layout,
      stickies: [{ id: "s1", x: 0, y: 0, width: 200, height: 120, text: "note", color: "yellow" as const }],
      drafts: [{
        id: "d1", x: 10, y: 10, name: "Copy", role: "engineer", title: null, capabilities: null,
        adapterType: "claude_local", model: null, reportsTo: roster[0]!.id, sourceAgentId: roster[3]!.id,
      }],
    };
    const next = syncNodes(nodes, { ...base, layout: withExtras });
    expect(next.map((node) => node.type).filter((type) => type !== "agent")).toEqual(["sticky", "draft"]);
    expect(changedCount(nodes, next)).toBe(2);
    expect(next.at(-1)?.data).toMatchObject({ managerName: "Agent 0" });
    expect(syncEdges(edges, { ...base, layout: withExtras })).toHaveLength(250);
  });
});

describe("syncNodes while a note or a draft is dragged", () => {
  it("keeps the dragged position until the drag is committed", () => {
    const roster = agents(6);
    const sticky = { id: "note", x: 10, y: 20, width: 200, height: 120, text: "", color: "yellow" as const };
    const draft = {
      id: "draft", x: 30, y: 40, name: "Copy", role: "engineer", title: null, capabilities: null,
      adapterType: "claude_local", model: null, reportsTo: null, sourceAgentId: null,
    };
    const layout = { ...defaultAgentGraphLayout(), stickies: [sticky], drafts: [draft] };
    const input = { agents: roster, layout, autoPositions: layoutHierarchy(roster), liveAgentIds: new Set<string>(), managerNames: new Map<string, string>() };
    const moving = syncNodes([], input).map((node) =>
      node.type === "agent" ? node : { ...node, dragging: true, position: { x: 777, y: 888 } }) as GraphFlowNode[];
    const next = syncNodes(moving, { ...input, liveAgentIds: new Set([roster[2]!.id]) });
    expect(next.filter((node) => node.type !== "agent").map((node) => node.position)).toEqual([{ x: 777, y: 888 }, { x: 777, y: 888 }]);
    const released = syncNodes(moving.map((node) => ({ ...node, dragging: false })) as GraphFlowNode[], input);
    expect(released.filter((node) => node.type !== "agent").map((node) => node.position)).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });
});

describe("pruneLayout", () => {
  it("drops positions and hidden ids of agents that no longer exist", () => {
    const layout = {
      ...defaultAgentGraphLayout(),
      positions: { a: { x: 1, y: 1 }, gone: { x: 2, y: 2 } },
      hiddenAgentIds: ["gone", "a"],
    };
    expect(pruneLayout(layout, new Set(["a"]))).toMatchObject({ positions: { a: { x: 1, y: 1 } }, hiddenAgentIds: ["a"] });
    const clean = { ...defaultAgentGraphLayout(), positions: { a: { x: 1, y: 1 } } };
    expect(pruneLayout(clean, new Set(["a"]))).toBe(clean);
  });
});

describe("commitNodePositions with a filtered roster", () => {
  const roster = agents(6);
  const companyAgentIds = new Set(roster.map((agent) => agent.id));
  const outsideFilter = roster[5]!.id;
  const hiddenOutsideFilter = roster[4]!.id;
  const saved = {
    ...defaultAgentGraphLayout(),
    positions: { [outsideFilter]: { x: 700, y: 700 }, [roster[1]!.id]: { x: 10, y: 10 } },
    hiddenAgentIds: [hiddenOutsideFilter],
  };
  const filtered = roster.slice(0, 3);
  const autoPositions = layoutHierarchy(filtered);
  const nodes = syncNodes([], { agents: filtered, layout: saved, autoPositions, liveAgentIds: new Set<string>() });

  it("keeps positions and hidden ids of agents outside the filter when a visible node moves", () => {
    const moved = nodes.map((node) => (node.id === roster[2]!.id ? { ...node, position: { x: 321, y: 123 } } : node)) as GraphFlowNode[];
    const next = commitNodePositions(saved, moved, autoPositions, companyAgentIds);
    expect(next.positions).toEqual({
      [outsideFilter]: { x: 700, y: 700 },
      [roster[1]!.id]: { x: 10, y: 10 },
      [roster[2]!.id]: { x: 321, y: 123 },
    });
    expect(next.hiddenAgentIds).toEqual([hiddenOutsideFilter]);
  });

  it("would lose them if it pruned against the filtered roster", () => {
    const moved = nodes.map((node) => (node.id === roster[2]!.id ? { ...node, position: { x: 321, y: 123 } } : node)) as GraphFlowNode[];
    const visibleOnly = new Set(filtered.map((agent) => agent.id));
    const lossy = commitNodePositions(saved, moved, autoPositions, visibleOnly);
    expect(lossy.positions).not.toHaveProperty(outsideFilter);
    expect(lossy.hiddenAgentIds).toEqual([]);
  });

  it("still drops agents that left the company and returns the same layout when nothing moved", () => {
    const withGone = { ...saved, positions: { ...saved.positions, gone: { x: 1, y: 1 } } };
    const moved = nodes.map((node) => (node.id === roster[2]!.id ? { ...node, position: { x: 5, y: 5 } } : node)) as GraphFlowNode[];
    expect(commitNodePositions(withGone, moved, autoPositions, companyAgentIds).positions).not.toHaveProperty("gone");
    expect(commitNodePositions(saved, nodes, autoPositions, companyAgentIds)).toBe(saved);
  });
});
