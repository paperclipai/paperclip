import type { Agent } from "@paperclipai/shared";

export interface SidebarAgentTreeNode {
  agent: Agent;
  children: SidebarAgentTreeNode[];
}

export function buildSidebarAgentTree(agents: Agent[]): SidebarAgentTreeNode[] {
  if (agents.length === 0) return [];

  const nodes = new Map<string, SidebarAgentTreeNode>();
  for (const agent of agents) {
    nodes.set(agent.id, { agent, children: [] });
  }

  const roots: SidebarAgentTreeNode[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.id);
    if (!node) continue;

    const parent = agent.reportsTo ? nodes.get(agent.reportsTo) : null;
    if (!parent || parent === node) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  return roots;
}

export function collectExpandableSidebarAgentIds(nodes: SidebarAgentTreeNode[]): string[] {
  const ids: string[] = [];

  const walk = (node: SidebarAgentTreeNode) => {
    if (node.children.length > 0) {
      ids.push(node.agent.id);
      node.children.forEach(walk);
    }
  };

  nodes.forEach(walk);
  return ids;
}

export function findSidebarAgentAncestorIds(
  nodes: SidebarAgentTreeNode[],
  targetAgentId: string | null,
): string[] {
  if (!targetAgentId) return [];

  const visit = (node: SidebarAgentTreeNode, ancestors: string[]): string[] | null => {
    if (node.agent.id === targetAgentId) {
      return ancestors;
    }

    for (const child of node.children) {
      const result = visit(child, [...ancestors, node.agent.id]);
      if (result) return result;
    }

    return null;
  };

  for (const node of nodes) {
    const result = visit(node, []);
    if (result) return result;
  }

  return [];
}

export function normalizeExpandedSidebarAgentIds(
  nodes: SidebarAgentTreeNode[],
  expandedIds: string[],
  activeAgentId: string | null,
): string[] {
  const expandableIds = new Set(collectExpandableSidebarAgentIds(nodes));
  const normalized = expandedIds.filter((id) => expandableIds.has(id));
  const normalizedSet = new Set(normalized);

  for (const id of findSidebarAgentAncestorIds(nodes, activeAgentId)) {
    if (!expandableIds.has(id) || normalizedSet.has(id)) continue;
    normalized.push(id);
    normalizedSet.add(id);
  }

  return normalized;
}
