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

export type Rt2CorpusGraphSourceType = "repo_file" | "doc_file" | "wiki_page" | "external_reference";

export type Rt2CorpusGraphNodeType = "source_file" | "heading" | "symbol" | "term";

export type Rt2CorpusGraphEdgeType = "contains" | "imports" | "references" | "mentions" | "shared_concept";

export interface Rt2CorpusGraphSourceLocation {
  path: string;
  url?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  section?: string | null;
}

export interface Rt2CorpusGraphSource {
  id: string;
  companyId: string;
  sourceKey: string;
  sourceType: Rt2CorpusGraphSourceType;
  sourceLocation: Rt2CorpusGraphSourceLocation;
  sha256: string;
  title: string;
  metadata: Record<string, unknown>;
  lastIngestedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2CorpusGraphIngestSourceInput {
  sourceKey: string;
  sourceType: Rt2CorpusGraphSourceType;
  content: string;
  title?: string;
  sourceLocation?: Partial<Rt2CorpusGraphSourceLocation>;
  metadata?: Record<string, unknown>;
}

export interface Rt2CorpusGraphIngestInput {
  sources: Rt2CorpusGraphIngestSourceInput[];
  rebuildReport?: boolean;
}

export interface Rt2CorpusGraphNode {
  id: string;
  companyId: string;
  nodeKey: string;
  nodeType: Rt2CorpusGraphNodeType;
  label: string;
  sourceId: string | null;
  sourceLocation: Rt2CorpusGraphSourceLocation;
  metadata: Record<string, unknown>;
  centrality: number;
  communityKey: string | null;
  isGodNode: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2CorpusGraphEdge {
  id: string;
  companyId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: Rt2CorpusGraphEdgeType;
  relation: string;
  confidence: Rt2GraphConfidence;
  confidenceScore: number | null;
  rationale: string;
  evidence: Array<Record<string, unknown>>;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2CorpusGraphCommunity {
  id: string;
  companyId: string;
  communityKey: string;
  algorithm: string;
  label: string;
  memberNodeCount: number;
  godNodeId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Rt2CorpusGraphStats {
  companyId: string;
  sourceCount: number;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  godNodeCount: number;
  confidenceSummary: Record<Rt2GraphConfidence, number>;
  clusteringAlgorithm: string;
  productGraph: {
    nodeCount: number;
    edgeCount: number;
  };
  communities: Array<{
    communityKey: string;
    label: string;
    memberNodeCount: number;
    godNodeKey: string | null;
  }>;
  updatedAt: string;
}

export interface Rt2CorpusGraphReport {
  companyId: string;
  updatedAt: string;
  generatedAt: string;
  corpusGraph: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    godNodeKeys: string[];
  };
  productGraph: {
    nodeCount: number;
    edgeCount: number;
  };
  confidenceSummary: Record<Rt2GraphConfidence, number>;
  knowledgeGaps: Array<Record<string, unknown>>;
  surprisingConnections: Array<Record<string, unknown>>;
  suggestedQuestions: string[];
  markdown: string;
}

export interface Rt2CorpusGraphIngestResult {
  companyId: string;
  processedSources: number;
  insertedSources: number;
  updatedSources: number;
  skippedSources: number;
  sources: Array<{
    sourceKey: string;
    status: "inserted" | "updated" | "skipped";
    sha256: string;
    nodeCount: number;
    edgeCount: number;
  }>;
  graph: Rt2CorpusGraphStats;
  report: Rt2CorpusGraphReport;
  ingestedAt: string;
}

export interface Rt2CorpusGraphNodeResult {
  node: Rt2CorpusGraphNode;
  source: Rt2CorpusGraphSource | null;
  incomingEdges: Rt2CorpusGraphEdge[];
  outgoingEdges: Rt2CorpusGraphEdge[];
}

export interface Rt2CorpusGraphNeighborsResult {
  node: Rt2CorpusGraphNode;
  neighbors: Array<{
    node: Rt2CorpusGraphNode;
    edge: Rt2CorpusGraphEdge;
    direction: "incoming" | "outgoing";
  }>;
}

export interface Rt2CorpusGraphCommunityResult {
  community: Rt2CorpusGraphCommunity;
  nodes: Rt2CorpusGraphNode[];
  godNode: Rt2CorpusGraphNode | null;
}

export interface Rt2CorpusGraphShortestPathResult {
  companyId: string;
  fromNodeKey: string;
  toNodeKey: string;
  found: boolean;
  nodes: Rt2CorpusGraphNode[];
  edges: Rt2CorpusGraphEdge[];
  maxDepth: number;
}
