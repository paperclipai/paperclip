import { and, eq, sql, desc } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { knowledgePages, knowledgeChunks } from "@ironworksai/db";
import { parsePlaybook } from "./playbook-chunker.js";
import { embedBatch, embedText } from "./ollama-embed.js";
import {
  buildChunkCacheKey,
  getCachedChunks,
  setCachedChunks,
  invalidateAllCaches,
} from "./playbook-chunk-cache.js";
import { logger } from "../middleware/logger.js";

/**
 * RAG over playbooks: chunk, embed, lookup.
 *
 * Embedding model: nomic-embed-text via Ollama Cloud (768 dims).
 *
 * Lookup strategy:
 *   1. Embed the query.
 *   2. Cosine-similarity top-K against knowledge_chunks.embedding.
 *   3. If embedding fails (Ollama down) OR no chunks have embeddings,
 *      fall back to Postgres FTS over heading_path + body.
 */

/**
 * Reindex one playbook page: parse, chunk, embed, upsert.
 *
 * Returns the number of chunks inserted. Safe to call repeatedly; drops
 * and rebuilds all chunks for the page.
 */
export async function reindexPage(db: Db, pageId: string): Promise<number> {
  const [page] = await db.select().from(knowledgePages).where(eq(knowledgePages.id, pageId)).limit(1);
  if (!page) {
    throw new Error(`knowledge_pages row not found: ${pageId}`);
  }

  const parsed = parsePlaybook(page.body);
  if (parsed.chunks.length === 0) {
    logger.warn({ pageId, slug: page.slug }, "playbook-rag: page produced zero chunks, skipping");
    return 0;
  }

  // Delete existing chunks for this page (simpler than diff/update)
  await db.delete(knowledgeChunks).where(eq(knowledgeChunks.pageId, pageId));

  const fm = parsed.frontmatter;
  const rows = parsed.chunks.map((chunk) => ({
    pageId: page.id,
    companyId: page.companyId,
    department: (fm.department as string) ?? page.department ?? null,
    ownerRole: (fm.owner_role as string) ?? null,
    audience: (fm.audience as string) ?? null,
    documentType: (fm.document_type as string) ?? page.documentType ?? null,
    anchor: chunk.anchor,
    heading: chunk.heading,
    headingPath: chunk.headingPath,
    body: chunk.body,
    tokenCount: chunk.tokenCount,
    orderNum: chunk.orderNum,
    sourceRevision: page.revisionNumber,
    embedding: null as unknown as number[] | null,
  }));

  const inserted = await db.insert(knowledgeChunks).values(rows).returning({ id: knowledgeChunks.id });

  // Embed in batches. Failure here is non-fatal: chunks still exist
  // and FTS fallback covers retrieval.
  const BATCH_SIZE = 16;
  const bodies = rows.map((r) => `${r.heading}\n\n${r.body}`);
  let embedded = 0;

  for (let i = 0; i < bodies.length; i += BATCH_SIZE) {
    const batch = bodies.slice(i, i + BATCH_SIZE);
    const batchIds = inserted.slice(i, i + BATCH_SIZE);
    try {
      const results = await embedBatch(batch);
      for (let j = 0; j < results.length; j++) {
        await db
          .update(knowledgeChunks)
          .set({ embedding: results[j].embedding, updatedAt: new Date() })
          .where(eq(knowledgeChunks.id, batchIds[j].id));
        embedded += 1;
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, pageId, slug: page.slug, batchStart: i },
        "playbook-rag: embedding batch failed; chunks inserted without embeddings (FTS fallback active)",
      );
    }
  }

  logger.info(
    { pageId, slug: page.slug, chunks: rows.length, embedded },
    "playbook-rag: reindexed page",
  );

  return rows.length;
}

/**
 * Reindex all playbook pages for a company.
 */
export async function reindexAllPlaybooks(db: Db, companyId: string): Promise<{ pages: number; chunks: number }> {
  const pages = await db
    .select({ id: knowledgePages.id, slug: knowledgePages.slug })
    .from(knowledgePages)
    .where(and(eq(knowledgePages.companyId, companyId), eq(knowledgePages.documentType, "playbook")));

  let totalChunks = 0;
  for (const page of pages) {
    try {
      totalChunks += await reindexPage(db, page.id);
    } catch (err) {
      logger.error({ err: (err as Error).message, pageId: page.id, slug: page.slug }, "playbook-rag: page reindex failed");
    }
  }

  // Chunk IDs are regenerated on every reindex (delete + insert), so any
  // cached LookupResult arrays now reference dead IDs. Drop all caches.
  invalidateAllCaches();

  return { pages: pages.length, chunks: totalChunks };
}

/**
 * Semantic lookup over a company's playbook chunks.
 */
export interface LookupOptions {
  companyId: string;
  query: string;
  department?: string;
  ownerRole?: string;
  documentType?: string;
  topK?: number;
  /**
   * Optional agent ID for per-agent session caching. When provided,
   * results are cached for 1 hour and identical subsequent queries
   * skip the DB hit and the Ollama embed call.
   */
  agentId?: string;
}

export interface LookupResult {
  chunkId: string;
  pageId: string;
  anchor: string;
  heading: string;
  headingPath: string;
  body: string;
  tokenCount: number;
  department: string | null;
  ownerRole: string | null;
  score: number;          // cosine similarity (1 - distance) or ts_rank; higher is better
  mode: "vector" | "fts";
}

