import { describe, expect, it } from "vitest";
import { normalizeCodexAppServerModels } from "../adapters/codex-app-server-models.js";

describe("native Codex model-list normalization", () => {
  it("accepts coding models, preserves native order and deduplicates ids", () => {
    expect(normalizeCodexAppServerModels([
      { id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", inputModalities: ["text", "image"] },
      { id: "gpt-6.2-sol", displayName: "Duplicate" },
      { model: "gpt-6.2-astra", inputModalities: ["text"] },
      { id: "gpt-6.1-sol" },
    ])).toEqual([
      { id: "gpt-6.2-sol", label: "GPT-6.2 Sol" },
      { id: "gpt-6.2-astra", label: "gpt-6.2-astra" },
      { id: "gpt-6.1-sol", label: "gpt-6.1-sol" },
    ]);
  });

  it("rejects hidden, non-text and invalid entries", () => {
    expect(normalizeCodexAppServerModels([
      null, "string", { id: "" }, { id: "../unsafe" },
      { id: "gpt-hidden", hidden: true },
      { id: "image-only", inputModalities: ["image"] },
      { id: "embedded\nmodel" },
      { id: "allowed-model", displayName: "Displayed", inputModalities: ["text"] },
    ])).toEqual([{ id: "allowed-model", label: "Displayed" }]);
  });

  it("bounds displayed model metadata", () => {
    const models = normalizeCodexAppServerModels([{ id: "demo", displayName: "A".repeat(1000) }]);
    expect(models[0].label).toHaveLength(120);
  });
});
