import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documents,
  issueWorkProducts,
  issues,
  rt2SearchIndex,
  rt2SearchLog,
  rt2V33DailyWikiPages,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33SemanticIndexChunks,
  rt2V33TaskProfiles,
  rt2V33WikiPages,
} from "@paperclipai/db";
import { deterministicSemanticEmbedding } from "./rt2-semantic-index.js";

export type SearchResult = {
  id: string;
  type: "document" | "wiki_page" | "daily_wiki_page" | "task" | "deliverable" | "work_artifact" | "graph_node" | "graph_edge";
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  projectId: string | null;
  title: string;
  snippet: string;
  highlight?: string;
  score: number;
  updatedAt: Date;
  freshness: "fresh" | "stale" | "unknown";
  confidence: string;
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  provenance: Record<string, unknown>;
  evidence: Array<{ source: string; reason: string; weight: number }>;
};

export type SearchOptions = {
  limit?: number;
  offset?: number;
  type?: "all" | SearchResult["type"];
  sourceType?: "all" | SearchResult["type"];
  projectId?: string;
  workObjectId?: string;
  dateFrom?: string;
  dateTo?: string;
  confidence?: string;
  contradictionStatus?: "all" | SearchResult["contradictionStatus"];
};

export type SearchStats = {
  companyId: string;
  indexedDocuments: number;
  indexedWikiPages: number;
  indexedTasks: number;
  indexedDeliverables: number;
  indexedGraphNodes: number;
  indexedGraphEdges: number;
  status: "idle" | "indexing" | "error";
  lastIndexedAt: Date | null;
  featuresEnabled: string;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  total: number;
  searchTimeMs: number;
  searchType: "hybrid";
};