/**
 * Lookup top-K chunks. Tries vector cosine first, falls back to FTS on
 * embedding failure or zero embedded chunks.
 */
export async function lookupPlaybook(db: Db, opts: LookupOptions): Promise<LookupResult[]> {
  const topK = Math.min(Math.max(opts.topK ?? 3, 1), 10);
  const { companyId, query, department, ownerRole, documentType, agentId } = opts;

  // Session cache check (per-agent, 1hr TTL)
  if (agentId) {
    const cacheKey = buildChunkCacheKey({ query, department, ownerRole, documentType, topK });
    const cached = getCachedChunks<LookupResult[]>(agentId, cacheKey);
    if (cached) {
      logger.debug({ agentId, cacheKey: cacheKey.slice(0, 60) }, "playbook-rag: cache hit");
      return cached;
    }
  }

  const filters = [eq(knowledgeChunks.companyId, companyId)];
  if (department) filters.push(eq(knowledgeChunks.department, department));
  if (documentType) filters.push(eq(knowledgeChunks.documentType, documentType));
  if (ownerRole) filters.push(sql`${knowledgeChunks.ownerRole} ILIKE ${"%" + ownerRole + "%"}`);

  // Try vector mode first
  let queryEmbedding: number[] | null = null;
  try {
    const result = await embedText(query);
    queryEmbedding = result.embedding;
  } catch (err) {
    logger.warn({ err: (err as Error).message, query: query.slice(0, 80) }, "playbook-rag: query embed failed; falling back to FTS");
  }

  if (queryEmbedding) {
    const embeddingLit = `[${queryEmbedding.join(",")}]`;

    const rows = await db
      .select({
        chunkId: knowledgeChunks.id,
        pageId: knowledgeChunks.pageId,
        anchor: knowledgeChunks.anchor,
        heading: knowledgeChunks.heading,
        headingPath: knowledgeChunks.headingPath,
        body: knowledgeChunks.body,
        tokenCount: knowledgeChunks.tokenCount,
        department: knowledgeChunks.department,
        ownerRole: knowledgeChunks.ownerRole,
        distance: sql<number>`${knowledgeChunks.embedding} <=> ${embeddingLit}::vector`,
      })
      .from(knowledgeChunks)
      .where(and(...filters, sql`${knowledgeChunks.embedding} IS NOT NULL`))
      .orderBy(sql`${knowledgeChunks.embedding} <=> ${embeddingLit}::vector`)
      .limit(topK);

    if (rows.length > 0) {
      const results = rows.map((r) => ({
        chunkId: r.chunkId,
        pageId: r.pageId,
        anchor: r.anchor,
        heading: r.heading,
        headingPath: r.headingPath,
        body: r.body,
        tokenCount: r.tokenCount,
        department: r.department,
        ownerRole: r.ownerRole,
        // Convert cosine distance [0..2] to similarity [1..-1]; clamp to [0..1] for UX
        score: Math.max(0, 1 - Number(r.distance)),
        mode: "vector" as const,
      }));
      if (agentId) {
        const cacheKey = buildChunkCacheKey({ query, department, ownerRole, documentType, topK });
        setCachedChunks(agentId, cacheKey, results);
      }
      return results;
    }

    logger.info({ companyId, query: query.slice(0, 80) }, "playbook-rag: no embedded chunks matched, falling back to FTS");
  }

  // FTS fallback: ts_rank over heading_path + body
  const terms = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && t.length <= 32)
    .slice(0, 20);
  if (terms.length === 0) return [];

  const tsquery = terms.map((t) => `${t}:*`).join(" | ");

  const ftsRows = await db
    .select({
      chunkId: knowledgeChunks.id,
      pageId: knowledgeChunks.pageId,
      anchor: knowledgeChunks.anchor,
      heading: knowledgeChunks.heading,
      headingPath: knowledgeChunks.headingPath,
      body: knowledgeChunks.body,
      tokenCount: knowledgeChunks.tokenCount,
      department: knowledgeChunks.department,
      ownerRole: knowledgeChunks.ownerRole,
      score: sql<number>`ts_rank(to_tsvector('english', ${knowledgeChunks.headingPath} || ' ' || ${knowledgeChunks.body}), to_tsquery('english', ${tsquery}))`,
    })
    .from(knowledgeChunks)
    .where(
      and(
        ...filters,
        sql`to_tsvector('english', ${knowledgeChunks.headingPath} || ' ' || ${knowledgeChunks.body}) @@ to_tsquery('english', ${tsquery})`,
      ),
    )
    .orderBy(desc(sql`ts_rank(to_tsvector('english', ${knowledgeChunks.headingPath} || ' ' || ${knowledgeChunks.body}), to_tsquery('english', ${tsquery}))`))
    .limit(topK);

  const ftsResults = ftsRows.map((r) => ({
    ...r,
    score: Number(r.score),
    mode: "fts" as const,
  }));
  if (agentId) {
    const cacheKey = buildChunkCacheKey({ query, department, ownerRole, documentType, topK });
    setCachedChunks(agentId, cacheKey, ftsResults);
  }
  return ftsResults;
}
