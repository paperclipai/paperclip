import { afterEach, describe, expect, it, vi } from "vitest";
import { listOllamaAdapterModels } from "./models.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OLLAMA_HOST;
});

describe("listOllamaAdapterModels", () => {
  it("maps installed Ollama models into adapter model options", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      models: [
        {
          name: "qwen2.5-coder:7b",
          modified_at: "2026-06-21T00:00:00Z",
          size: 1,
          digest: "digest",
          details: {
            format: "gguf",
            family: "qwen2",
            families: ["qwen2"],
            parameter_size: "7.6B",
            quantization_level: "Q4_K_M",
          },
        },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    process.env.OLLAMA_HOST = "http://ollama.internal:11434";

    await expect(listOllamaAdapterModels()).resolves.toEqual([
      {
        id: "qwen2.5-coder:7b",
        label: "qwen2.5-coder:7b (7.6B, Q4_K_M)",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("http://ollama.internal:11434/api/tags");
  });

  it("returns an empty list when Ollama is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection refused");
    }));

    await expect(listOllamaAdapterModels()).resolves.toEqual([]);
  });
});
