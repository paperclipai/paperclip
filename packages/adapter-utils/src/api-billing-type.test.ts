import { describe, expect, it } from "vitest";
import { apiKeyBillingType } from "./api-billing-type.js";

describe("verified API billing", () => {
  it.each([
    ["openrouter", "OPENROUTER_API_KEY"], ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"], ["deepseek", "DEEPSEEK_API_KEY"],
  ])("classifies %s with its matching credential", (provider, key) => {
    expect(apiKeyBillingType(provider, { [key]: "fixture-key" })).toBe("metered_api");
  });
  it("recognizes Codex's key alias only for the Codex runtime", () => {
    const env = { CODEX_API_KEY: "fixture" };
    expect(apiKeyBillingType("openai", env, "codex")).toBe("metered_api");
    expect(apiKeyBillingType("openai", env)).toBe("unknown");
    expect(apiKeyBillingType("openrouter", env, "codex")).toBe("unknown");
  });
  it.each(["openrouter", "openai", "constructor", "toString", null, "unsupported"]) ("does not infer billing for %s", provider => {
    expect(apiKeyBillingType(provider, { ANTHROPIC_API_KEY: "unrelated-key", OPENAI_API_KEY: "  " })).toBe("unknown");
  });
});
