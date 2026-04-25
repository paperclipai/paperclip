import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { knowledgeChunks, knowledgeTopics, knowledgeSources } from "@paperclipai/db";

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
      const conditions = [];

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
          topicSlug: knowledgeTopics.slug,
          sourceType: knowledgeSources.sourceType,
          embedding: knowledgeChunks.embedding,
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
        .limit(limitNum);

      const results = chunkResults.map((row) => {
        let score = 0.5;

        const queryLower = query.toLowerCase();
        const contentLower = row.content.toLowerCase();
        const titleLower = row.title.toLowerCase();

        const queryWords = queryLower.split(/\s+/);
        let matchCount = 0;
        for (const word of queryWords) {
          if (contentLower.includes(word)) matchCount++;
          if (titleLower.includes(word)) matchCount += 2;
        }
        score = Math.min(1, matchCount / (queryWords.length * 3));

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
      });

      res.json({
        query,
        topic: topic || null,
        results,
        total: results.length,
        searchType: "keyword",
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