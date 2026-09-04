import { describe, expect, it } from "vitest";
import {
  codexLocalReasoningEffortsForModel,
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  models,
  normalizeCodexModel,
} from "./index.js";

describe("codex local adapter metadata", () => {
  it("advertises current Codex-capable OpenAI models without changing the default", () => {
    const modelIds = models.map((model) => model.id);

    // Default to the concrete gpt-5.6-sol slug — Codex ships no metadata for the bare gpt-5.6
    // alias, so it must not be advertised or used as the default (it triggers a fallback warning).
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    expect(modelIds.slice(0, 4)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-astra")).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it("uses the reasoning efforts advertised for GPT-6 Astra", () => {
    expect(codexLocalReasoningEffortsForModel("gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(codexLocalReasoningEffortsForModel("gpt-5.6-sol")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("normalizes the legacy bare gpt-5.6 alias to the concrete gpt-5.6-sol slug", () => {
    expect(normalizeCodexModel("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("  gpt-5.6  ")).toBe("gpt-5.6-sol");
    // Concrete slugs and unknown/manual model IDs pass through untouched.
    expect(normalizeCodexModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(normalizeCodexModel("gpt-5.5")).toBe("gpt-5.5");
    expect(normalizeCodexModel("future-model")).toBe("future-model");
    expect(normalizeCodexModel("")).toBe("");
    expect(normalizeCodexModel(null)).toBe("");
  });
});
