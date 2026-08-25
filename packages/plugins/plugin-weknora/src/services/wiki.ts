import type { WeKnoraConfig } from "../config.js";
import type { WeKnoraClient } from "../client/weknora-client.js";
import { boundWikiPage, boundWikiPageSummary, boundWikiSearchResult } from "../client/response-codecs.js";

function pageNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(100000, value) : fallback;
}

function pageSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(50, value) : fallback;
}

export function createWikiService(client: WeKnoraClient, config: WeKnoraConfig) {
  return {
    async listPages(input: { knowledgeBaseId: string; page?: number; pageSize?: number }) {
      const page = pageNumber(input.page, 1);
      const size = pageSize(input.pageSize, config.maxResults);
      const result = await client.listWikiPages(input.knowledgeBaseId, page, size);
      return { pages: result.pages.slice(0, size).map(boundWikiPageSummary), page, pageSize: size, hasMore: result.total != null ? page * size < result.total : result.pages.length >= size };
    },
    async readPage(input: { knowledgeBaseId: string; slug: string }) {
      const result = await client.readWikiPage(input.knowledgeBaseId, input.slug);
      const maxChars = Math.min(10000, config.maxChunkChars * 10);
      return { page: boundWikiPage(result.page, maxChars) };
    },
    async search(input: { knowledgeBaseId: string; query: string; limit?: number }) {
      const limit = typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0 ? Math.min(50, input.limit) : config.maxResults;
      const result = await client.searchWiki(input.knowledgeBaseId, input.query.trim().slice(0, 4000), limit);
      return { results: result.results.slice(0, limit).map(boundWikiSearchResult) };
    },
  };
}
