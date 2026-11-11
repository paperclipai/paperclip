import type { Edge, Node } from "@xyflow/react";
import type { AgentGraphDraft, AgentGraphLayout, AgentGraphSticky } from "@paperclipai/shared";
import type { LayoutDirection, LayoutPoint } from "./auto-layout";

export interface GraphAgent {
  id: string;
  name: string;
  urlKey?: string | null;
  role: string;
  title: string | null;
  status: string;
  adapterType: string;
  reportsTo: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  appearance?: unknown;
}

export type AgentNodeData = {
  agent: GraphAgent;
  live: boolean;
  direction: LayoutDirection;
};
export type StickyNodeData = { sticky: AgentGraphSticky };
export type DraftNodeData = { draft: AgentGraphDraft; direction: LayoutDirection; managerName: string | null };

export type AgentFlowNode = Node<AgentNodeData, "agent">;
export type StickyFlowNode = Node<StickyNodeData, "sticky">;
export type DraftFlowNode = Node<DraftNodeData, "draft">;
export type GraphFlowNode = AgentFlowNode | StickyFlowNode | DraftFlowNode;

export const STICKY_NODE_PREFIX = "sticky:";
export const DRAFT_NODE_PREFIX = "draft:";
export const HIERARCHY_EDGE_PREFIX = "reports:";

export const stickyNodeId = (id: string) => `${STICKY_NODE_PREFIX}${id}`;
export const draftNodeId = (id: string) => `${DRAFT_NODE_PREFIX}${id}`;
export const hierarchyEdgeId = (agentId: string) => `${HIERARCHY_EDGE_PREFIX}${agentId}`;

function sameAgent(a: GraphAgent, b: GraphAgent): boolean {
  return a === b || (
    a.id === b.id
    && a.name === b.name
    && a.urlKey === b.urlKey
    && a.role === b.role
    && a.title === b.title
    && a.status === b.status
    && a.adapterType === b.adapterType
    && a.reportsTo === b.reportsTo
    && a.budgetMonthlyCents === b.budgetMonthlyCents
    && a.spentMonthlyCents === b.spentMonthlyCents
    && a.appearance === b.appearance
  );
}

function samePosition(node: Node, position: LayoutPoint): boolean {
  return node.position.x === position.x && node.position.y === position.y;
}

export interface SyncNodesInput {
  agents: readonly GraphAgent[];
  layout: AgentGraphLayout;
  autoPositions: ReadonlyMap<string, LayoutPoint>;
  liveAgentIds: ReadonlySet<string>;
  managerNames?: ReadonlyMap<string, string>;
}

export function syncNodes(previous: readonly GraphFlowNode[], input: SyncNodesInput): GraphFlowNode[] {
  const { agents, layout, autoPositions, liveAgentIds } = input;
  const previousById = new Map<string, GraphFlowNode>();
  for (const node of previous) previousById.set(node.id, node);
  const hidden = new Set(layout.hiddenAgentIds);
  let agentNames = input.managerNames;
  if (!agentNames) {
    const names = new Map<string, string>();
    for (const agent of agents) names.set(agent.id, agent.name);
    agentNames = names;
  }
  const next: GraphFlowNode[] = [];

  for (const sticky of layout.stickies) {
    const id = stickyNodeId(sticky.id);
    const prev = previousById.get(id);
    const position = prev?.dragging ? prev.position : { x: sticky.x, y: sticky.y };
    if (
      prev?.type === "sticky"
      && prev.data.sticky === sticky
      && samePosition(prev, position)
    ) {
      next.push(prev);
      continue;
    }
    next.push({
      ...(prev?.type === "sticky" ? prev : {}),
      id,
      type: "sticky",
      position,
      width: sticky.width,
      height: sticky.height,
      zIndex: -1,
      data: { sticky },
    });
  }

  for (const agent of agents) {
    if (hidden.has(agent.id)) continue;
    const prev = previousById.get(agent.id);
    const position = prev?.dragging
      ? prev.position
      : layout.positions[agent.id] ?? autoPositions.get(agent.id) ?? { x: 0, y: 0 };
    const live = liveAgentIds.has(agent.id) || agent.status === "running";
    if (
      prev?.type === "agent"
      && prev.data.live === live
      && prev.data.direction === layout.direction
      && sameAgent(prev.data.agent, agent)
      && samePosition(prev, position)
    ) {
      next.push(prev);
      continue;
    }
    const data: AgentNodeData = prev?.type === "agent"
      && prev.data.live === live
      && prev.data.direction === layout.direction
      && sameAgent(prev.data.agent, agent)
      ? prev.data
      : { agent, live, direction: layout.direction };
    next.push({ ...(prev?.type === "agent" ? prev : {}), id: agent.id, type: "agent", position, data });
  }

  for (const draft of layout.drafts) {
    const id = draftNodeId(draft.id);
    const prev = previousById.get(id);
    const position = prev?.dragging ? prev.position : { x: draft.x, y: draft.y };
    const managerName = draft.reportsTo ? agentNames.get(draft.reportsTo) ?? null : null;
    if (
      prev?.type === "draft"
      && prev.data.draft === draft
      && prev.data.direction === layout.direction
      && prev.data.managerName === managerName
      && samePosition(prev, position)
    ) {
      next.push(prev);
      continue;
    }
    next.push({
      ...(prev?.type === "draft" ? prev : {}),
      id,
      type: "draft",
      position,
      data: { draft, direction: layout.direction, managerName },
    });
  }

  if (next.length === previous.length && next.every((node, index) => node === previous[index])) {
    return previous as GraphFlowNode[];
  }
  return next;
}

