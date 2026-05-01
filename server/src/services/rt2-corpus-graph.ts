import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  rt2V33CorpusGraphCommunities,
  rt2V33CorpusGraphEdges,
  rt2V33CorpusGraphNodes,
  rt2V33CorpusGraphReports,
  rt2V33CorpusGraphSources,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
} from "@paperclipai/db";
import type {
  Rt2CorpusGraphCommunity,
  Rt2CorpusGraphCommunityResult,
  Rt2CorpusGraphEdge,
  Rt2CorpusGraphEdgeType,
  Rt2CorpusGraphIngestInput,
  Rt2CorpusGraphIngestResult,
  Rt2CorpusGraphNeighborsResult,
  Rt2CorpusGraphNode,
  Rt2CorpusGraphNodeResult,
  Rt2CorpusGraphNodeType,
  Rt2CorpusGraphReport,
  Rt2CorpusGraphShortestPathResult,
  Rt2CorpusGraphSource,
  Rt2CorpusGraphSourceLocation,
  Rt2CorpusGraphStats,
  Rt2GraphConfidence,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

const CLUSTERING_ALGORITHM = "connected_components_fallback";

type SourceRow = typeof rt2V33CorpusGraphSources.$inferSelect;
type NodeRow = typeof rt2V33CorpusGraphNodes.$inferSelect;
type EdgeRow = typeof rt2V33CorpusGraphEdges.$inferSelect;
type CommunityRow = typeof rt2V33CorpusGraphCommunities.$inferSelect;
type ReportRow = typeof rt2V33CorpusGraphReports.$inferSelect;

type ExtractedNode = {
  nodeKey: string;
  nodeType: Rt2CorpusGraphNodeType;
  label: string;
  sourceId: string | null;
  sourceLocation: Rt2CorpusGraphSourceLocation;
  metadata: Record<string, unknown>;
};

type ExtractedEdge = {
  sourceNodeKey: string;
  targetNodeKey: string;
  edgeType: Rt2CorpusGraphEdgeType;
  relation: string;
  confidence: Rt2GraphConfidence;
  confidenceScore: number;
  rationale: string;
  evidence: Array<Record<string, unknown>>;
  provenance: Record<string, unknown>;
};

type AnalyticsResult = {
  stats: Rt2CorpusGraphStats;
  report: Rt2CorpusGraphReport;
};

const TERM_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "because",
  "before",
  "between",
  "const",
  "export",
  "from",
  "function",
  "have",
  "into",
  "paperclip",
  "return",
  "should",
  "that",
  "their",
  "there",
  "this",
  "through",
  "type",
  "with",
  "without",
]);

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSourceKey(sourceKey: string): string {
  return sourceKey.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "item";
}

function sourceNodeKey(sourceKey: string): string {
  return `source:${normalizeSourceKey(sourceKey)}`;
}

function headingNodeKey(sourceKey: string, line: number, heading: string): string {
  return `heading:${normalizeSourceKey(sourceKey)}:${line}:${slug(heading)}`;
}

function symbolNodeKey(sourceKey: string, symbol: string): string {
  return `symbol:${normalizeSourceKey(sourceKey)}:${symbol}`;
}

function termNodeKey(term: string): string {
  return `term:${slug(term)}`;
}

function asDateIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => (
    typeof item === "object" && item !== null && !Array.isArray(item)
  ));
}

function asSourceLocation(value: unknown, fallbackPath: string): Rt2CorpusGraphSourceLocation {
  const record = asRecord(value);
  const path = typeof record.path === "string" && record.path.length > 0 ? record.path : fallbackPath;
  return {
    path,
    url: typeof record.url === "string" ? record.url : null,
    startLine: typeof record.startLine === "number" ? record.startLine : null,
    endLine: typeof record.endLine === "number" ? record.endLine : null,
    section: typeof record.section === "string" ? record.section : null,
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceRowToContract(row: SourceRow): Rt2CorpusGraphSource {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceKey: row.sourceKey,
    sourceType: row.sourceType as Rt2CorpusGraphSource["sourceType"],
    sourceLocation: asSourceLocation(row.sourceLocation, row.sourceKey),
    sha256: row.sha256,
    title: row.title,
    metadata: asRecord(row.metadata),
    lastIngestedAt: asDateIso(row.lastIngestedAt),
    createdAt: asDateIso(row.createdAt),
    updatedAt: asDateIso(row.updatedAt),
  };
}

function nodeRowToContract(row: NodeRow): Rt2CorpusGraphNode {
  return {
    id: row.id,
    companyId: row.companyId,
    nodeKey: row.nodeKey,
    nodeType: row.nodeType as Rt2CorpusGraphNodeType,
    label: row.label,
    sourceId: row.sourceId,
    sourceLocation: asSourceLocation(row.sourceLocation, row.nodeKey),
    metadata: asRecord(row.metadata),
    centrality: Number(row.centrality ?? 0),
    communityKey: row.communityKey,
    isGodNode: row.isGodNode,
    createdAt: asDateIso(row.createdAt),
    updatedAt: asDateIso(row.updatedAt),
  };
}

function edgeRowToContract(row: EdgeRow): Rt2CorpusGraphEdge {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceNodeId: row.sourceNodeId,
    targetNodeId: row.targetNodeId,
    edgeType: row.edgeType as Rt2CorpusGraphEdgeType,
    relation: row.relation,
    confidence: row.confidence as Rt2GraphConfidence,
    confidenceScore: numberOrNull(row.confidenceScore),
    rationale: row.rationale,
    evidence: asRecordArray(row.evidence),
    provenance: asRecord(row.provenance),
    createdAt: asDateIso(row.createdAt),
    updatedAt: asDateIso(row.updatedAt),
  };
}