export function rt2HybridSearchService(db: Db) {
  async function search(
    companyId: string,
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const resultLimit = Math.max(limit + offset, limit);
    const results: SearchResult[] = [];

    results.push(...await searchSemanticChunks(companyId, query, Math.max(resultLimit * 2, 25), options));
    if (matches(options.type, "document")) results.push(...await searchDocuments(companyId, query, resultLimit));
    if (matches(options.type, "wiki_page")) results.push(...await searchWikiPages(companyId, query, resultLimit));
    if (matches(options.type, "daily_wiki_page")) results.push(...await searchDailyWikiPages(companyId, query, resultLimit));
    if (matches(options.type, "task")) results.push(...await searchTasks(companyId, query, resultLimit));
    if (matches(options.type, "deliverable")) results.push(...await searchDeliverables(companyId, query, resultLimit));
    if (matches(options.type, "work_artifact")) results.push(...await searchDeliverables(companyId, query, resultLimit, "work_artifact"));
    if (matches(options.type, "graph_node")) results.push(...await searchGraphNodes(companyId, query, resultLimit));
    if (matches(options.type, "graph_edge")) results.push(...await searchGraphEdges(companyId, query, resultLimit));

    const reranked = rerankByEvidence(dedupeResults(results), query).filter((result) => matchesFilters(result, options));
    const paginatedResults = reranked.slice(offset, offset + limit);
    const searchTimeMs = Date.now() - startTime;

    try {
      await db.insert(rt2SearchLog).values({
        companyId,
        query,
        resultsCount: paginatedResults.length,
        searchTimeMs,
        searchType: "hybrid",
      });
    } catch (error) {
      console.error("Failed to log search:", error);
    }

    return {
      query,
      results: paginatedResults,
      total: reranked.length,
      searchTimeMs,
      searchType: "hybrid",
    };
  }

  async function searchSemanticChunks(
    companyId: string,
    query: string,
    limit: number,
    options: SearchOptions,
  ): Promise<SearchResult[]> {
    const predicates = [eq(rt2V33SemanticIndexChunks.companyId, companyId)];
    if (options.projectId) predicates.push(eq(rt2V33SemanticIndexChunks.projectId, options.projectId));
    if (options.dateFrom) predicates.push(gte(rt2V33SemanticIndexChunks.sourceUpdatedAt, new Date(options.dateFrom)));
    if (options.dateTo) predicates.push(lte(rt2V33SemanticIndexChunks.sourceUpdatedAt, new Date(options.dateTo)));

    const chunks = await db
      .select()
      .from(rt2V33SemanticIndexChunks)
      .where(and(...predicates))
      .orderBy(desc(rt2V33SemanticIndexChunks.sourceUpdatedAt))
      .limit(Math.max(limit * 4, 100));

    if (chunks.length === 0) return [];

    const queryVector = deterministicSemanticEmbedding(query).vector;
    return chunks
      .map((chunk) => {
        const similarity = cosineSimilarity(queryVector, Array.isArray(chunk.embedding) ? chunk.embedding : []);
        return {
          chunk,
          similarity,
        };
      })
      .filter(({ similarity, chunk }) => similarity > 0 || lexicalContains(chunk.chunkText, query) || lexicalContains(chunk.sourceKey, query))
      .sort((a, b) => b.similarity - a.similarity || b.chunk.sourceUpdatedAt.getTime() - a.chunk.sourceUpdatedAt.getTime())
      .slice(0, limit)
      .map(({ chunk, similarity }) => {
        const type = normalizeSemanticType(chunk.sourceType, chunk.provenance);
        const confidence = readConfidence(chunk.provenance);
        return {
          id: `${chunk.sourceType}:${chunk.sourceId}`,
          type,
          sourceType: chunk.sourceType,
          sourceId: chunk.sourceId,
          sourceKey: chunk.sourceKey,
          projectId: chunk.projectId,
          title: titleFromSemanticChunk(chunk.sourceType, chunk.sourceKey, chunk.provenance),
          snippet: extractSnippet(chunk.chunkText, query),
          highlight: createHighlight(chunk.chunkText, query),
          score: Math.round((similarity * 100 + freshnessBoost(chunk.freshness) + confidenceBoost(confidence)) * 100) / 100,
          updatedAt: chunk.sourceUpdatedAt,
          freshness: normalizeFreshness(chunk.freshness),
          confidence,
          contradictionStatus: readContradictionStatus(chunk.provenance),
          provenance: chunk.provenance ?? {},
          evidence: [
            { source: "semantic-index", reason: `${chunk.embeddingProvider} similarity`, weight: Number(similarity.toFixed(4)) },
            { source: "source-freshness", reason: chunk.freshness, weight: freshnessBoost(chunk.freshness) },
          ],
        };
      });
  }

  async function searchDocuments(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const docs = await db
      .select({
        id: documents.id,
        title: documents.title,
        latestBody: documents.latestBody,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.companyId, companyId), or(ilike(documents.title, searchPattern), ilike(documents.latestBody, searchPattern))))
      .orderBy(desc(documents.updatedAt))
      .limit(limit);

    return docs.map((doc) => buildResult({
      id: doc.id,
      type: "document",
      sourceType: "document",
      sourceId: doc.id,
      sourceKey: doc.id,
      projectId: null,
      title: doc.title || "(Untitled)",
      content: doc.latestBody,
      query,
      updatedAt: doc.updatedAt,
      source: "document",
      titleWeight: 10,
      contentWeight: 1,
    }));
  }

  async function searchWikiPages(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const pages = await db
      .select()
      .from(rt2V33WikiPages)
      .where(and(eq(rt2V33WikiPages.companyId, companyId), or(
        ilike(rt2V33WikiPages.pageKey, searchPattern),
        ilike(rt2V33WikiPages.title, searchPattern),
        ilike(rt2V33WikiPages.markdown, searchPattern),
      )))
      .orderBy(desc(rt2V33WikiPages.updatedAt))
      .limit(limit);

    return pages.map((page) => buildResult({
      id: page.id,
      type: "wiki_page",
      sourceType: "wiki_page",
      sourceId: page.id,
      sourceKey: page.pageKey,
      projectId: null,
      title: page.title || page.pageKey,
      content: page.markdown,
      query,
      updatedAt: page.updatedAt,
      source: "wiki",
      titleWeight: 14,
      contentWeight: 2,
    }));
  }

  async function searchDailyWikiPages(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const pages = await db
      .select()
      .from(rt2V33DailyWikiPages)
      .where(and(eq(rt2V33DailyWikiPages.companyId, companyId), or(
        ilike(rt2V33DailyWikiPages.pageKey, searchPattern),
        ilike(rt2V33DailyWikiPages.markdown, searchPattern),
      )))
      .orderBy(desc(rt2V33DailyWikiPages.updatedAt))
      .limit(limit);

    return pages.map((page) => buildResult({
      id: page.id,
      type: "daily_wiki_page",
      sourceType: "daily_wiki_page",
      sourceId: page.id,
      sourceKey: page.pageKey,
      projectId: page.projectId,
      title: page.pageKey,
      content: [page.shortSummary.join("\n"), page.markdown].filter(Boolean).join("\n\n"),
      query,
      updatedAt: page.updatedAt,
      source: "daily-wiki",
      titleWeight: 14,
      contentWeight: 3,
      provenance: {
        reportDate: String(page.reportDate),
        userId: page.userId,
        sourceEventIds: page.sourceEventIds,
      },
    }));
  }

  async function searchTasks(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(rt2V33TaskProfiles)
      .innerJoin(issues, eq(rt2V33TaskProfiles.issueId, issues.id))
      .where(and(eq(rt2V33TaskProfiles.companyId, companyId), or(ilike(issues.title, searchPattern), ilike(issues.description, searchPattern))))
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    return rows.map((task) => buildResult({
      id: task.id,
      type: "task",
      sourceType: "task",
      sourceId: task.id,
      sourceKey: task.id,
      projectId: task.projectId,
      title: task.title,
      content: task.description ?? task.status,
      query,
      updatedAt: task.updatedAt,
      source: "task",
      titleWeight: 16,
      contentWeight: 2,
    }));
  }

  async function searchDeliverables(companyId: string, query: string, limit: number, type: "deliverable" | "work_artifact" = "deliverable"): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await db
      .select()
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, companyId), or(ilike(issueWorkProducts.title, searchPattern), ilike(issueWorkProducts.summary, searchPattern), ilike(issueWorkProducts.type, searchPattern))))
      .orderBy(desc(issueWorkProducts.updatedAt))
      .limit(limit);

    return rows.map((deliverable) => buildResult({
      id: deliverable.id,
      type,
      sourceType: type,
      sourceId: deliverable.id,
      sourceKey: deliverable.externalId ?? deliverable.id,
      projectId: deliverable.projectId,
      title: deliverable.title,
      content: deliverable.summary ?? deliverable.type,
      query,
      updatedAt: deliverable.updatedAt,
      source: "deliverable",
      titleWeight: 18,
      contentWeight: 3,
      provenance: {
        issueId: deliverable.issueId,
        provider: deliverable.provider,
        externalId: deliverable.externalId,
        type: deliverable.type,
        status: deliverable.status,
        reviewState: deliverable.reviewState,
        healthStatus: deliverable.healthStatus,
      },
    }));
  }

  async function searchGraphNodes(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await db
      .select()
      .from(rt2V33GraphNodes)
      .where(and(eq(rt2V33GraphNodes.companyId, companyId), or(ilike(rt2V33GraphNodes.nodeKey, searchPattern), ilike(rt2V33GraphNodes.label, searchPattern), ilike(rt2V33GraphNodes.nodeType, searchPattern))))
      .orderBy(desc(rt2V33GraphNodes.updatedAt))
      .limit(limit);

    return rows.map((node) => buildResult({
      id: node.id,
      type: "graph_node",
      sourceType: "graph_node",
      sourceId: node.id,
      sourceKey: node.nodeKey,
      projectId: node.projectId,
      title: node.label,
      content: `${node.nodeType} ${node.nodeKey}`,
      query,
      updatedAt: node.updatedAt,
      source: "graph",
      titleWeight: 12,
      contentWeight: 2,
      provenance: {
        nodeKey: node.nodeKey,
        nodeType: node.nodeType,
        sourceId: node.sourceId,
        reportDate: node.reportDate ? String(node.reportDate) : null,
        centrality: node.centrality,
        isGodNode: node.isGodNode,
      },
    }));
  }

  async function searchGraphEdges(companyId: string, query: string, limit: number): Promise<SearchResult[]> {
    const searchPattern = `%${query}%`;
    const rows = await db
      .select()
      .from(rt2V33GraphEdges)
      .where(and(eq(rt2V33GraphEdges.companyId, companyId), or(ilike(rt2V33GraphEdges.edgeType, searchPattern), ilike(rt2V33GraphEdges.rationale, searchPattern), ilike(rt2V33GraphEdges.confidence, searchPattern))))
      .orderBy(desc(rt2V33GraphEdges.updatedAt))
      .limit(limit);

    return rows.map((edge) => buildResult({
      id: edge.id,
      type: "graph_edge",
      sourceType: "graph_edge",
      sourceId: edge.id,
      sourceKey: `${edge.edgeType}:${edge.id}`,
      projectId: edge.projectId,
      title: edge.edgeType,
      content: `${edge.confidence}: ${edge.rationale}`,
      query,
      updatedAt: edge.updatedAt,
      source: "graph",
      titleWeight: 10,
      contentWeight: 3,
      confidence: edge.confidence,
      provenance: {
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        edgeType: edge.edgeType,
        confidence: edge.confidence,
        confidenceScore: edge.confidenceScore,
        evidence: edge.evidence,
      },
    }));
  }

  async function getSearchStats(companyId: string): Promise<SearchStats> {
    const [index, docsCount, wikiCount, taskCount, deliverableCount, nodeCount, edgeCount] = await Promise.all([
      db.select().from(rt2SearchIndex).where(eq(rt2SearchIndex.companyId, companyId)).limit(1).then((rows) => rows[0] ?? null),
      db.select({ count: sql<number>`count(*)::int` }).from(documents).where(eq(documents.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(rt2V33WikiPages).where(eq(rt2V33WikiPages.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(issues).where(eq(issues.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(rt2V33GraphNodes).where(eq(rt2V33GraphNodes.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` }).from(rt2V33GraphEdges).where(eq(rt2V33GraphEdges.companyId, companyId)).then((rows) => rows[0]?.count ?? 0),
    ]);

    return {
      companyId,
      indexedDocuments: docsCount,
      indexedWikiPages: wikiCount,
      indexedTasks: taskCount,
      indexedDeliverables: deliverableCount,
      indexedGraphNodes: nodeCount,
      indexedGraphEdges: edgeCount,
      status: (index?.status as SearchStats["status"] | undefined) ?? "idle",
      lastIndexedAt: index?.indexingCompletedAt ?? null,
      featuresEnabled: "keyword+semantic-rerank",
    };
  }

  async function rebuildIndex(companyId: string): Promise<{ started: boolean; message: string }> {
    const stats = await getSearchStats(companyId);
    const existingIndex = await db
      .select()
      .from(rt2SearchIndex)
      .where(eq(rt2SearchIndex.companyId, companyId))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const values = {
      companyId,
      documentType: "all",
      indexedCount: stats.indexedDocuments + stats.indexedTasks + stats.indexedDeliverables,
      indexedPages: stats.indexedWikiPages,
      status: "idle",
      indexingStartedAt: new Date(),
      indexingCompletedAt: new Date(),
      featuresEnabled: "keyword+semantic-rerank",
      updatedAt: new Date(),
    };

    if (existingIndex) {
      await db.update(rt2SearchIndex).set(values).where(eq(rt2SearchIndex.id, existingIndex.id));
    } else {
      await db.insert(rt2SearchIndex).values(values);
    }

    return {
      started: true,
      message: `Indexed ${stats.indexedDocuments} documents, ${stats.indexedWikiPages} wiki pages, ${stats.indexedTasks} tasks, ${stats.indexedDeliverables} deliverables, ${stats.indexedGraphNodes} graph nodes, and ${stats.indexedGraphEdges} graph edges`,
    };
  }

  return { search, getSearchStats, rebuildIndex };
}

function matches(selected: SearchOptions["type"], type: SearchResult["type"]): boolean {
  return !selected || selected === "all" || selected === type;
}

function buildResult(input: {
  id: string;
  type: SearchResult["type"];
  sourceType?: string;
  sourceId?: string;
  sourceKey?: string;
  projectId?: string | null;
  title: string;
  content: string;
  query: string;
  updatedAt: Date;
  source: string;
  titleWeight: number;
  contentWeight: number;
  confidence?: string;
  freshness?: SearchResult["freshness"];
  contradictionStatus?: SearchResult["contradictionStatus"];
  provenance?: Record<string, unknown>;
}): SearchResult {
  const score = calculateScore(input.title, input.content, input.query, input.titleWeight, input.contentWeight);
  return {
    id: input.id,
    type: input.type,
    sourceType: input.sourceType ?? input.type,
    sourceId: input.sourceId ?? input.id,
    sourceKey: input.sourceKey ?? input.id,
    projectId: input.projectId ?? null,
    title: input.title,
    snippet: extractSnippet(input.content, input.query),
    highlight: createHighlight(input.content, input.query),
    score,
    updatedAt: input.updatedAt,
    freshness: input.freshness ?? "unknown",
    confidence: input.confidence ?? "unknown",
    contradictionStatus: input.contradictionStatus ?? "unknown",
    provenance: input.provenance ?? {},
    evidence: [
      { source: input.source, reason: "lexical match", weight: score },
      { source: "lexical-fallback", reason: "source type weighting", weight: typeBoost(input.type) },
    ],
  };
}

function rerankByEvidence(results: SearchResult[], query: string): SearchResult[] {
  const terms = tokenize(query);
  return results
    .map((result) => ({
      ...result,
      score: result.score + typeBoost(result.type) + coverageBoost(`${result.title} ${result.snippet}`, terms),
    }))
    .sort((a, b) => b.score - a.score || b.updatedAt.getTime() - a.updatedAt.getTime());
}

function typeBoost(type: SearchResult["type"]): number {
  switch (type) {
    case "work_artifact":
    case "deliverable": return 8;
    case "task": return 7;
    case "daily_wiki_page":
    case "wiki_page": return 6;
    case "graph_edge": return 5;
    case "graph_node": return 4;
    case "document": return 2;
  }
}

function coverageBoost(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term)).length * 2;
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean);
}

function extractSnippet(text: string, query: string, contextLength = 100): string {
  if (!text) return "";
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return text.slice(0, contextLength * 2) + (text.length > contextLength * 2 ? "..." : "");
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + query.length + contextLength);
  return `${start > 0 ? "..." : ""}${text.slice(start, end)}${end < text.length ? "..." : ""}`;
}

function createHighlight(text: string, query: string): string {
  if (!text || !query) return text || "";
  const regex = new RegExp(`(${escapeRegex(query)})`, "gi");
  return text.replace(regex, "<mark>$1</mark>");
}

function calculateScore(title: string | null, content: string, query: string, titleWeight: number, contentWeight: number): number {
  let score = 0;
  const lowerTitle = (title || "").toLowerCase();
  const lowerContent = (content || "").toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (lowerTitle.includes(lowerQuery)) score += titleWeight;
  if (lowerTitle === lowerQuery) score += 5;
  const contentMatches = (lowerContent.match(new RegExp(escapeRegex(lowerQuery), "gi")) || []).length;
  score += Math.min(contentMatches * contentWeight, 12);
  return score;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeResults(results: SearchResult[]): SearchResult[] {
  const bySource = new Map<string, SearchResult>();
  for (const result of results) {
    const key = `${result.sourceType}:${result.sourceId}`;
    const existing = bySource.get(key);
    if (!existing || result.score > existing.score) {
      bySource.set(key, existing ? mergeResultEvidence(result, existing) : result);
    }
  }
  return [...bySource.values()];
}

function mergeResultEvidence(primary: SearchResult, secondary: SearchResult): SearchResult {
  const evidence = [...primary.evidence];
  for (const item of secondary.evidence) {
    if (!evidence.some((existing) => existing.source === item.source && existing.reason === item.reason)) {
      evidence.push(item);
    }
  }
  return { ...primary, evidence };
}

function matchesFilters(result: SearchResult, options: SearchOptions): boolean {
  const sourceType = options.sourceType ?? options.type;
  if (sourceType && sourceType !== "all" && result.type !== sourceType && result.sourceType !== sourceType) return false;
  if (options.projectId && result.projectId !== options.projectId) return false;
  if (options.workObjectId && result.provenance.issueId !== options.workObjectId && result.sourceId !== options.workObjectId) return false;
  if (options.dateFrom && result.updatedAt < new Date(options.dateFrom)) return false;
  if (options.dateTo && result.updatedAt > new Date(options.dateTo)) return false;
  if (options.confidence && options.confidence !== "all" && result.confidence !== options.confidence) return false;
  if (options.contradictionStatus && options.contradictionStatus !== "all" && result.contradictionStatus !== options.contradictionStatus) return false;
  return true;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator === 0 ? 0 : dot / denominator;
}

function lexicalContains(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

function normalizeSemanticType(sourceType: string, provenance: Record<string, unknown>): SearchResult["type"] {
  if (sourceType === "work_artifact" && provenance.type === "deliverable") return "deliverable";
  if (sourceType === "daily_wiki_page") return "daily_wiki_page";
  if (sourceType === "graph_node") return "graph_node";
  if (sourceType === "graph_edge") return "graph_edge";
  if (sourceType === "work_artifact") return "work_artifact";
  return "wiki_page";
}

function titleFromSemanticChunk(sourceType: string, sourceKey: string, provenance: Record<string, unknown>): string {
  if (typeof provenance.title === "string") return provenance.title;
  if (sourceType === "graph_edge" && typeof provenance.edgeType === "string") return provenance.edgeType;
  if (sourceType === "graph_node" && typeof provenance.nodeKey === "string") return provenance.nodeKey;
  return sourceKey;
}

function normalizeFreshness(value: string): SearchResult["freshness"] {
  return value === "fresh" || value === "stale" ? value : "unknown";
}

function readConfidence(provenance: Record<string, unknown>): string {
  return typeof provenance.confidence === "string" ? provenance.confidence : "unknown";
}

function readContradictionStatus(provenance: Record<string, unknown>): SearchResult["contradictionStatus"] {
  const value = provenance.contradictionStatus;
  if (value === "none" || value === "unknown" || value === "unresolved" || value === "resolved") return value;
  return "unknown";
}

function freshnessBoost(freshness: string): number {
  return freshness === "fresh" ? 3 : freshness === "stale" ? -5 : 0;
}

function confidenceBoost(confidence: string): number {
  if (confidence === "EXTRACTED") return 4;
  if (confidence === "INFERRED") return 2;
  if (confidence === "AMBIGUOUS") return -2;
  return 0;
}