export function syncEdges(previous: readonly Edge[], input: SyncNodesInput): Edge[] {
  const { agents, layout, liveAgentIds } = input;
  const hidden = new Set(layout.hiddenAgentIds);
  const visible = new Set<string>();
  for (const agent of agents) if (!hidden.has(agent.id)) visible.add(agent.id);
  const previousById = new Map<string, Edge>();
  for (const edge of previous) previousById.set(edge.id, edge);
  const next: Edge[] = [];

  for (const agent of agents) {
    if (!agent.reportsTo || !visible.has(agent.id) || !visible.has(agent.reportsTo)) continue;
    const id = hierarchyEdgeId(agent.id);
    const animated = liveAgentIds.has(agent.id) || agent.status === "running";
    const prev = previousById.get(id);
    if (prev && prev.source === agent.reportsTo && prev.target === agent.id && Boolean(prev.animated) === animated) {
      next.push(prev);
      continue;
    }
    next.push({
      ...(prev ?? {}),
      id,
      source: agent.reportsTo,
      target: agent.id,
      type: "smoothstep",
      animated,
      reconnectable: "source",
      className: "agent-graph-edge",
    });
  }

  for (const draft of layout.drafts) {
    if (!draft.reportsTo || !visible.has(draft.reportsTo)) continue;
    const id = `${HIERARCHY_EDGE_PREFIX}${draftNodeId(draft.id)}`;
    const target = draftNodeId(draft.id);
    const prev = previousById.get(id);
    if (prev && prev.source === draft.reportsTo && prev.target === target) {
      next.push(prev);
      continue;
    }
    next.push({
      id,
      source: draft.reportsTo,
      target,
      type: "smoothstep",
      selectable: false,
      reconnectable: false,
      deletable: false,
      className: "agent-graph-edge agent-graph-edge-draft",
    });
  }

  if (next.length === previous.length && next.every((edge, index) => edge === previous[index])) {
    return previous as Edge[];
  }
  return next;
}

export function defaultAgentGraphLayout(): AgentGraphLayout {
  return {
    schemaVersion: 1,
    direction: "TB",
    viewport: null,
    positions: {},
    hiddenAgentIds: [],
    stickies: [],
    drafts: [],
  };
}

export function pruneLayout(layout: AgentGraphLayout, agentIds: ReadonlySet<string>): AgentGraphLayout {
  const staleHidden = layout.hiddenAgentIds.some((id) => !agentIds.has(id));
  const stalePositions = Object.keys(layout.positions).some((id) => !agentIds.has(id));
  if (!staleHidden && !stalePositions) return layout;
  const positions: AgentGraphLayout["positions"] = {};
  for (const [id, point] of Object.entries(layout.positions)) if (agentIds.has(id)) positions[id] = point;
  return { ...layout, positions, hiddenAgentIds: layout.hiddenAgentIds.filter((id) => agentIds.has(id)) };
}

export function commitNodePositions(
  layout: AgentGraphLayout,
  nodes: readonly GraphFlowNode[],
  autoPositions: ReadonlyMap<string, LayoutPoint>,
  companyAgentIds: ReadonlySet<string>,
): AgentGraphLayout {
  let positions = layout.positions;
  let stickies = layout.stickies;
  let drafts = layout.drafts;
  for (const node of nodes) {
    const { x, y } = node.position;
    if (node.type === "agent") {
      const known = layout.positions[node.id] ?? autoPositions.get(node.id);
      if (known && known.x === x && known.y === y) continue;
      if (positions === layout.positions) positions = { ...positions };
      positions[node.id] = { x, y };
    } else if (node.type === "sticky") {
      const sticky = node.data.sticky;
      if (sticky.x === x && sticky.y === y) continue;
      stickies = stickies.map((item) => (item.id === sticky.id ? { ...item, x, y } : item));
    } else {
      const draft = node.data.draft;
      if (draft.x === x && draft.y === y) continue;
      drafts = drafts.map((item) => (item.id === draft.id ? { ...item, x, y } : item));
    }
  }
  if (positions === layout.positions && stickies === layout.stickies && drafts === layout.drafts) return layout;
  return pruneLayout({ ...layout, positions, stickies, drafts }, companyAgentIds);
}
