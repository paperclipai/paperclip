import type { WeKnoraConfig } from "../config.js";
import type { WeKnoraClient } from "../client/weknora-client.js";

function clip(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return { content: value.slice(0, maxChars), truncated: true };
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(max, value) : fallback;
}

export function createRetrievalService(client: WeKnoraClient, config: WeKnoraConfig) {
  return {
    async listKnowledgeBases() {
      return client.listKnowledgeBases();
    },

    async search(input: { query: string; knowledgeBaseIds?: string[]; knowledgeIds?: string[]; maxResults?: number }) {
      const result = await client.search({
        query: input.query.trim().slice(0, 4000),
        knowledgeBaseIds: input.knowledgeBaseIds?.slice(0, 50),
        knowledgeIds: input.knowledgeIds?.slice(0, 50),
        maxResults: Math.min(config.maxResults, positiveInt(input.maxResults, config.maxResults, 50)),
      });
      return {
        results: result.results.slice(0, config.maxResults).map((item) => ({
          ...item,
          ...clip(item.content, config.maxChunkChars),
        })),
      };
    },

    async readDocument(input: { knowledgeId: string; page?: number; pageSize?: number }) {
      const page = positiveInt(input.page, 1, 100000);
      const pageSize = positiveInt(input.pageSize, config.maxResults, 50);
      const document = await client.readKnowledge(input.knowledgeId);
      const chunkResult = document.chunks
        ? { chunks: document.chunks.slice((page - 1) * pageSize, page * pageSize), total: document.total }
        : await client.listChunks(input.knowledgeId, page, pageSize);
      const chunks = chunkResult.chunks.map((item) => ({ index: item.index, ...clip(item.content, config.maxChunkChars) }));
      const hasMore = chunkResult.total != null
        ? page * pageSize < chunkResult.total
        : chunkResult.chunks.length >= pageSize;
      return { document: document.document, chunks, page, pageSize, hasMore };
    },
  };
}
