import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseBestOllamaModel,
  detectOllamaHttpModel,
  listOllamaHttpModels,
} from "./model-discovery.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ollama_http model discovery", () => {
  it("lists models from the configured /api/tags endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "qwen3-coder:32b" },
            { name: "llama3.2:3b" },
          ],
        }),
      }),
    );

    const models = await listOllamaHttpModels({
      baseUrl: "https://ollama.example.test",
    });

    expect(models).toEqual([
      { id: "qwen3-coder:32b", label: "qwen3-coder:32b" },
      { id: "llama3.2:3b", label: "llama3.2:3b" },
    ]);
  });

  it("returns the configured explicit model without probing tags", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const detected = await detectOllamaHttpModel({
      baseUrl: "https://ollama.example.test",
      model: "qwen3:32b",
    });

    expect(detected).toEqual({
      model: "qwen3:32b",
      provider: "ollama",
      source: "adapterConfig.model",
      candidates: ["qwen3:32b"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers a coding-oriented model when auto-detecting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "llama3.2:3b" },
            { name: "qwen3-coder:32b" },
            { name: "nomic-embed-text" },
          ],
        }),
      }),
    );

    const detected = await detectOllamaHttpModel(
      {
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
      },
      { agentRole: "engineer" },
    );

    expect(detected).toEqual({
      model: "qwen3-coder:32b",
      provider: "ollama",
      source: "api/tags",
      candidates: ["llama3.2:3b", "qwen3-coder:32b", "nomic-embed-text"],
    });
  });

  it("prefers a balanced general model over an oversized coder model for general work", () => {
    const chosen = chooseBestOllamaModel(
      [
        { name: "qwen3-coder:480b-cloud", model: "qwen3-coder:480b-cloud" },
        { name: "qwen3:32b-cloud", model: "qwen3:32b-cloud" },
        { name: "llama3.2:3b", model: "llama3.2:3b" },
      ],
      "general",
    );

    expect(chosen).toEqual({
      name: "qwen3:32b-cloud",
      model: "qwen3:32b-cloud",
    });
  });
});