function communityRowToContract(row: CommunityRow): Rt2CorpusGraphCommunity {
  return {
    id: row.id,
    companyId: row.companyId,
    communityKey: row.communityKey,
    algorithm: row.algorithm,
    label: row.label,
    memberNodeCount: row.memberNodeCount,
    godNodeId: row.godNodeId,
    metadata: asRecord(row.metadata),
    createdAt: asDateIso(row.createdAt),
    updatedAt: asDateIso(row.updatedAt),
  };
}

function reportRowToContract(row: ReportRow): Rt2CorpusGraphReport {
  return {
    companyId: row.companyId,
    updatedAt: asDateIso(row.updatedAt),
    generatedAt: asDateIso(row.generatedAt),
    corpusGraph: {
      nodeCount: row.corpusNodeCount,
      edgeCount: row.corpusEdgeCount,
      communityCount: row.communityCount,
      godNodeKeys: Array.isArray(row.godNodeKeys) ? row.godNodeKeys : [],
    },
    productGraph: {
      nodeCount: row.productNodeCount,
      edgeCount: row.productEdgeCount,
    },
    confidenceSummary: confidenceSummaryFromRecord(row.confidenceSummary),
    knowledgeGaps: asRecordArray(row.knowledgeGaps),
    surprisingConnections: asRecordArray(row.surprisingConnections),
    suggestedQuestions: Array.isArray(row.suggestedQuestions)
      ? row.suggestedQuestions.filter((item): item is string => typeof item === "string")
      : [],
    markdown: row.markdown,
  };
}

function confidenceSummaryFromRecord(value: unknown): Record<Rt2GraphConfidence, number> {
  const record = asRecord(value);
  return {
    EXTRACTED: Number(record.EXTRACTED ?? 0),
    INFERRED: Number(record.INFERRED ?? 0),
    AMBIGUOUS: Number(record.AMBIGUOUS ?? 0),
  };
}

