import { describe, it, expect } from "vitest";
import { createEmbedder, EmbedderError } from "../src/indexer/embedder.js";

const LM_STUDIO_URL = process.env.BRAIN_LM_STUDIO_URL ?? "http://localhost:1234";
const MODEL = process.env.BRAIN_EMBEDDING_MODEL ?? "text-embedding-bge-m3";

const liveDescribe = process.env.SKIP_LIVE_LM === "1" ? describe.skip : describe;

liveDescribe("embedder (live LM Studio)", () => {
  const embedder = createEmbedder({ baseUrl: LM_STUDIO_URL, model: MODEL });

  it("embeds a single string and returns a 1024-dim vector", async () => {
    const [vec] = await embedder.embedBatch(["Paperclip ist ein Agenten-Framework."]);
    expect(vec).toHaveLength(1024);
    expect(typeof vec![0]).toBe("number");
  });

  it("embeds a batch and returns one vector per input in order", async () => {
    const inputs = ["Hund", "Katze", "Maus"];
    const vecs = await embedder.embedBatch(inputs);
    expect(vecs).toHaveLength(3);
    vecs.forEach((v) => expect(v).toHaveLength(1024));
  });

  it("returns vectors that are L2-normalisable (no NaN)", async () => {
    const [vec] = await embedder.embedBatch(["test"]);
    const sumSq = vec!.reduce((s, x) => s + x * x, 0);
    expect(Number.isFinite(sumSq)).toBe(true);
    expect(sumSq).toBeGreaterThan(0);
  });
});

describe("embedder (error handling)", () => {
  it("throws EmbedderError for unreachable URL", async () => {
    const embedder = createEmbedder({
      baseUrl: "http://127.0.0.1:1",
      model: "x",
      timeoutMs: 500,
    });
    await expect(embedder.embedBatch(["hi"])).rejects.toBeInstanceOf(EmbedderError);
  });
});
