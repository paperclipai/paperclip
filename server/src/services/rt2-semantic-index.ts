import { createHash } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  rt2V33DailyWikiPages,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33SemanticIndexChunks,
  rt2V33SemanticIndexRuns,
  type Rt2SemanticIndexSourceType,
} from "@paperclipai/db";

export type Rt2SemanticEmbedding = {
  vector: number[];
  model: string;
  provider: string;
};

export type Rt2SemanticEmbeddingProvider = {
  embed(text: string): Promise<Rt2SemanticEmbedding>;
};

export type Rt2SemanticIndexMode = "full" | "changed";

export type Rt2SemanticIndexRunResult = {
  runId: string;
  companyId: string;
  mode: Rt2SemanticIndexMode;
  status: "completed" | "error";
  providerMode: "provider" | "fallback";
  embeddingModel: string;
  sourcesScanned: number;
  chunksRefreshed: number;
  chunksSkipped: number;
  errorMessage: string | null;
};

export type Rt2SemanticIndexStatus = {
  companyId: string;
  indexedChunks: number;
  sourceCount: number;
  staleChunks: number;
  providerMode: "provider" | "fallback" | null;
  embeddingModel: string | null;
  lastRun: {
    id: string;
    mode: Rt2SemanticIndexMode;
    status: "running" | "completed" | "error";
    providerMode: "provider" | "fallback";
    embeddingModel: string;
    sourcesScanned: number;
    chunksRefreshed: number;
    chunksSkipped: number;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null;
};

type SemanticSource = {
  sourceType: Rt2SemanticIndexSourceType;
  sourceId: string;
  sourceKey: string;
  companyId: string;
  projectId: string | null;
  text: string;
  sourceUpdatedAt: Date;
  provenance: Record<string, unknown>;
};

const FALLBACK_DIMENSION = 32;
const FALLBACK_MODEL = "rt2-deterministic-tokenhash-v1";
const FALLBACK_PROVIDER = "local_fallback";
const MAX_CHUNK_LENGTH = 1_200;

export function deterministicSemanticEmbedding(text: string): Rt2SemanticEmbedding {
  const vector = new Array<number>(FALLBACK_DIMENSION).fill(0);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    const index = digest[0] % FALLBACK_DIMENSION;
    const sign = digest[1] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return {
    vector: vector.map((value) => Number((value / magnitude).toFixed(6))),
    model: FALLBACK_MODEL,
    provider: FALLBACK_PROVIDER,
  };
}

export function rt2SemanticIndexService(
  db: Db,
  options: { embeddingProvider?: Rt2SemanticEmbeddingProvider } = {},
) {
  const providerMode: "provider" | "fallback" = options.embeddingProvider ? "provider" : "fallback";

  async function reindexCompany(
    companyId: string,
    input: { mode?: Rt2SemanticIndexMode } = {},
  ): Promise<Rt2SemanticIndexRunResult> {
    const mode = input.mode ?? "changed";
    const fallbackProbe = deterministicSemanticEmbedding("");
    const embeddingModel = options.embeddingProvider ? "provider" : fallbackProbe.model;
    const [run] = await db.insert(rt2V33SemanticIndexRuns).values({
      companyId,
      mode,
      status: "running",
      providerMode,
      embeddingModel,
    }).returning();

    let sourcesScanned = 0;
    let chunksRefreshed = 0;
    let chunksSkipped = 0;

    try {
      const sources = await collectSources(companyId);
      sourcesScanned = sources.length;

      for (const source of sources) {
        const result = await indexSource(source, mode);
        chunksRefreshed += result.refreshed;
        chunksSkipped += result.skipped;
      }

      await db.update(rt2V33SemanticIndexRuns).set({
        status: "completed",
        sourcesScanned,
        chunksRefreshed,
        chunksSkipped,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(rt2V33SemanticIndexRuns.id, run.id));

      return {
        runId: run.id,
        companyId,
        mode,
        status: "completed",
        providerMode,
        embeddingModel,
        sourcesScanned,
        chunksRefreshed,
        chunksSkipped,
        errorMessage: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.update(rt2V33SemanticIndexRuns).set({
        status: "error",
        sourcesScanned,
        chunksRefreshed,
        chunksSkipped,
        errorMessage: message,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(rt2V33SemanticIndexRuns.id, run.id));

      return {
        runId: run.id,
        companyId,
        mode,
        status: "error",
        providerMode,
        embeddingModel,
        sourcesScanned,
        chunksRefreshed,
        chunksSkipped,
        errorMessage: message,
      };
    }
  }

  async function getStatus(companyId: string): Promise<Rt2SemanticIndexStatus> {
    const [chunkStats, sourceStats, staleStats, lastRun] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33SemanticIndexChunks)
        .where(eq(rt2V33SemanticIndexChunks.companyId, companyId))
        .then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(distinct ${rt2V33SemanticIndexChunks.sourceType} || ':' || ${rt2V33SemanticIndexChunks.sourceId})::int` })
        .from(rt2V33SemanticIndexChunks)
        .where(eq(rt2V33SemanticIndexChunks.companyId, companyId))
        .then((rows) => rows[0]?.count ?? 0),
      db.select({ count: sql<number>`count(*)::int` })
        .from(rt2V33SemanticIndexChunks)
        .where(and(eq(rt2V33SemanticIndexChunks.companyId, companyId), eq(rt2V33SemanticIndexChunks.freshness, "stale")))
        .then((rows) => rows[0]?.count ?? 0),
      db.select()
        .from(rt2V33SemanticIndexRuns)
        .where(eq(rt2V33SemanticIndexRuns.companyId, companyId))
        .orderBy(desc(rt2V33SemanticIndexRuns.startedAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      companyId,
      indexedChunks: chunkStats,
      sourceCount: sourceStats,
      staleChunks: staleStats,
      providerMode: lastRun?.providerMode ?? null,
      embeddingModel: lastRun?.embeddingModel ?? null,
      lastRun: lastRun ? {
        id: lastRun.id,
        mode: lastRun.mode,
        status: lastRun.status,
        providerMode: lastRun.providerMode,
        embeddingModel: lastRun.embeddingModel,
        sourcesScanned: lastRun.sourcesScanned,
        chunksRefreshed: lastRun.chunksRefreshed,
        chunksSkipped: lastRun.chunksSkipped,
        errorMessage: lastRun.errorMessage,
        startedAt: lastRun.startedAt,
        completedAt: lastRun.completedAt,
      } : null,
    };
  }

  async function collectSources(companyId: string): Promise<SemanticSource[]> {
    const [dailyPages, graphNodes, graphEdges, workProducts] = await Promise.all([
      db.select().from(rt2V33DailyWikiPages).where(eq(rt2V33DailyWikiPages.companyId, companyId)),
      db.select().from(rt2V33GraphNodes).where(eq(rt2V33GraphNodes.companyId, companyId)),
      db.select().from(rt2V33GraphEdges).where(eq(rt2V33GraphEdges.companyId, companyId)),
      db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
    ]);

    return [
      ...dailyPages.map((page): SemanticSource => ({
        sourceType: "daily_wiki_page",
        sourceId: page.id,
        sourceKey: page.pageKey,
        companyId: page.companyId,
        projectId: page.projectId,
        sourceUpdatedAt: page.updatedAt,
        text: [
          page.pageKey,
          page.shortSummary.join("\n"),
          page.markdown,
          page.history.map((entry) => entry.summary).join("\n"),
        ].filter(Boolean).join("\n\n"),
        provenance: {
          pageKey: page.pageKey,
          reportDate: String(page.reportDate),
          userId: page.userId,
          sourceEventIds: page.sourceEventIds,
        },
      })),
      ...graphNodes.map((node): SemanticSource => ({
        sourceType: "graph_node",
        sourceId: node.id,
        sourceKey: node.nodeKey,
        companyId: node.companyId,
        projectId: node.projectId,
        sourceUpdatedAt: node.updatedAt,
        text: [node.label, node.nodeType, node.nodeKey, JSON.stringify(node.metadata ?? {})].join("\n"),
        provenance: {
          nodeKey: node.nodeKey,
          nodeType: node.nodeType,
          sourceId: node.sourceId,
          reportDate: node.reportDate ? String(node.reportDate) : null,
          centrality: node.centrality,
          isGodNode: node.isGodNode,
        },
      })),
      ...graphEdges.map((edge): SemanticSource => ({
        sourceType: "graph_edge",
        sourceId: edge.id,
        sourceKey: `${edge.edgeType}:${edge.id}`,
        companyId: edge.companyId,
        projectId: edge.projectId,
        sourceUpdatedAt: edge.updatedAt,
        text: [edge.edgeType, edge.confidence, edge.rationale, JSON.stringify(edge.evidence ?? [])].join("\n"),
        provenance: {
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: edge.targetNodeId,
          edgeType: edge.edgeType,
          confidence: edge.confidence,
          confidenceScore: edge.confidenceScore,
          evidence: edge.evidence,
        },
      })),
      ...workProducts.map((artifact): SemanticSource => ({
        sourceType: "work_artifact",
        sourceId: artifact.id,
        sourceKey: artifact.externalId ?? artifact.id,
        companyId: artifact.companyId,
        projectId: artifact.projectId,
        sourceUpdatedAt: artifact.updatedAt,
        text: [
          artifact.title,
          artifact.summary ?? "",
          artifact.type,
          artifact.status,
          artifact.reviewState,
          artifact.healthStatus,
          JSON.stringify(artifact.metadata ?? {}),
        ].filter(Boolean).join("\n"),
        provenance: {
          issueId: artifact.issueId,
          provider: artifact.provider,
          externalId: artifact.externalId,
          type: artifact.type,
          status: artifact.status,
          reviewState: artifact.reviewState,
          healthStatus: artifact.healthStatus,
        },
      })),
    ];
  }

  async function indexSource(source: SemanticSource, mode: Rt2SemanticIndexMode): Promise<{ refreshed: number; skipped: number }> {
    const chunks = chunkSource(source);
    let refreshed = 0;
    let skipped = 0;

    if (chunks.length === 0) {
      await db.delete(rt2V33SemanticIndexChunks).where(and(
        eq(rt2V33SemanticIndexChunks.companyId, source.companyId),
        eq(rt2V33SemanticIndexChunks.sourceType, source.sourceType),
        eq(rt2V33SemanticIndexChunks.sourceId, source.sourceId),
      ));
      return { refreshed, skipped };
    }

    const existingRows = await db.select()
      .from(rt2V33SemanticIndexChunks)
      .where(and(
        eq(rt2V33SemanticIndexChunks.companyId, source.companyId),
        eq(rt2V33SemanticIndexChunks.sourceType, source.sourceType),
        eq(rt2V33SemanticIndexChunks.sourceId, source.sourceId),
      ));
    const existingByChunkKey = new Map(existingRows.map((row) => [row.chunkKey, row]));

    for (const chunk of chunks) {
      const existing = existingByChunkKey.get(chunk.chunkKey);
      if (
        mode === "changed" &&
        existing?.contentHash === chunk.contentHash &&
        existing.embeddingProvider === (options.embeddingProvider ? "provider" : FALLBACK_PROVIDER)
      ) {
        skipped += 1;
        continue;
      }

      const embedding = options.embeddingProvider
        ? await options.embeddingProvider.embed(chunk.chunkText)
        : deterministicSemanticEmbedding(chunk.chunkText);

      await db.insert(rt2V33SemanticIndexChunks).values({
        companyId: source.companyId,
        projectId: source.projectId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        sourceKey: source.sourceKey,
        chunkKey: chunk.chunkKey,
        chunkText: chunk.chunkText,
        contentHash: chunk.contentHash,
        embedding: embedding.vector,
        embeddingModel: embedding.model,
        embeddingProvider: embedding.provider,
        embeddingDimension: embedding.vector.length,
        sourceUpdatedAt: source.sourceUpdatedAt,
        freshness: "fresh",
        provenance: source.provenance,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [
          rt2V33SemanticIndexChunks.companyId,
          rt2V33SemanticIndexChunks.sourceType,
          rt2V33SemanticIndexChunks.sourceId,
          rt2V33SemanticIndexChunks.chunkKey,
        ],
        set: {
          sourceKey: source.sourceKey,
          chunkText: chunk.chunkText,
          contentHash: chunk.contentHash,
          embedding: embedding.vector,
          embeddingModel: embedding.model,
          embeddingProvider: embedding.provider,
          embeddingDimension: embedding.vector.length,
          sourceUpdatedAt: source.sourceUpdatedAt,
          freshness: "fresh",
          provenance: source.provenance,
          updatedAt: new Date(),
        },
      });
      refreshed += 1;
    }

    const currentChunkKeys = chunks.map((chunk) => chunk.chunkKey);
    if (currentChunkKeys.length > 0) {
      await db.delete(rt2V33SemanticIndexChunks).where(and(
        eq(rt2V33SemanticIndexChunks.companyId, source.companyId),
        eq(rt2V33SemanticIndexChunks.sourceType, source.sourceType),
        eq(rt2V33SemanticIndexChunks.sourceId, source.sourceId),
        notInArray(rt2V33SemanticIndexChunks.chunkKey, currentChunkKeys),
      ));
    }

    return { refreshed, skipped };
  }

  return { reindexCompany, getStatus, collectSources };
}

function chunkSource(source: SemanticSource): Array<{ chunkKey: string; chunkText: string; contentHash: string }> {
  const text = source.text.trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > MAX_CHUNK_LENGTH) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((chunkText, index) => {
    const contentHash = hashText(chunkText);
    return {
      chunkKey: `${source.sourceType}:${source.sourceId}:${index}`,
      chunkText,
      contentHash,
    };
  });
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}
