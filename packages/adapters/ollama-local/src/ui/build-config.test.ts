import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildOllamaLocalConfig } from "./build-config.js";

describe("buildOllamaLocalConfig", () => {
  it("preserves native mode and bearer authentication during creation", () => {
    const values = {
      model: "qwen3:8b",
      adapterSchemaValues: {
        baseUrl: "http://ollama.internal:11434",
        apiMode: "ollama",
        apiKey: "secret-token",
      },
    } as unknown as CreateConfigValues;

    expect(buildOllamaLocalConfig(values)).toEqual({
      baseUrl: "http://ollama.internal:11434",
      apiMode: "ollama",
      apiKey: "secret-token",
      model: "qwen3:8b",
      stream: true,
    });
  });
});
