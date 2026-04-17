export type Rt2GraphNodeType = "project" | "task" | "todo" | "daily_wiki_page";

export type Rt2GraphEdgeType = "project_task" | "task_todo" | "daily_wiki_task" | "task_dependency";

export type Rt2GraphConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface Rt2GraphNode {
  id: string;
  nodeKey: string;
  nodeType: Rt2GraphNodeType;
  label: string;
  sourceId: string;
  reportDate: string | null;
  metadata: Record<string, unknown>;
}

export interface Rt2GraphEdgeEvidence {
  source: "activity_log" | "daily_wiki" | "issue_relation" | "task_profile";
  message: string;
}

export interface Rt2GraphEdge {
  id: string;
  edgeType: Rt2GraphEdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  confidence: Rt2GraphConfidence;
  confidenceScore: number | null;
  rationale: string;
  evidence: Rt2GraphEdgeEvidence[];
}

export interface Rt2GraphCommunitySummary {
  communityKey: string;
  label: string;
  algorithm: string;
  memberNodeCount: number;
}

export interface Rt2ProjectGraph {
  companyId: string;
  projectId: string;
  updatedAt: string;
  nodes: Rt2GraphNode[];
  edges: Rt2GraphEdge[];
  communities: Rt2GraphCommunitySummary[];
}

export interface Rt2GraphReport {
  companyId: string;
  projectId: string;
  updatedAt: string;
  nodeCount: number;
  edgeCount: number;
  confidenceSummary: Record<Rt2GraphConfidence, number>;
  centralTaskNodeIds: string[];
  ambiguousEdges: Rt2GraphEdge[];
  markdown: string;
}
