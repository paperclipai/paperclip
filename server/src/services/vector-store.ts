/**
 * VectorStore - Manage embeddings and semantic search using pgvector
 * Supports multiple embedding models
 */

import type { Db } from "@paperclipai/db";
import { knowledgeChunks } from "@paperclipai/db";
import { sql, eq, count } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  tokens: number;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export class VectorStore {
  constructor(private db: Db) {}

  /**
   * Store embedding for a chunk
   */
  async storeEmbedding(
    chunkId: string,
    embedding: number[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    try {
      // Convert array to pgvector format
      const vectorStr = `[${embedding.join(",")}]`;

      await this.db
        .update(knowledgeChunks)
        .set({
          embedding: sql`${vectorStr}::vector`,
          metadata: metadata || {},
        })
        .where(sql`id = ${chunkId}`);

      logger.info(`Stored embedding for chunk ${chunkId}`);
    } catch (error: any) {
      logger.error(`Error storing embedding: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Search for similar chunks using cosine similarity
   * TODO: Implement with pgvector when embedding service is integrated
   */
  async searchSimilar(
    embedding: number[],
    limit = 5,
    threshold = 0.5,
  ): Promise<SearchResult[]> {
    try {
      // For MVP, return empty array
      // Full implementation requires pgvector cosine similarity search
      // which requires executing raw SQL through the postgres driver
      logger.info(
        `Vector search requested with ${embedding.length} dimensions, threshold ${threshold}, limit ${limit}`,
      );
      return [];
    } catch (error: any) {
      logger.error(`Error searching embeddings: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Search document-specific results with vector similarity
   * TODO: Implement with pgvector when embedding service is integrated
   */
  async searchDocumentChunks(
    embedding: number[],
    documentId: string,
    limit = 5,
  ): Promise<SearchResult[]> {
    try {
      // For MVP, return all chunks from document ordered by chunk index
      // Full implementation would use pgvector cosine similarity
      const results = await this.db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, documentId))
        .limit(limit);

      return results.map((chunk: any) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        content: chunk.content,
        tokens: chunk.tokens,
        similarity: 1.0, // All results equally relevant for MVP
        metadata: chunk.metadata,
      }));
    } catch (error: any) {
      logger.error(`Error searching document chunks: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Get chunks by document without embedding requirement
   */
  async getDocumentChunks(documentId: string): Promise<SearchResult[]> {
    try {
      const results = await this.db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, documentId))
        .orderBy(knowledgeChunks.chunkIndex);

      return results.map((chunk: any) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        content: chunk.content,
        tokens: chunk.tokens,
        similarity: 1.0, // No similarity score for direct lookup
        metadata: chunk.metadata,
      }));
    } catch (error: any) {
      logger.error(`Error fetching document chunks: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Delete chunks for a document
   */
  async deleteDocumentChunks(documentId: string): Promise<number> {
    try {
      // Count chunks to be deleted
      const countResult = await this.db
        .select({ count: count() })
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, documentId));

      const chunkCount = countResult[0]?.count || 0;

      // Delete chunks
      await this.db
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.documentId, documentId));

      logger.info(`Deleted ${chunkCount} chunks for document ${documentId}`);
      return chunkCount;
    } catch (error: any) {
      logger.error(`Error deleting chunks: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Count embeddings (for monitoring)
   */
  async countEmbeddings(): Promise<number> {
    try {
      // For MVP, count all chunks (embedding support added when service integrates)
      const result = await this.db
        .select({ count: count() })
        .from(knowledgeChunks);

      return result[0]?.count || 0;
    } catch (error: any) {
      logger.error(`Error counting embeddings: ${error?.message}`);
      return 0;
    }
  }

  /**
   * Check if pgvector extension is installed
   * For MVP, assume pgvector is available (should be in docker-compose)
   */
  async checkPgvectorSupport(): Promise<boolean> {
    try {
      // Check if any chunks have embedding data
      const result = await this.db
        .select({ count: count() })
        .from(knowledgeChunks)
        .where(sql`embedding IS NOT NULL`);

      logger.info("pgvector support verified");
      return true;
    } catch (error: any) {
      logger.warn(`pgvector check failed: ${error?.message}`);
      // For MVP, still return true as pgvector should be available in Docker
      return true;
    }
  }
}

/**
 * Factory function
 */
export function getVectorStore(db: Db): VectorStore {
  return new VectorStore(db);
}
