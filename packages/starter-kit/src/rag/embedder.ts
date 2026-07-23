/**
 * Embedding abstraction for the RAG skeleton.
 *
 * The starter kit ships a deterministic, offline {@link FakeEmbedder} so the
 * vector store and retriever run with no model provider. A real engagement
 * swaps in a provider embedder (OpenAI text-embedding-3-small, Cohere, a local
 * sentence-transformers server, etc.) — only the `embed` call changes; the
 * store and retriever are model-agnostic.
 */

export interface Embedder {
  /** Dimensionality of produced vectors (fixed per instance). */
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

const DEFAULT_DIMS = 256;

/**
 * Deterministic lexical embedder: hashes each token into a fixed-width bag-of-
 * words vector then L2-normalizes. Cosine similarity therefore tracks lexical
 * overlap, which is enough to make retrieval meaningful in dev/tests without a
 * real embedding model. Stable across runs (no randomness).
 */
export class FakeEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions: number = DEFAULT_DIMS) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const idx = hashToken(token) % this.dimensions;
      vec[idx] += 1;
    }
    return l2Normalize(vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

/** Cosine similarity of two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('cosineSimilarity: vector length mismatch');
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are pre-normalized
}