function extractHighSignalTerms(content: string): string[] {
  const counts = new Map<string, number>();
  for (const match of content.matchAll(/[A-Za-z][A-Za-z0-9_-]{3,}/g)) {
    const term = match[0].toLowerCase();
    if (TERM_STOP_WORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([term]) => term);
}

function extractCorpusStructure(source: SourceRow, content: string): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
  const sourceLocation = asSourceLocation(source.sourceLocation, source.sourceKey);
  const fileNodeKey = sourceNodeKey(source.sourceKey);
  const nodes = new Map<string, ExtractedNode>();
  const edges = new Map<string, ExtractedEdge>();

  const addNode = (node: ExtractedNode) => nodes.set(node.nodeKey, node);
  const addEdge = (edge: ExtractedEdge) => {
    const key = `${edge.sourceNodeKey}->${edge.targetNodeKey}:${edge.edgeType}:${edge.relation}`;
    edges.set(key, edge);
  };

  addNode({
    nodeKey: fileNodeKey,
    nodeType: "source_file",
    label: source.title,
    sourceId: source.id,
    sourceLocation,
    metadata: {
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      sha256: source.sha256,
    },
  });

  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      const heading = headingMatch[2].trim();
      const nodeKey = headingNodeKey(source.sourceKey, lineNumber, heading);
      addNode({
        nodeKey,
        nodeType: "heading",
        label: heading,
        sourceId: source.id,
        sourceLocation: { ...sourceLocation, startLine: lineNumber, endLine: lineNumber, section: heading },
        metadata: { depth: headingMatch[1].length, sourceKey: source.sourceKey },
      });
      addEdge({
        sourceNodeKey: fileNodeKey,
        targetNodeKey: nodeKey,
        edgeType: "contains",
        relation: `contains_heading:${slug(heading)}`,
        confidence: "EXTRACTED",
        confidenceScore: 1,
        rationale: `Heading "${heading}" was extracted from ${source.sourceKey}.`,
        evidence: [{ sourceKey: source.sourceKey, line: lineNumber, text: line.trim() }],
        provenance: { extractor: "rt2-deterministic-doc-v1", sourceId: source.id, sourceKey: source.sourceKey },
      });
    }

    const symbolMatch = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (symbolMatch) {
      const symbol = symbolMatch[1];
      const nodeKey = symbolNodeKey(source.sourceKey, symbol);
      addNode({
        nodeKey,
        nodeType: "symbol",
        label: symbol,
        sourceId: source.id,
        sourceLocation: { ...sourceLocation, startLine: lineNumber, endLine: lineNumber, section: symbol },
        metadata: { sourceKey: source.sourceKey, declarationLine: lineNumber },
      });
      addEdge({
        sourceNodeKey: fileNodeKey,
        targetNodeKey: nodeKey,
        edgeType: "contains",
        relation: `contains_symbol:${symbol}`,
        confidence: "EXTRACTED",
        confidenceScore: 1,
        rationale: `Symbol "${symbol}" was extracted from ${source.sourceKey}.`,
        evidence: [{ sourceKey: source.sourceKey, line: lineNumber, text: line.trim() }],
        provenance: { extractor: "rt2-deterministic-code-v1", sourceId: source.id, sourceKey: source.sourceKey },
      });
    }

    const importMatch = /(?:import\s+.*?\s+from\s+|require\()["']([^"']+)["']/.exec(line);
    if (importMatch) {
      const imported = importMatch[1];
      const nodeKey = termNodeKey(imported);
      addNode({
        nodeKey,
        nodeType: "term",
        label: imported,
        sourceId: null,
        sourceLocation: { path: imported },
        metadata: { kind: "import_target", latestSourceKey: source.sourceKey },
      });
      addEdge({
        sourceNodeKey: fileNodeKey,
        targetNodeKey: nodeKey,
        edgeType: "imports",
        relation: `imports:${imported}`,
        confidence: "EXTRACTED",
        confidenceScore: 0.95,
        rationale: `${source.sourceKey} imports ${imported}.`,
        evidence: [{ sourceKey: source.sourceKey, line: lineNumber, text: line.trim() }],
        provenance: { extractor: "rt2-deterministic-code-v1", sourceId: source.id, sourceKey: source.sourceKey },
      });
    }
  }

  for (const term of extractHighSignalTerms(content)) {
    const nodeKey = termNodeKey(term);
    addNode({
      nodeKey,
      nodeType: "term",
      label: term,
      sourceId: null,
      sourceLocation: { path: `term:${term}` },
      metadata: { kind: "high_signal_term", latestSourceKey: source.sourceKey },
    });
    addEdge({
      sourceNodeKey: fileNodeKey,
      targetNodeKey: nodeKey,
      edgeType: "mentions",
      relation: `mentions:${term}`,
      confidence: "INFERRED",
      confidenceScore: 0.8,
      rationale: `${source.sourceKey} repeatedly mentions "${term}".`,
      evidence: [{ sourceKey: source.sourceKey, term }],
      provenance: { extractor: "rt2-deterministic-term-v1", sourceId: source.id, sourceKey: source.sourceKey },
    });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function calculateCentrality(nodes: NodeRow[], edges: EdgeRow[]): Map<string, number> {
  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.sourceNodeId, (degree.get(edge.sourceNodeId) ?? 0) + 1);
    degree.set(edge.targetNodeId, (degree.get(edge.targetNodeId) ?? 0) + 1);
  }
  const maxDegree = Math.max(1, nodes.length - 1);
  return new Map([...degree.entries()].map(([nodeId, count]) => [nodeId, count / maxDegree]));
}

function connectedComponents(nodes: NodeRow[], edges: EdgeRow[]): Map<string, string> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of edges) {
    adjacency.get(edge.sourceNodeId)?.add(edge.targetNodeId);
    adjacency.get(edge.targetNodeId)?.add(edge.sourceNodeId);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const node of [...nodes].sort((a, b) => a.nodeKey.localeCompare(b.nodeKey))) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const component: string[] = [];
    visited.add(node.id);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(component);
  }

  const result = new Map<string, string>();
  components.forEach((component, index) => {
    const key = `corpus_community_${index + 1}`;
    for (const nodeId of component) result.set(nodeId, key);
  });
  return result;
}

function buildMarkdownReport(input: {
  stats: Rt2CorpusGraphStats;
  knowledgeGaps: Array<Record<string, unknown>>;
  surprisingConnections: Array<Record<string, unknown>>;
  suggestedQuestions: string[];
}): string {
  const { stats, knowledgeGaps, surprisingConnections, suggestedQuestions } = input;
  return [
    "# RT2 Corpus Graph Report",
    "",
    "## Corpus Graph",
    `- Sources: ${stats.sourceCount}`,
    `- Nodes: ${stats.nodeCount}`,
    `- Edges: ${stats.edgeCount}`,
    `- Communities: ${stats.communityCount}`,
    `- God nodes: ${stats.godNodeCount}`,
    `- Clustering: ${stats.clusteringAlgorithm}`,
    "",
    "## Product Graph",
    `- Nodes: ${stats.productGraph.nodeCount}`,
    `- Edges: ${stats.productGraph.edgeCount}`,
    "",
    "## Confidence",
    `- EXTRACTED: ${stats.confidenceSummary.EXTRACTED}`,
    `- INFERRED: ${stats.confidenceSummary.INFERRED}`,
    `- AMBIGUOUS: ${stats.confidenceSummary.AMBIGUOUS}`,
    "",
    "## Knowledge Gaps",
    ...(knowledgeGaps.length > 0 ? knowledgeGaps.map((gap) => `- ${String(gap.message ?? "Gap detected")}`) : ["- None detected"]),
    "",
    "## Surprising Connections",
    ...(surprisingConnections.length > 0
      ? surprisingConnections.map((item) => `- ${String(item.rationale ?? "Connection detected")}`)
      : ["- None detected"]),
    "",
    "## Suggested Questions",
    ...(suggestedQuestions.length > 0 ? suggestedQuestions.map((question) => `- ${question}`) : ["- None generated"]),
  ].join("\n");
}

