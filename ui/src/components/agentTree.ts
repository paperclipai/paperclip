import type { Agent } from "@paperclipai/shared";

/**
 * A node in the agent org tree: an agent plus its direct reports, already
 * ordered. Depth is precomputed so the sidebar can indent without re-walking.
 */
export interface AgentTreeNode {
  agent: Agent;
  depth: number;
  reports: AgentTreeNode[];
}

/**
 * Build the CEO/org tree from a flat agent list using `reportsTo`.
 *
 * Roots are the "CEOs": agents with no `reportsTo`, or whose manager is not in
 * the provided list (dangling pointer — treated as a root so the agent never
 * disappears). Cycles are broken defensively: any agent reached again while
 * walking is dropped from the second position, and agents left unvisited after
 * the walk (pure cycles with no root) are surfaced as roots so nothing is
 * silently hidden — an invisible agent is worse than a mis-parented one.
 *
 * `orderRoots`/`orderReports` decide sibling order at each level; callers pass
 * the same comparator they use for the flat list so sort mode is preserved.
 */
export function buildAgentTree(
  agents: Agent[],
  compare?: (a: Agent, b: Agent) => number,
): AgentTreeNode[] {
  const byId = new Map<string, Agent>();
  for (const agent of agents) byId.set(agent.id, agent);

  const childrenByParent = new Map<string | null, Agent[]>();
  const rootKey = null;
  for (const agent of agents) {
    const managerInList = agent.reportsTo != null && byId.has(agent.reportsTo);
    const key = managerInList ? (agent.reportsTo as string) : rootKey;
    const bucket = childrenByParent.get(key);
    if (bucket) bucket.push(agent);
    else childrenByParent.set(key, [agent]);
  }

  const visited = new Set<string>();

  const buildNodes = (parentKey: string | null, depth: number): AgentTreeNode[] => {
    const siblings = childrenByParent.get(parentKey) ?? [];
    const ordered = compare ? [...siblings].sort(compare) : siblings;
    const nodes: AgentTreeNode[] = [];
    for (const agent of ordered) {
      if (visited.has(agent.id)) continue; // cycle guard
      visited.add(agent.id);
      nodes.push({ agent, depth, reports: buildNodes(agent.id, depth + 1) });
    }
    return nodes;
  };

  const roots = buildNodes(rootKey, 0);

  // Any agent not reached (pure cycle with no root anchor) becomes a root so it
  // stays visible instead of vanishing from the sidebar.
  const orphans = agents.filter((agent) => !visited.has(agent.id));
  const orderedOrphans = compare ? [...orphans].sort(compare) : orphans;
  for (const agent of orderedOrphans) {
    if (visited.has(agent.id)) continue;
    visited.add(agent.id);
    roots.push({ agent, depth: 0, reports: buildNodes(agent.id, 1) });
  }

  return roots;
}

/** Flatten a tree to a preorder list of {agent, depth} — handy for rendering
 * and for asserting order in tests. */
export function flattenAgentTree(nodes: AgentTreeNode[]): Array<{ agent: Agent; depth: number }> {
  const out: Array<{ agent: Agent; depth: number }> = [];
  const walk = (list: AgentTreeNode[]) => {
    for (const node of list) {
      out.push({ agent: node.agent, depth: node.depth });
      walk(node.reports);
    }
  };
  walk(nodes);
  return out;
}
