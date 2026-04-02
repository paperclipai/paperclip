import type { Issue } from "@paperclipai/shared";
import type { GraphNode, GraphEdge } from "./types";

interface AgentLike {
  id: string;
  name: string;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 72;

export function buildGraphNodes(
  issues: Issue[],
  agents: AgentLike[] | undefined,
  liveIssueIds: Set<string>,
): GraphNode[] {
  const agentMap = new Map<string, string>();
  if (agents) {
    for (const a of agents) agentMap.set(a.id, a.name);
  }

  return issues.map((issue) => ({
    id: issue.id,
    type: "issue" as const,
    position: { x: 0, y: 0 },
    data: {
      issue,
      agentName: issue.assigneeAgentId ? (agentMap.get(issue.assigneeAgentId) ?? null) : null,
      isLive: liveIssueIds.has(issue.id),
    },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
  }));
}

export function buildGraphEdges(
  issues: Issue[],
  liveIssueIds: Set<string>,
  agents: AgentLike[] | undefined,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const issueIdSet = new Set(issues.map((i) => i.id));
  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const agentMap = new Map<string, string>();
  if (agents) {
    for (const a of agents) agentMap.set(a.id, a.name);
  }

  function liveInfo(targetId: string) {
    const target = issueMap.get(targetId);
    const isLive = liveIssueIds.has(targetId);
    const agentId = target?.assigneeAgentId;
    const agentName = agentId ? (agentMap.get(agentId) ?? null) : null;
    const initial = agentName ? agentName.slice(0, 2).toUpperCase() : null;
    return { targetIsLive: isLive, targetAgentInitial: initial, targetAgentName: agentName };
  }

  for (const issue of issues) {
    if (issue.parentId && issueIdSet.has(issue.parentId)) {
      edges.push({
        id: `parent-${issue.parentId}-${issue.id}`,
        source: issue.parentId,
        target: issue.id,
        type: "issueEdge",
        data: { kind: "parent", ...liveInfo(issue.id) },
      });
    }
  }

  const workspaceGroups = new Map<string, string[]>();
  for (const issue of issues) {
    if (issue.executionWorkspaceId) {
      const group = workspaceGroups.get(issue.executionWorkspaceId);
      if (group) group.push(issue.id);
      else workspaceGroups.set(issue.executionWorkspaceId, [issue.id]);
    }
  }

  for (const [, ids] of workspaceGroups) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({
          id: `workspace-${ids[i]}-${ids[j]}`,
          source: ids[i]!,
          target: ids[j]!,
          type: "issueEdge",
          data: { kind: "workspace", ...liveInfo(ids[j]!) },
        });
      }
    }
  }

  return edges;
}

export const GRAPH_NODE_WIDTH = NODE_WIDTH;
export const GRAPH_NODE_HEIGHT = NODE_HEIGHT;
