/**
 * In-memory vector store for the RAG skeleton.
 *
 * Keeps documents and their embeddings, supports adding/finding by cosine
 * similarity. Swappable for pgvector / Pinecone / a managed index in a real
 * engagement — only the `findSimilar` implementation changes; the retriever and
 * agent above it stay put.
 */

import { type Embedder, cosineSimilarity } from './embedder.js';

export interface StoredDoc {
  id: string;
  text: string;
  /** Optional client-supplied metadata (source, author, tags...). */
  metadata?: Record<string, unknown>;
}

export interface ScoredDoc extends StoredDoc {
  score: number;
}

interface IndexedDoc extends StoredDoc {
  vector: number[];
}

export class InMemoryVectorStore {
  private readonly docs = new Map<string, IndexedDoc>();

  constructor(private readonly embedder: Embedder) {}

  /** Index a document: embed its text and store it. Returns the doc id. */
  async add(doc: StoredDoc): Promise<string> {
    if (this.docs.has(doc.id)) {
      throw new Error(`InMemoryVectorStore: doc id already indexed: ${doc.id}`);
    }
    const vector = await this.embedder.embed(doc.text);
    this.docs.set(doc.id, { ...doc, vector });
    return doc.id;
  }

  /** Top-k most similar docs to a free-text query. */
  async findSimilar(query: string, topK: number): Promise<ScoredDoc[]> {
    const qVec = await this.embedder.embed(query);
    const scored: ScoredDoc[] = [];
    for (const doc of this.docs.values()) {
      const score = cosineSimilarity(qVec, doc.vector);
      if (score <= 0) continue;
      const { vector: _omit, ...rest } = doc;
      void _omit;
      scored.push({ ...rest, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  count(): number {
    return this.docs.size;
  }
}
