export class EmbedderError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "EmbedderError";
  }
}

export interface EmbedderOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Inputs per HTTP call. LM Studio handles small batches best. */
  batchSize?: number;
}

export interface Embedder {
  embedBatch(inputs: string[]): Promise<number[][]>;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index?: number }>;
}

export function createEmbedder(opts: EmbedderOptions): Embedder {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const model = opts.model;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const batchSize = Math.max(1, opts.batchSize ?? 32);

  async function embedSingleBatch(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EmbedderError(
          `LM Studio embeddings call failed: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
        );
      }
      const json = (await res.json()) as EmbeddingResponse;
      if (!json?.data || !Array.isArray(json.data)) {
        throw new EmbedderError("LM Studio response missing `data` array");
      }
      // OpenAI spec: data items carry `index` for ordering. Sort to be safe.
      const sorted = [...json.data].sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
      );
      const vecs = sorted.map((d) => d.embedding);
      if (vecs.length !== inputs.length) {
        throw new EmbedderError(
          `Embedding count mismatch: expected ${inputs.length}, got ${vecs.length}`,
        );
      }
      return vecs;
    } catch (err) {
      if (err instanceof EmbedderError) throw err;
      throw new EmbedderError(
        `Embedding request failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async embedBatch(inputs: string[]): Promise<number[][]> {
      if (inputs.length === 0) return [];
      const result: number[][] = [];
      for (let i = 0; i < inputs.length; i += batchSize) {
        const slice = inputs.slice(i, i + batchSize);
        const vecs = await embedSingleBatch(slice);
        result.push(...vecs);
      }
      return result;
    },
  };
}