export function rt2CorpusGraphService(db: Db) {
  async function upsertNode(companyId: string, node: ExtractedNode): Promise<NodeRow> {
    const now = new Date();
    const [row] = await db.insert(rt2V33CorpusGraphNodes).values({
      companyId,
      nodeKey: node.nodeKey,
      nodeType: node.nodeType,
      label: node.label,
      sourceId: node.sourceId,
      sourceLocation: node.sourceLocation as unknown as Record<string, unknown>,
      metadata: node.metadata,
      centrality: "0",
      communityKey: null,
      isGodNode: false,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [rt2V33CorpusGraphNodes.companyId, rt2V33CorpusGraphNodes.nodeKey],
      set: {
        nodeType: node.nodeType,
        label: node.label,
        sourceId: node.sourceId,
        sourceLocation: node.sourceLocation as unknown as Record<string, unknown>,
        metadata: node.metadata,
        centrality: "0",
        communityKey: null,
        isGodNode: false,
        updatedAt: now,
      },
    }).returning();
    return row;
  }

  async function upsertEdge(companyId: string, edge: ExtractedEdge, nodeByKey: Map<string, NodeRow>): Promise<EdgeRow | null> {
    const sourceNode = nodeByKey.get(edge.sourceNodeKey);
    const targetNode = nodeByKey.get(edge.targetNodeKey);
    if (!sourceNode || !targetNode || sourceNode.id === targetNode.id) return null;

    const now = new Date();
    const [row] = await db.insert(rt2V33CorpusGraphEdges).values({
      companyId,
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      edgeType: edge.edgeType,
      relation: edge.relation,
      confidence: edge.confidence,
      confidenceScore: edge.confidenceScore.toFixed(2),
      rationale: edge.rationale,
      evidence: edge.evidence,
      provenance: edge.provenance,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [
        rt2V33CorpusGraphEdges.companyId,
        rt2V33CorpusGraphEdges.sourceNodeId,
        rt2V33CorpusGraphEdges.targetNodeId,
        rt2V33CorpusGraphEdges.edgeType,
        rt2V33CorpusGraphEdges.relation,
      ],
      set: {
        confidence: edge.confidence,
        confidenceScore: edge.confidenceScore.toFixed(2),
        rationale: edge.rationale,
        evidence: edge.evidence,
        provenance: edge.provenance,
        updatedAt: now,
      },
    }).returning();
    return row;
  }

  async function rebuildSharedConceptEdges(companyId: string): Promise<void> {
    const [nodes, edges] = await Promise.all([
      db.select().from(rt2V33CorpusGraphNodes).where(eq(rt2V33CorpusGraphNodes.companyId, companyId)),
      db.select().from(rt2V33CorpusGraphEdges).where(eq(rt2V33CorpusGraphEdges.companyId, companyId)),
    ]);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
    const sourceFilesByTerm = new Map<string, NodeRow[]>();

    for (const edge of edges) {
      if (edge.edgeType !== "mentions") continue;
      const source = nodeById.get(edge.sourceNodeId);
      const target = nodeById.get(edge.targetNodeId);
      if (!source || !target || source.nodeType !== "source_file" || target.nodeType !== "term") continue;
      const term = target.label.toLowerCase();
      const current = sourceFilesByTerm.get(term) ?? [];
      if (!current.some((node) => node.id === source.id)) current.push(source);
      sourceFilesByTerm.set(term, current);
    }

    let created = 0;
    for (const [term, sourceFiles] of [...sourceFilesByTerm.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const sorted = sourceFiles.sort((a, b) => a.nodeKey.localeCompare(b.nodeKey));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          if (created >= 100) return;
          await upsertEdge(companyId, {
            sourceNodeKey: sorted[i].nodeKey,
            targetNodeKey: sorted[j].nodeKey,
            edgeType: "shared_concept",
            relation: `shared_concept:${term}`,
            confidence: "INFERRED",
            confidenceScore: 0.72,
            rationale: `${sorted[i].label} and ${sorted[j].label} share the corpus concept "${term}".`,
            evidence: [{ term, sourceKeys: [sorted[i].nodeKey, sorted[j].nodeKey] }],
            provenance: { extractor: "rt2-deterministic-shared-concept-v1", term },
          }, nodeByKey);
          created += 1;
        }
      }
    }
  }

  async function refreshAnalytics(companyId: string): Promise<AnalyticsResult> {
    const [sources, nodes, edges, productNodes, productEdges] = await Promise.all([
      db.select().from(rt2V33CorpusGraphSources).where(eq(rt2V33CorpusGraphSources.companyId, companyId)),
      db.select().from(rt2V33CorpusGraphNodes).where(eq(rt2V33CorpusGraphNodes.companyId, companyId)),
      db.select().from(rt2V33CorpusGraphEdges).where(eq(rt2V33CorpusGraphEdges.companyId, companyId)),
      db.select().from(rt2V33GraphNodes).where(eq(rt2V33GraphNodes.companyId, companyId)),
      db.select().from(rt2V33GraphEdges).where(eq(rt2V33GraphEdges.companyId, companyId)),
    ]);
    const centrality = calculateCentrality(nodes, edges);
    const communityByNodeId = connectedComponents(nodes, edges);
    const nodesById = new Map(nodes.map((node) => [node.id, node]));

    const godNodeCount = Math.max(1, Math.ceil(nodes.filter((node) => node.nodeType !== "term").length * 0.1));
    const godNodeIds = new Set(
      nodes
        .filter((node) => node.nodeType !== "term")
        .sort((a, b) => (centrality.get(b.id) ?? 0) - (centrality.get(a.id) ?? 0) || a.nodeKey.localeCompare(b.nodeKey))
        .slice(0, nodes.length > 0 ? godNodeCount : 0)
        .map((node) => node.id),
    );

    for (const node of nodes) {
      await db.update(rt2V33CorpusGraphNodes)
        .set({
          centrality: (centrality.get(node.id) ?? 0).toFixed(6),
          communityKey: communityByNodeId.get(node.id) ?? null,
          isGodNode: godNodeIds.has(node.id),
          updatedAt: new Date(),
        })
        .where(eq(rt2V33CorpusGraphNodes.id, node.id));
    }

    await db.delete(rt2V33CorpusGraphCommunities).where(eq(rt2V33CorpusGraphCommunities.companyId, companyId));

    const memberIdsByCommunity = new Map<string, string[]>();
    for (const [nodeId, communityKey] of communityByNodeId.entries()) {
      const current = memberIdsByCommunity.get(communityKey) ?? [];
      current.push(nodeId);
      memberIdsByCommunity.set(communityKey, current);
    }

    const communityInserts = [...memberIdsByCommunity.entries()].map(([communityKey, memberIds]) => {
      const members = memberIds.map((id) => nodesById.get(id)).filter((node): node is NodeRow => Boolean(node));
      const sortedMembers = members.sort((a, b) => {
        const typeScore = (type: string) => (type === "source_file" ? 0 : type === "heading" ? 1 : type === "symbol" ? 2 : 3);
        return typeScore(a.nodeType) - typeScore(b.nodeType) || a.label.localeCompare(b.label);
      });
      const godNode = sortedMembers
        .filter((node) => godNodeIds.has(node.id))
        .sort((a, b) => (centrality.get(b.id) ?? 0) - (centrality.get(a.id) ?? 0))[0] ?? null;
      return {
        companyId,
        communityKey,
        algorithm: CLUSTERING_ALGORITHM,
        label: sortedMembers[0]?.label ?? communityKey,
        memberNodeCount: memberIds.length,
        godNodeId: godNode?.id ?? null,
        metadata: {
          nodeKeys: sortedMembers.slice(0, 20).map((node) => node.nodeKey),
        },
      };
    });
    if (communityInserts.length > 0) {
      await db.insert(rt2V33CorpusGraphCommunities).values(communityInserts);
    }

    const updatedNodes = await db.select().from(rt2V33CorpusGraphNodes).where(eq(rt2V33CorpusGraphNodes.companyId, companyId));
    const communities = await db.select().from(rt2V33CorpusGraphCommunities)
      .where(eq(rt2V33CorpusGraphCommunities.companyId, companyId));
    const updatedNodeById = new Map(updatedNodes.map((node) => [node.id, node]));
    const confidenceSummary = edges.reduce<Record<Rt2GraphConfidence, number>>((summary, edge) => {
      const confidence = edge.confidence as Rt2GraphConfidence;
      summary[confidence] = (summary[confidence] ?? 0) + 1;
      return summary;
    }, { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 });

    const isolatedNodes = updatedNodes.filter((node) => !edges.some((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id));
    const sparseSources = updatedNodes.filter((node) => (
      node.nodeType === "source_file" &&
      edges.filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id).length <= 1
    ));
    const knowledgeGaps: Array<Record<string, unknown>> = [
      ...isolatedNodes.slice(0, 5).map((node) => ({
        code: "isolated_node",
        severity: "warning",
        nodeKey: node.nodeKey,
        message: `Corpus node ${node.label} has no graph relationships yet.`,
      })),
      ...sparseSources.slice(0, 5).map((node) => ({
        code: "sparse_source",
        severity: "info",
        nodeKey: node.nodeKey,
        message: `Source ${node.label} has too few extracted relationships for agent memory.`,
      })),
    ];

    const surprisingConnections = edges
      .filter((edge) => edge.edgeType === "shared_concept" || edge.confidence !== "EXTRACTED" || Number(edge.confidenceScore ?? 1) < 0.8)
      .slice(0, 10)
      .map((edge) => ({
        edgeId: edge.id,
        edgeType: edge.edgeType,
        relation: edge.relation,
        sourceNodeKey: updatedNodeById.get(edge.sourceNodeId)?.nodeKey,
        targetNodeKey: updatedNodeById.get(edge.targetNodeId)?.nodeKey,
        confidence: edge.confidence,
        confidenceScore: numberOrNull(edge.confidenceScore),
        rationale: edge.rationale,
      }));

    const godNodeKeys = updatedNodes
      .filter((node) => node.isGodNode)
      .sort((a, b) => Number(b.centrality ?? 0) - Number(a.centrality ?? 0) || a.nodeKey.localeCompare(b.nodeKey))
      .map((node) => node.nodeKey);

    const suggestedQuestions = [
      ...godNodeKeys.slice(0, 3).map((nodeKey) => `What operational decisions depend on ${nodeKey}?`),
      ...knowledgeGaps.slice(0, 3).map((gap) => `What source evidence would close ${String(gap.code)} for ${String(gap.nodeKey ?? "this corpus area")}?`),
    ].slice(0, 6);

    const stats: Rt2CorpusGraphStats = {
      companyId,
      sourceCount: sources.length,
      nodeCount: updatedNodes.length,
      edgeCount: edges.length,
      communityCount: communities.length,
      godNodeCount: godNodeKeys.length,
      confidenceSummary,
      clusteringAlgorithm: CLUSTERING_ALGORITHM,
      productGraph: {
        nodeCount: productNodes.length,
        edgeCount: productEdges.length,
      },
      communities: communities.map((community) => ({
        communityKey: community.communityKey,
        label: community.label,
        memberNodeCount: community.memberNodeCount,
        godNodeKey: community.godNodeId ? updatedNodeById.get(community.godNodeId)?.nodeKey ?? null : null,
      })),
      updatedAt: new Date().toISOString(),
    };

    const markdown = buildMarkdownReport({ stats, knowledgeGaps, surprisingConnections, suggestedQuestions });
    const now = new Date();
    const [reportRow] = await db.insert(rt2V33CorpusGraphReports).values({
      companyId,
      corpusNodeCount: stats.nodeCount,
      corpusEdgeCount: stats.edgeCount,
      productNodeCount: stats.productGraph.nodeCount,
      productEdgeCount: stats.productGraph.edgeCount,
      confidenceSummary,
      communityCount: stats.communityCount,
      godNodeKeys,
      knowledgeGaps,
      surprisingConnections,
      suggestedQuestions,
      markdown,
      generatedAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [rt2V33CorpusGraphReports.companyId],
      set: {
        corpusNodeCount: stats.nodeCount,
        corpusEdgeCount: stats.edgeCount,
        productNodeCount: stats.productGraph.nodeCount,
        productEdgeCount: stats.productGraph.edgeCount,
        confidenceSummary,
        communityCount: stats.communityCount,
        godNodeKeys,
        knowledgeGaps,
        surprisingConnections,
        suggestedQuestions,
        markdown,
        generatedAt: now,
        updatedAt: now,
      },
    }).returning();

    return { stats, report: reportRowToContract(reportRow) };
  }

  return {
    async ingestSources(companyId: string, input: Rt2CorpusGraphIngestInput): Promise<Rt2CorpusGraphIngestResult> {
      let insertedSources = 0;
      let updatedSources = 0;
      let skippedSources = 0;
      const sourceResults: Rt2CorpusGraphIngestResult["sources"] = [];

      for (const rawSource of input.sources) {
        const sourceKey = normalizeSourceKey(rawSource.sourceKey);
        const sha256 = hashContent(rawSource.content);
        const [existing] = await db.select().from(rt2V33CorpusGraphSources).where(and(
          eq(rt2V33CorpusGraphSources.companyId, companyId),
          eq(rt2V33CorpusGraphSources.sourceKey, sourceKey),
        )).limit(1);

        if (existing?.sha256 === sha256) {
          skippedSources += 1;
          sourceResults.push({ sourceKey, status: "skipped", sha256, nodeCount: 0, edgeCount: 0 });
          continue;
        }

        const status = existing ? "updated" : "inserted";
        const now = new Date();
        const sourceLocation = {
          path: rawSource.sourceLocation?.path ?? sourceKey,
          url: rawSource.sourceLocation?.url ?? null,
          startLine: rawSource.sourceLocation?.startLine ?? null,
          endLine: rawSource.sourceLocation?.endLine ?? null,
          section: rawSource.sourceLocation?.section ?? null,
        };
        const [sourceRow] = await db.insert(rt2V33CorpusGraphSources).values({
          companyId,
          sourceKey,
          sourceType: rawSource.sourceType,
          sourceLocation,
          sha256,
          title: rawSource.title ?? sourceKey,
          metadata: rawSource.metadata ?? {},
          lastIngestedAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [rt2V33CorpusGraphSources.companyId, rt2V33CorpusGraphSources.sourceKey],
          set: {
            sourceType: rawSource.sourceType,
            sourceLocation,
            sha256,
            title: rawSource.title ?? sourceKey,
            metadata: rawSource.metadata ?? {},
            lastIngestedAt: now,
            updatedAt: now,
          },
        }).returning();

        await db.delete(rt2V33CorpusGraphNodes).where(and(
          eq(rt2V33CorpusGraphNodes.companyId, companyId),
          eq(rt2V33CorpusGraphNodes.sourceId, sourceRow.id),
        ));

        const extracted = extractCorpusStructure(sourceRow, rawSource.content);
        const nodeByKey = new Map<string, NodeRow>();
        for (const node of extracted.nodes) {
          const row = await upsertNode(companyId, node);
          nodeByKey.set(row.nodeKey, row);
        }
        let edgeCount = 0;
        for (const edge of extracted.edges) {
          const row = await upsertEdge(companyId, edge, nodeByKey);
          if (row) edgeCount += 1;
        }

        if (status === "inserted") insertedSources += 1;
        else updatedSources += 1;
        sourceResults.push({ sourceKey, status, sha256, nodeCount: extracted.nodes.length, edgeCount });
      }

      await rebuildSharedConceptEdges(companyId);
      const analytics = await refreshAnalytics(companyId);

      return {
        companyId,
        processedSources: input.sources.length,
        insertedSources,
        updatedSources,
        skippedSources,
        sources: sourceResults,
        graph: analytics.stats,
        report: analytics.report,
        ingestedAt: new Date().toISOString(),
      };
    },

    async getStats(companyId: string): Promise<Rt2CorpusGraphStats> {
      return (await refreshAnalytics(companyId)).stats;
    },

    async getReport(companyId: string): Promise<Rt2CorpusGraphReport> {
      return (await refreshAnalytics(companyId)).report;
    },

    async getNode(companyId: string, nodeKey: string): Promise<Rt2CorpusGraphNodeResult> {
      const [node] = await db.select().from(rt2V33CorpusGraphNodes).where(and(
        eq(rt2V33CorpusGraphNodes.companyId, companyId),
        eq(rt2V33CorpusGraphNodes.nodeKey, nodeKey),
      )).limit(1);
      if (!node) throw notFound("Corpus graph node not found");

      const [source, outgoingEdges, incomingEdges] = await Promise.all([
        node.sourceId
          ? db.select().from(rt2V33CorpusGraphSources).where(eq(rt2V33CorpusGraphSources.id, node.sourceId)).limit(1)
          : Promise.resolve([]),
        db.select().from(rt2V33CorpusGraphEdges).where(and(
          eq(rt2V33CorpusGraphEdges.companyId, companyId),
          eq(rt2V33CorpusGraphEdges.sourceNodeId, node.id),
        )),
        db.select().from(rt2V33CorpusGraphEdges).where(and(
          eq(rt2V33CorpusGraphEdges.companyId, companyId),
          eq(rt2V33CorpusGraphEdges.targetNodeId, node.id),
        )),
      ]);

      return {
        node: nodeRowToContract(node),
        source: source[0] ? sourceRowToContract(source[0]) : null,
        incomingEdges: incomingEdges.map(edgeRowToContract),
        outgoingEdges: outgoingEdges.map(edgeRowToContract),
      };
    },

    async getNeighbors(companyId: string, nodeKey: string, limit: number): Promise<Rt2CorpusGraphNeighborsResult> {
      const [node] = await db.select().from(rt2V33CorpusGraphNodes).where(and(
        eq(rt2V33CorpusGraphNodes.companyId, companyId),
        eq(rt2V33CorpusGraphNodes.nodeKey, nodeKey),
      )).limit(1);
      if (!node) throw notFound("Corpus graph node not found");

      const edges = await db.select().from(rt2V33CorpusGraphEdges).where(and(
        eq(rt2V33CorpusGraphEdges.companyId, companyId),
        or(
          eq(rt2V33CorpusGraphEdges.sourceNodeId, node.id),
          eq(rt2V33CorpusGraphEdges.targetNodeId, node.id),
        ),
      ));
      const limitedEdges = edges.slice(0, limit);
      const neighborIds = [...new Set(limitedEdges.map((edge) => (
        edge.sourceNodeId === node.id ? edge.targetNodeId : edge.sourceNodeId
      )))];
      const neighborRows = neighborIds.length > 0
        ? await db.select().from(rt2V33CorpusGraphNodes).where(inArray(rt2V33CorpusGraphNodes.id, neighborIds))
        : [];
      const neighborById = new Map(neighborRows.map((row) => [row.id, row]));

      return {
        node: nodeRowToContract(node),
        neighbors: limitedEdges.flatMap((edge) => {
          const isOutgoing = edge.sourceNodeId === node.id;
          const neighbor = neighborById.get(isOutgoing ? edge.targetNodeId : edge.sourceNodeId);
          if (!neighbor) return [];
          return [{
            node: nodeRowToContract(neighbor),
            edge: edgeRowToContract(edge),
            direction: isOutgoing ? "outgoing" as const : "incoming" as const,
          }];
        }),
      };
    },

    async getCommunity(companyId: string, communityKey: string): Promise<Rt2CorpusGraphCommunityResult> {
      const [community] = await db.select().from(rt2V33CorpusGraphCommunities).where(and(
        eq(rt2V33CorpusGraphCommunities.companyId, companyId),
        eq(rt2V33CorpusGraphCommunities.communityKey, communityKey),
      )).limit(1);
      if (!community) throw notFound("Corpus graph community not found");

      const [nodes, godNode] = await Promise.all([
        db.select().from(rt2V33CorpusGraphNodes).where(and(
          eq(rt2V33CorpusGraphNodes.companyId, companyId),
          eq(rt2V33CorpusGraphNodes.communityKey, communityKey),
        )),
        community.godNodeId
          ? db.select().from(rt2V33CorpusGraphNodes).where(eq(rt2V33CorpusGraphNodes.id, community.godNodeId)).limit(1)
          : Promise.resolve([]),
      ]);

      return {
        community: communityRowToContract(community),
        nodes: nodes.map(nodeRowToContract),
        godNode: godNode[0] ? nodeRowToContract(godNode[0]) : null,
      };
    },

    async getGodNodes(companyId: string, limit: number): Promise<Rt2CorpusGraphNode[]> {
      const rows = await db.select().from(rt2V33CorpusGraphNodes).where(and(
        eq(rt2V33CorpusGraphNodes.companyId, companyId),
        eq(rt2V33CorpusGraphNodes.isGodNode, true),
      ));
      return rows
        .sort((a, b) => Number(b.centrality ?? 0) - Number(a.centrality ?? 0) || a.nodeKey.localeCompare(b.nodeKey))
        .slice(0, limit)
        .map(nodeRowToContract);
    },

    async getShortestPath(
      companyId: string,
      fromNodeKey: string,
      toNodeKey: string,
      maxDepth: number,
    ): Promise<Rt2CorpusGraphShortestPathResult> {
      const [nodes, edges] = await Promise.all([
        db.select().from(rt2V33CorpusGraphNodes).where(eq(rt2V33CorpusGraphNodes.companyId, companyId)),
        db.select().from(rt2V33CorpusGraphEdges).where(eq(rt2V33CorpusGraphEdges.companyId, companyId)),
      ]);
      const nodeByKey = new Map(nodes.map((node) => [node.nodeKey, node]));
      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const start = nodeByKey.get(fromNodeKey);
      const target = nodeByKey.get(toNodeKey);
      if (!start || !target) {
        return { companyId, fromNodeKey, toNodeKey, found: false, nodes: [], edges: [], maxDepth };
      }

      const adjacency = new Map<string, Array<{ nodeId: string; edge: EdgeRow }>>();
      for (const node of nodes) adjacency.set(node.id, []);
      for (const edge of edges) {
        adjacency.get(edge.sourceNodeId)?.push({ nodeId: edge.targetNodeId, edge });
        adjacency.get(edge.targetNodeId)?.push({ nodeId: edge.sourceNodeId, edge });
      }

      const queue: Array<{ nodeId: string; nodePath: string[]; edgePath: EdgeRow[] }> = [{
        nodeId: start.id,
        nodePath: [start.id],
        edgePath: [],
      }];
      const visited = new Set([start.id]);

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current.nodeId === target.id) {
          return {
            companyId,
            fromNodeKey,
            toNodeKey,
            found: true,
            nodes: current.nodePath.map((id) => nodeById.get(id)).filter((node): node is NodeRow => Boolean(node)).map(nodeRowToContract),
            edges: current.edgePath.map(edgeRowToContract),
            maxDepth,
          };
        }
        if (current.edgePath.length >= maxDepth) continue;
        for (const next of adjacency.get(current.nodeId) ?? []) {
          if (visited.has(next.nodeId)) continue;
          visited.add(next.nodeId);
          queue.push({
            nodeId: next.nodeId,
            nodePath: [...current.nodePath, next.nodeId],
            edgePath: [...current.edgePath, next.edge],
          });
        }
      }

      return { companyId, fromNodeKey, toNodeKey, found: false, nodes: [], edges: [], maxDepth };
    },
  };
}
