import type { Node, Edge } from "@xyflow/react";
import type { Issue } from "@paperclipai/shared";

export type EdgeKind = "parent" | "workspace";

export interface GraphNodeData extends Record<string, unknown> {
  issue: Issue;
  agentName: string | null;
  isLive: boolean;
}

export type GraphNode = Node<GraphNodeData, "issue">;

export interface GraphEdgeData extends Record<string, unknown> {
  kind: EdgeKind;
  targetIsLive: boolean;
  targetAgentInitial: string | null;
  targetAgentName: string | null;
}

export type GraphEdge = Edge<GraphEdgeData>;

export interface EdgeVisibility {
  parent: boolean;
  workspace: boolean;
}
