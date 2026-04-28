export type Rt2GraphNodeType = "project" | "task" | "todo" | "daily_wiki_page" | "deliverable" | "actor" | "event";

export type Rt2GraphEdgeType =
  | "project_task"
  | "task_todo"
  | "daily_wiki_task"
  | "task_dependency"
  | "task_deliverable"
  | "project_deliverable"
  | "project_daily_wiki_page"
  | "project_event"
  | "actor_event"
  | "event_entity";

export type Rt2GraphConfidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type Rt2TaskMeshView =
  | "hierarchy"
  | "dependency"
  | "timeline"
  | "collaborator"
  | "deliverable"
  | "knowledge"
  | "economy";

export type Rt2TaskMeshEvidenceStatus = "present" | "missing" | "stale" | "ambiguous";

export interface Rt2TaskMeshNodeEvidence {
  deliverableCount: number;
  ownerCount: number;
  latestExecutionState: string | null;
  qualityStatus: "none" | "pending_review" | "reviewed";
  goldEstimate: number;
  knowledgeRefs: string[];
  status: Rt2TaskMeshEvidenceStatus;
}

export interface Rt2GraphNode {
  id: string;
  nodeKey: string;
  nodeType: Rt2GraphNodeType;
  label: string;
  sourceId: string;
  reportDate: string | null;
  metadata: Record<string, unknown>;
  evidence?: Rt2TaskMeshNodeEvidence;
}

export interface Rt2GraphEdgeEvidence {
  source: "activity_log" | "daily_wiki" | "issue_relation" | "task_profile" | "domain_event" | "work_product";
  message: string;
  eventId?: string;
  eventType?: string;
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
  meshViews: Rt2TaskMeshView[];
  warnings: string[];
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
  godNodes: Rt2GraphNode[];
  surprisingConnections: Rt2GraphEdge[];
  staleWarnings: string[];
  markdown: string;
}
