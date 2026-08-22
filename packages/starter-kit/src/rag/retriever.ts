/**
 * Retriever — turns a query into retrieved context for grounding.
 *
 * Thin orchestration over the vector store: enforces a minimum relevance floor
 * so the agent never cites near-random chunks. In a real engagement this is where
 * you'd add reranking, hybrid (lexical + vector) search, or metadata filters.
 */

import type { InMemoryVectorStore, ScoredDoc } from './vector-store.js';

export interface RetrievalOptions {
  topK?: number;
  /** Minimum cosine score to include a doc (default 0.05). */
  minScore?: number;
}

export class Retriever {
  constructor(
    private readonly store: InMemoryVectorStore,
    private readonly opts: RetrievalOptions = {},
  ) {}

  async retrieve(query: string): Promise<ScoredDoc[]> {
    const topK = this.opts.topK ?? 4;
    const minScore = this.opts.minScore ?? 0.05;
    const hits = await this.store.findSimilar(query, topK);
    return hits.filter((h) => h.score >= minScore);
  }
}
