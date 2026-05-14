import { describe, expect, it } from "vitest";
import { resolveAdapterModelAvailability } from "./adapter-model-compat.js";

describe("resolveAdapterModelAvailability", () => {
  it("blocks gpt-5.3-codex-spark on codex_local", () => {
    const result = resolveAdapterModelAvailability("codex_local", "gpt-5.3-codex-spark", "any-company");
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.code).toBe("unsupported_model");
      expect(result.supportedModels).not.toContain("gpt-5.3-codex-spark");
      expect(result.supportedModels.length).toBeGreaterThan(0);
    }
  });

  it("allows a known-good codex_local model (positive control)", () => {
    const result = resolveAdapterModelAvailability("codex_local", "gpt-5.3-codex", "any-company");
    expect(result.available).toBe(true);
  });

  it("allows any model for unknown adapter types (permissive default)", () => {
    const result = resolveAdapterModelAvailability("claude_direct", "any-model", "any-company");
    expect(result.available).toBe(true);
  });

  it("allows any model for chatgpt_local (permissive default)", () => {
    const result = resolveAdapterModelAvailability("chatgpt_local", "gpt-5.3-codex-spark", "any-company");
    expect(result.available).toBe(true);
  });
});
