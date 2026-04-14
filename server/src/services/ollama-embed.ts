import { logger } from "../middleware/logger.js";

/**
 * Embed text via Ollama Cloud using the nomic-embed-text model (768 dims).
 *
 * Why nomic-embed-text:
 * - 768 dimensions (smaller storage than OpenAI's 1536 / text-embedding-3-small)
 * - Free tier on Ollama Cloud (same $20/mo flat-rate we already pay)
 * - Optimized for retrieval/RAG tasks
 *
 * The endpoint is `/api/embed` (not `/api/embeddings`). Returns a single
 * vector per input; pass an array to embed multiple texts in one call.
 *
 * Throws on non-2xx or malformed responses. Callers should catch and
 * decide whether to retry, skip, or mark the chunk for later backfill.
 */

// Use `||` (not `??`) so empty-string env values fall through to the default.
// Docker compose's `${VAR:-}` expands unset vars to "" rather than leaving them
// undefined; `??` would treat that as "set to empty" and break URL parsing.
const EMBED_URL = process.env.OLLAMA_EMBED_URL || "https://ollama.com/api/embed";
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";
const EMBED_TIMEOUT_MS = 30_000;

export interface EmbedResult {
  embedding: number[];
  model: string;
  tokenCount: number;
}

export async function embedText(input: string): Promise<EmbedResult> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error("OLLAMA_API_KEY missing - cannot embed");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Ollama embed returned ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      embeddings?: number[][];
      model?: string;
      total_duration?: number;
      load_duration?: number;
      prompt_eval_count?: number;
    };

    const embedding = data.embeddings?.[0];
    if (!embedding || embedding.length === 0) {
      throw new Error("Ollama embed returned empty embedding");
    }

    return {
      embedding,
      model: data.model ?? EMBED_MODEL,
      tokenCount: data.prompt_eval_count ?? 0,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Ollama embed timed out after ${EMBED_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function embedBatch(inputs: string[]): Promise<EmbedResult[]> {
  // Ollama Cloud supports an `input: string[]` payload in a single call.
  // We do this for batch efficiency. If the batch is large, callers should
  // chunk it themselves (recommend <=32 per call).
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error("OLLAMA_API_KEY missing - cannot embed");
  }

  if (inputs.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

  try {
    const res = await fetch(EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: inputs,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Ollama embed batch returned ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      embeddings?: number[][];
      model?: string;
      prompt_eval_count?: number;
    };

    if (!data.embeddings || data.embeddings.length !== inputs.length) {
      throw new Error(
        `Ollama embed batch returned ${data.embeddings?.length ?? 0} embeddings for ${inputs.length} inputs`,
      );
    }

    const model = data.model ?? EMBED_MODEL;
    // Token count is for the whole batch; distribute evenly as an approximation.
    const perInputTokens = Math.ceil((data.prompt_eval_count ?? 0) / inputs.length);

    return data.embeddings.map((embedding) => ({
      embedding,
      model,
      tokenCount: perInputTokens,
    }));
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      logger.warn({ batchSize: inputs.length }, "ollama-embed: batch timed out");
      throw new Error(`Ollama embed batch timed out after ${EMBED_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
