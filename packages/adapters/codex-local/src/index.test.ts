import { describe, expect, it } from "vitest";
import {
  CODEX_CHATGPT_MODEL_REJECTION_RE,
  codexCliVersionAtLeast,
  codexLocalReasoningEffortsForModel,
  DEFAULT_CODEX_LOCAL_MODEL,
  isCodexLocalFastModeSupported,
  minimumCodexCliVersionForModel,
  models,
  normalizeCodexModel,
  parseCodexCliVersionOutput,
} from "./index.js";

describe("codex model CLI floors", () => {
  it("records the oldest Codex CLI verified to run each gated model with ChatGPT sign-in", () => {
    expect(minimumCodexCliVersionForModel("gpt-6.1-sol")).toBe("0.159.0");
    expect(minimumCodexCliVersionForModel(" gpt-6.1-sol ")).toBe("0.159.0");
    expect(minimumCodexCliVersionForModel("gpt-6-sol")).toBe("0.157.0");
    expect(minimumCodexCliVersionForModel("gpt-6-luna")).toBe("0.157.0");
  });

  it.each([DEFAULT_CODEX_LOCAL_MODEL, "gpt-5.6", "gpt-6-astra", "gpt-5.5", "custom-model", "", null, undefined])(
    "has no floor for %s so callers skip the version probe", (model) => {
      expect(minimumCodexCliVersionForModel(model)).toBeNull();
    },
  );

  it("compares stable versions numerically and rejects prerelease or ambiguous input", () => {
    expect(codexCliVersionAtLeast("0.159.0", "0.159.0")).toBe(true);
    expect(codexCliVersionAtLeast("0.160.1", "0.159.0")).toBe(true);
    expect(codexCliVersionAtLeast("1.0.0", "0.159.0")).toBe(true);
    expect(codexCliVersionAtLeast("0.156.1", "0.159.0")).toBe(false);
    expect(codexCliVersionAtLeast("0.16.0", "0.159.0")).toBe(false);
    expect(codexCliVersionAtLeast("0.160.0-alpha.1", "0.159.0")).toBe(false);
    expect(codexCliVersionAtLeast("", "0.159.0")).toBe(false);
  });

  it("parses only a single stable `codex-cli x.y.z` line from --version output", () => {
    expect(parseCodexCliVersionOutput("codex-cli 0.160.0\n")).toBe("0.160.0");
    expect(parseCodexCliVersionOutput("WARNING: PATH unchanged\r\ncodex-cli 0.156.0\r\n")).toBe("0.156.0");
    expect(parseCodexCliVersionOutput("codex-cli 0.162.0-alpha.17")).toBeNull();
    expect(parseCodexCliVersionOutput("codex 0.160.0")).toBeNull();
    expect(parseCodexCliVersionOutput("codex-cli 0.149.0\ncodex-cli 0.160.0")).toBeNull();
    expect(parseCodexCliVersionOutput("")).toBeNull();
  });

  it("matches the backend's ChatGPT model rejection and captures the model", () => {
    const match = CODEX_CHATGPT_MODEL_REJECTION_RE.exec(
      "{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\"}}",
    );
    expect(match?.[1]).toBe("gpt-6.1-sol");
    expect(CODEX_CHATGPT_MODEL_REJECTION_RE.test("Model metadata for `gpt-6.1-sol` not found")).toBe(false);
  });
});

describe("codex local adapter metadata", () => {
  it("advertises current Codex-capable OpenAI models without changing the default", () => {
    const modelIds = models.map((model) => model.id);

    // Default to the concrete gpt-5.6-sol slug — Codex ships no metadata for the bare gpt-5.6
    // alias, so it must not be advertised or used as the default (it triggers a fallback warning).
    expect(DEFAULT_CODEX_LOCAL_MODEL).toBe("gpt-5.6-sol");
    // Ordered like the ChatGPT app: newest version first, then by capability within a version (#14878).
    expect(modelIds.slice(0, 13)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5",
      "gpt-5-mini",
      "gpt-5-nano",
    ]);
    expect(modelIds).toContain("gpt-5.5");
    expect(modelIds).not.toContain("gpt-5.6");
    expect(isCodexLocalFastModeSupported(DEFAULT_CODEX_LOCAL_MODEL)).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-astra")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6.1-sol")).toBe(true);
    expect(isCodexLocalFastModeSupported("gpt-6-sol")).toBe(true);
    expect(modelIds).not.toContain("gpt-5.3-codex");
    expect(modelIds).not.toContain("gpt-5.3-codex-spark");
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", " gpt-6-sol ", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6"])("uses the reasoning efforts advertised for %s", (model) => {
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
