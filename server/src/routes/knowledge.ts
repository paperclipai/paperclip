import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, like, sql, isNotNull } from "drizzle-orm";
import { knowledgeChunks, knowledgeTopics, knowledgeSources } from "@paperclipai/db";

function computeCosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

function parseEmbedding(embeddingStr: string): number[] | null {
  try {
    const parsed = JSON.parse(embeddingStr);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(n => typeof n === 'number' ? n : parseFloat(n));
    }
    return null;
  } catch {
    return null;
  }
}

function simpleQueryEmbedding(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const dimension = 384;
  const embedding = new Array(dimension).fill(0);
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let hash = 0;
    for (let j = 0; j < word.length; j++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(j);
      hash = hash & hash;
    }
    
    for (let j = 0; j < Math.min(word.length, dimension); j++) {
      const idx = Math.abs(hash + j) % dimension;
      embedding[idx] += (word.charCodeAt(j) / 255) * (1 / (i + 1));
    }
  }
  
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < embedding.length; i++) {
      embedding[i] /= magnitude;
    }
  }
  
  return embedding;
}

function computeKeywordScore(content: string, title: string, query: string): number {
  const contentLower = content.toLowerCase();
  const titleLower = title.toLowerCase();
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  if (queryWords.length === 0) return 0.5;
  
  let score = 0;
  let maxPossible = 0;
  
  for (const word of queryWords) {
    maxPossible += 3;
    const contentMatches = (contentLower.match(new RegExp(word, 'g')) || []).length;
    const titleMatches = (titleLower.match(new RegExp(word, 'g')) || []).length;
    score += Math.min(contentMatches, 3);
    score += Math.min(titleMatches, 3) * 2;
  }
  
  return Math.min(1, score / maxPossible);
}

function hybridScore(keywordScore: number, vectorScore: number | null, vectorWeight = 0.6): number {
  if (vectorScore === null) {
    return keywordScore;
  }
  return (1 - vectorWeight) * keywordScore + vectorWeight * vectorScore;
}

