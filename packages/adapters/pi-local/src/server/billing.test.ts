import { describe, expect, it } from "vitest";
import { resolvePiBiller, resolvePiBillingType } from "./billing.js";

describe("resolvePiBillingType", () => {
  it("treats GitHub Copilot as subscription usage", () => {
    // Copilot is OAuth-only in pi, so there is no metered variant to detect.
    expect(resolvePiBillingType({}, "github-copilot")).toBe("subscription");
    expect(resolvePiBillingType({ OPENAI_API_KEY: "sk-test" }, "github-copilot")).toBe("subscription");
  });

  it("treats API-key-only providers as metered even when the key lives in auth.json", () => {
    expect(resolvePiBillingType({}, "google")).toBe("api");
    expect(resolvePiBillingType({ GEMINI_API_KEY: "test" }, "google")).toBe("api");
    expect(resolvePiBillingType({}, "groq")).toBe("api");
  });

  it("splits dual-auth providers on the presence of an API key", () => {
    expect(resolvePiBillingType({ ANTHROPIC_API_KEY: "sk-ant-test" }, "anthropic")).toBe("api");
    expect(resolvePiBillingType({}, "anthropic")).toBe("subscription");
    expect(resolvePiBillingType({ ANTHROPIC_API_KEY: "   " }, "anthropic")).toBe("subscription");
    expect(resolvePiBillingType({ OPENAI_API_KEY: "sk-test" }, "openai")).toBe("api");
    expect(resolvePiBillingType({}, "openai")).toBe("subscription");
    expect(resolvePiBillingType({ XAI_API_KEY: "test" }, "xai")).toBe("api");
    expect(resolvePiBillingType({}, "xai")).toBe("subscription");
  });

  it("reports OpenRouter as prepaid credits regardless of how the key was minted", () => {
    expect(resolvePiBillingType({}, "openrouter")).toBe("credits");
    expect(resolvePiBillingType({ OPENROUTER_API_KEY: "sk-or-test" }, "openrouter")).toBe("credits");
  });

  it("normalizes provider casing and whitespace", () => {
    expect(resolvePiBillingType({}, "  GitHub-Copilot  ")).toBe("subscription");
  });

  it("stays unknown for missing or custom providers instead of guessing", () => {
    expect(resolvePiBillingType({}, null)).toBe("unknown");
    expect(resolvePiBillingType({}, "   ")).toBe("unknown");
    expect(resolvePiBillingType({}, "my-self-hosted-gateway")).toBe("unknown");
  });
});

describe("resolvePiBiller", () => {
  it("prefers an OpenAI-compatible biller inferred from the environment", () => {
    expect(resolvePiBiller({ OPENROUTER_API_KEY: "sk-or-test" }, "openai")).toBe("openrouter");
  });

  it("falls back to the provider parsed from the model id", () => {
    expect(resolvePiBiller({}, "github-copilot")).toBe("github-copilot");
  });

  it("falls back to unknown when there is no provider at all", () => {
    expect(resolvePiBiller({}, null)).toBe("unknown");
  });
});
