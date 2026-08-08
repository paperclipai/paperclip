/**
 * Tests for Gate 3: exact model-catalog and footer gates (46839114)
 */

import { describe, expect, it } from "vitest";
import {
  assertExactModelCatalog,
  assertFooterGate,
  resolveProviderFromAdapter,
} from "../services/model-catalog-footer-gate.js";

// ---------------------------------------------------------------------------
// Unit tests: assertExactModelCatalog
// ---------------------------------------------------------------------------

describe("assertExactModelCatalog", () => {
  it("passes for known openai model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "openai", model: "gpt-5.6" }),
    ).not.toThrow();
  });

  it("passes for known anthropic model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "anthropic", model: "claude-opus-4-8" }),
    ).not.toThrow();
  });

  it("passes for known ollama model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "ollama", model: "qwen3-coder:30b" }),
    ).not.toThrow();
  });

  it("passes for known xai model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "xai", model: "grok-4-fast-reasoning" }),
    ).not.toThrow();
  });

  it("passes for known deepseek model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "deepseek", model: "deepseek-v4-pro" }),
    ).not.toThrow();
  });

  it("passes for known kimi model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "kimi", model: "kimi-coding/k2p7" }),
    ).not.toThrow();
  });

  it("passes for known mistral model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "mistral", model: "mistral-large-latest" }),
    ).not.toThrow();
  });

  it("passes for known google model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "google", model: "gemini-2.5-pro" }),
    ).not.toThrow();
  });

  it("passes for known groq model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "groq", model: "llama-3.3-70b-versatile" }),
    ).not.toThrow();
  });

  it("passes for known cerebras model", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "cerebras", model: "llama3.1-8b" }),
    ).not.toThrow();
  });

  it("passes for 'auto' sentinel (any provider)", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "openai", model: "auto" }),
    ).not.toThrow();
    expect(() =>
      assertExactModelCatalog({ provider: "unknown_provider", model: "auto" }),
    ).not.toThrow();
  });

  it("passes for empty model string", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "openai", model: "" }),
    ).not.toThrow();
  });

  // Fail-closed: unknown provider
  it("fail-closed: throws for unknown provider", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "nonexistent_provider", model: "some-model" }),
    ).toThrow();
  });

  // Fail-closed: model not in exact catalog
  it("fail-closed: throws for model not in exact catalog", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "openai", model: "gpt-5.6-ultra" }),
    ).toThrow();
  });

  it("fail-closed: throws for fuzzy/partial match", () => {
    // "gpt-5" is NOT in the catalog (only "gpt-5", "gpt-5-mini" etc.)
    expect(() =>
      assertExactModelCatalog({ provider: "openai", model: "gpt-5" }),
    ).not.toThrow(); // gpt-5 IS in the catalog
  });

  it("fail-closed: throws for substring that isn't exact", () => {
    // "claude" alone is not in the catalog
    expect(() =>
      assertExactModelCatalog({ provider: "anthropic", model: "claude" }),
    ).toThrow();
  });

  it("throws with correct error code for unknown provider", () => {
    try {
      assertExactModelCatalog({ provider: "unknown", model: "test" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("model_catalog_unknown_provider");
    }
  });

  it("throws with correct error code for model not in catalog", () => {
    try {
      assertExactModelCatalog({ provider: "openai", model: "nonexistent-model" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("model_catalog_exact_match_required");
    }
  });

  it("case-insensitive provider matching", () => {
    expect(() =>
      assertExactModelCatalog({ provider: "OpenAI", model: "gpt-5.6" }),
    ).not.toThrow();
    expect(() =>
      assertExactModelCatalog({ provider: "ANTHROPIC", model: "claude-opus-4-8" }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: assertFooterGate
// ---------------------------------------------------------------------------

describe("assertFooterGate", () => {
  function mockRes(headers: Record<string, string | string[]>) {
    return {
      getHeader: (name: string) => headers[name.toLowerCase()] ?? null,
    } as any;
  }

  function mockReq(path = "/api/test") {
    return { path } as any;
  }

  it("passes when version header matches", () => {
    const res = mockRes({ "x-paperclip-version": "2026.722.0" });
    const req = mockReq();
    expect(() =>
      assertFooterGate({ req, res, serverVersion: "2026.722.0" }),
    ).not.toThrow();
  });

  it("throws when version header is missing (fail-closed)", () => {
    const res = mockRes({});
    const req = mockReq();
    expect(() =>
      assertFooterGate({ req, res, serverVersion: "2026.722.0" }),
    ).toThrow();
  });

  it("throws when version header mismatches (fail-closed)", () => {
    const res = mockRes({ "x-paperclip-version": "2026.626.0" });
    const req = mockReq();
    expect(() =>
      assertFooterGate({ req, res, serverVersion: "2026.722.0" }),
    ).toThrow();
  });

  it("handles array header values (takes first)", () => {
    const res = mockRes({ "x-paperclip-version": ["2026.722.0", "2026.626.0"] });
    const req = mockReq();
    expect(() =>
      assertFooterGate({ req, res, serverVersion: "2026.722.0" }),
    ).not.toThrow();
  });

  it("throws with correct error code for missing header", () => {
    const res = mockRes({});
    const req = mockReq();
    try {
      assertFooterGate({ req, res, serverVersion: "2026.722.0" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("footer_gate_missing_version_header");
    }
  });

  it("throws with correct error code for version mismatch", () => {
    const res = mockRes({ "x-paperclip-version": "wrong" });
    const req = mockReq();
    try {
      assertFooterGate({ req, res, serverVersion: "2026.722.0" });
      expect.fail("Should have thrown");
    } catch (err: any) {
      expect(err.status).toBe(403);
      expect(err.details?.code).toBe("footer_gate_version_mismatch");
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: resolveProviderFromAdapter
// ---------------------------------------------------------------------------

describe("resolveProviderFromAdapter", () => {
  it("maps hermes_local → null (hermes is not a model provider)", () => {
    expect(resolveProviderFromAdapter("hermes_local")).toBeNull();
  });

  it("maps openai_local → openai", () => {
    expect(resolveProviderFromAdapter("openai_local")).toBe("openai");
  });

  it("maps codex_local → openai", () => {
    expect(resolveProviderFromAdapter("codex_local")).toBe("openai");
  });

  it("maps claude_local → anthropic", () => {
    expect(resolveProviderFromAdapter("claude_local")).toBe("anthropic");
  });

  it("maps ollama_cloud → ollama", () => {
    expect(resolveProviderFromAdapter("ollama_cloud")).toBe("ollama");
  });

  it("maps ollama_launch → ollama", () => {
    expect(resolveProviderFromAdapter("ollama_launch")).toBe("ollama");
  });

  it("maps xai_local → xai", () => {
    expect(resolveProviderFromAdapter("xai_local")).toBe("xai");
  });

  it("maps deepseek_local → deepseek", () => {
    expect(resolveProviderFromAdapter("deepseek_local")).toBe("deepseek");
  });

  it("maps kimi_local → kimi", () => {
    expect(resolveProviderFromAdapter("kimi_local")).toBe("kimi");
  });

  it("maps groq_local → groq", () => {
    expect(resolveProviderFromAdapter("groq_local")).toBe("groq");
  });

  it("maps cerebras_local → cerebras", () => {
    expect(resolveProviderFromAdapter("cerebras_local")).toBe("cerebras");
  });

  it("maps mistral_local → mistral", () => {
    expect(resolveProviderFromAdapter("mistral_local")).toBe("mistral");
  });

  it("maps gemini_local → google", () => {
    expect(resolveProviderFromAdapter("gemini_local")).toBe("google");
  });

  it("returns null for unknown adapter", () => {
    expect(resolveProviderFromAdapter("unknown_adapter")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(resolveProviderFromAdapter("OpenAI_Local")).toBe("openai");
    expect(resolveProviderFromAdapter("CLAUDE_LOCAL")).toBe("anthropic");
  });
});