export function knowledgeRoutes(db: Db) {
  const router = Router();

  router.get("/topics", async (_req, res) => {
    try {
      const topics = await db
        .select({
          id: knowledgeTopics.id,
          name: knowledgeTopics.name,
          slug: knowledgeTopics.slug,
          description: knowledgeTopics.description,
          tier: knowledgeTopics.tier,
          status: knowledgeTopics.status,
          refreshIntervalHours: knowledgeTopics.refreshIntervalHours,
          lastCrawledAt: knowledgeTopics.lastCrawledAt,
          nextCrawlAt: knowledgeTopics.nextCrawlAt,
          chunkCount: knowledgeTopics.chunkCount,
        })
        .from(knowledgeTopics)
        .where(eq(knowledgeTopics.status, "active"))
        .orderBy(knowledgeTopics.tier);

      res.json({ topics });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch topics" });
    }
  });

  router.get("/search", async (req, res) => {
    const { q, topic, limit = "10" } = req.query;

    if (!q || typeof q !== "string") {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    const limitNum = Math.min(parseInt(limit as string, 10) || 10, 50);
    const query = q.trim();

    try {
      const queryEmbedding = simpleQueryEmbedding(query);
      const conditions = [isNotNull(knowledgeChunks.embedding)];

      if (topic && typeof topic === "string") {
        conditions.push(
          sql`EXISTS (
            SELECT 1 FROM knowledge_topics kt 
            WHERE kt.slug = ${topic} AND kt.id = knowledge_chunks.topic_id
          )`
        );
      }

      const chunkResults = await db
        .select({
          id: knowledgeChunks.id,
          title: knowledgeChunks.title,
          url: knowledgeChunks.url,
          urlPath: knowledgeChunks.urlPath,
          content: sql<string>`SUBSTRING(${knowledgeChunks.content}, 1, 300)`,
          fullContent: knowledgeChunks.content,
          topicSlug: knowledgeTopics.slug,
          sourceType: knowledgeSources.sourceType,
          embedding: knowledgeChunks.embedding,
          bm25Score: knowledgeChunks.bm25Score,
        })
        .from(knowledgeChunks)
        .innerJoin(
          knowledgeTopics,
          eq(knowledgeChunks.topicId, knowledgeTopics.id)
        )
        .innerJoin(
          knowledgeSources,
          eq(knowledgeChunks.sourceId, knowledgeSources.id)
        )
        .where(
          conditions.length > 0
            ? and(
                like(knowledgeChunks.content, `%${query}%`),
                ...conditions
              )
            : like(knowledgeChunks.content, `%${query}%`)
        )
        .orderBy(desc(knowledgeChunks.updatedAt))
        .limit(limitNum * 2);

      const scoredResults = chunkResults
        .map((row) => {
          const keywordScore = computeKeywordScore(row.content, row.title, query);
          const storedEmbedding = parseEmbedding(row.embedding);
          const vectorScore = storedEmbedding 
            ? computeCosineSimilarity(queryEmbedding, storedEmbedding) 
            : null;
          const score = hybridScore(keywordScore, vectorScore, 0.6);

          return {
            id: row.id,
            title: row.title,
            url: row.url,
            urlPath: row.urlPath,
            snippet: row.content,
            score,
            sourceType: row.sourceType,
            topic: row.topicSlug,
          };
        })
        .filter(r => r.score > 0.1)
        .sort((a, b) => b.score - a.score)
        .slice(0, limitNum);

      const hasVectorScores = scoredResults.some(r => {
        const row = chunkResults.find(cr => cr.id === r.id);
        return row && parseEmbedding(row.embedding) !== null;
      });

      res.json({
        query,
        topic: topic || null,
        results: scoredResults,
        total: scoredResults.length,
        searchType: hasVectorScores ? "hybrid" : "keyword",
      });
    } catch (error) {
      res.status(500).json({ error: "Search failed" });
    }
  });

  router.post("/research", async (req, res) => {
    const { topic, question } = req.body;

    if (!question || typeof question !== "string") {
      res.status(400).json({ error: "Field 'question' is required" });
      return;
    }

    if (!topic || typeof topic !== "string") {
      res.status(400).json({ error: "Field 'topic' is required" });
      return;
    }

    try {
      const chunks = await db
        .select({
          id: knowledgeChunks.id,
          title: knowledgeChunks.title,
          url: knowledgeChunks.url,
          content: knowledgeChunks.content,
        })
        .from(knowledgeChunks)
        .innerJoin(
          knowledgeTopics,
          eq(knowledgeChunks.topicId, knowledgeTopics.id)
        )
        .where(
          and(
            eq(knowledgeTopics.slug, topic),
            like(knowledgeChunks.content, `%${question}%`)
          )
        )
        .orderBy(desc(knowledgeChunks.updatedAt))
        .limit(10);

      if (chunks.length === 0) {
        res.json({
          question,
          answer: "No relevant information found for this topic.",
          sources: [],
          citedChunks: [],
        });
        return;
      }

      const relevantContent = chunks
        .map((c) => c.content)
        .join("\n\n")
        .slice(0, 2000);

      const answer = `Based on the ${topic} documentation, here is relevant information:\n\n${relevantContent}`;

      const sources = chunks.map((c) => ({
        title: c.title,
        url: c.url,
      }));

      res.json({
        question,
        answer,
        sources,
        citedChunks: chunks.map((c) => c.id),
      });
    } catch (error) {
      res.status(500).json({ error: "Research failed" });
    }
  });

  router.get("/sources/:topicSlug", async (req, res) => {
    const { topicSlug } = req.params;

    try {
      const sources = await db
        .select({
          id: knowledgeSources.id,
          url: knowledgeSources.url,
          sourceType: knowledgeSources.sourceType,
          title: knowledgeSources.title,
          robotsAllowed: knowledgeSources.robotsAllowed,
          pageCount: knowledgeSources.pageCount,
          lastCrawledAt: knowledgeSources.lastCrawledAt,
          lastError: knowledgeSources.lastError,
        })
        .from(knowledgeSources)
        .innerJoin(
          knowledgeTopics,
          eq(knowledgeSources.topicId, knowledgeTopics.id)
        )
        .where(eq(knowledgeTopics.slug, topicSlug));

      res.json({ sources });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch sources" });
    }
  });

  return router;
}