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
    expect(modelIds.slice(0, 6)).toEqual([
      "gpt-5.6-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-astra")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-sol")).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it.each(["gpt-6-astra", "gpt-6-sol", " gpt-6-sol ", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6"])("uses the reasoning efforts advertised for %s", (model) => {
    expect(codexLocalReasoningEffortsForModel(model)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it.each(["gpt-5.5", "custom-model"])("preserves legacy efforts for %s", (model) => {
    expect(codexLocalReasoningEffortsForModel(model)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it.each(["gpt-6-luna", "gpt-5.6-luna"])("caps %s at max and supports Fast mode", (model) => {
    expect(codexLocalReasoningEffortsForModel(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(isCodexLocalFastModeSupported(model)).toBe(true);
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
