import { Client } from "pg";
import type { KnowledgeTopic, KnowledgeSource, KnowledgeChunk, KnowledgeCrawlRun } from "@paperclipai/db/src/schema/knowledge";

export class KnowledgeDb {
  private client: Client | null = null;

  async initialize(): Promise<void> {
    this.client = new Client({
      connectionString: process.env.DATABASE_URL,
    });
    await this.client.connect();
  }

  async getActiveTopics(): Promise<KnowledgeTopic[]> {
    if (!this.client) throw new Error("DB not initialized");
    
    const result = await this.client.query<KnowledgeTopic>(
      `SELECT * FROM knowledge_topics WHERE status = 'active' ORDER BY tier ASC`
    );
    return result.rows;
  }

  async createCrawlRun(params: {
    sourceId: string;
    topicId: string;
    status: string;
  }): Promise<KnowledgeCrawlRun> {
    if (!this.client) throw new Error("DB not initialized");
    
    const result = await this.client.query<KnowledgeCrawlRun>(
      `INSERT INTO knowledge_crawl_runs (source_id, topic_id, status)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [params.sourceId, params.topicId, params.status]
    );
    return result.rows[0];
  }

  async completeCrawlRun(id: string, stats: {
    pagesDiscovered: number;
    pagesCrawled: number;
    pagesIndexed: number;
    chunksCreated: number;
  }): Promise<void> {
    if (!this.client) throw new Error("DB not initialized");
    
    await this.client.query(
      `UPDATE knowledge_crawl_runs
       SET status = 'completed',
           completed_at = NOW(),
           pages_discovered = $2,
           pages_crawled = $3,
           pages_indexed = $4,
           chunks_created = $5
       WHERE id = $1`,
      [id, stats.pagesDiscovered, stats.pagesCrawled, stats.pagesIndexed, stats.chunksCreated]
    );
  }

  async failCrawlRun(id: string, error: {
    errorMessage: string;
    errorCode: string;
  }): Promise<void> {
    if (!this.client) throw new Error("DB not initialized");
    
    await this.client.query(
      `UPDATE knowledge_crawl_runs
       SET status = 'failed',
           completed_at = NOW(),
           error_message = $2,
           error_code = $3
       WHERE id = $1`,
      [id, error.errorMessage, error.errorCode]
    );
  }

  async createChunk(params: {
    sourceId: string;
    topicId: string;
    url: string;
    urlPath: string;
    title: string;
    content: string;
    contentHash: string;
    embedding: string;
    bm25Score: string | null;
    chunkIndex: number;
    tokenEstimate: number;
    heading?: string;
    section?: string;
  }): Promise<KnowledgeChunk> {
    if (!this.client) throw new Error("DB not initialized");
    
    const result = await this.client.query<KnowledgeChunk>(
      `INSERT INTO knowledge_chunks
       (source_id, topic_id, url, url_path, title, content, content_hash, embedding, bm25_score, chunk_index, token_estimate, heading, section)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (content_hash) DO NOTHING
       RETURNING *`,
      [
        params.sourceId,
        params.topicId,
        params.url,
        params.urlPath,
        params.title,
        params.content,
        params.contentHash,
        params.embedding,
        params.bm25Score,
        params.chunkIndex,
        params.tokenEstimate,
        params.heading || null,
        params.section || null,
      ]
    );
    return result.rows[0];
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }
}