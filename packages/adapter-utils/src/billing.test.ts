import { describe, expect, it } from "vitest";
import { applyOpenRouterOpenAiEnvMapping, inferOpenAiCompatibleBiller } from "./billing.js";

describe("inferOpenAiCompatibleBiller", () => {
  it("returns openrouter when OPENROUTER_API_KEY is present", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "sk-or-123" } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_API_BASE points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_API_BASE: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns openrouter when OPENAI_API_BASE_URL points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_API_BASE_URL: "https://openrouter.ai/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("returns fallback when no OpenRouter markers are present", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENAI_BASE_URL: "https://api.openai.com/v1" } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });
});

describe("applyOpenRouterOpenAiEnvMapping", () => {
  it("sets OPENAI_* from OPENROUTER_API_KEY", () => {
    const env: Record<string, string> = { OPENROUTER_API_KEY: "sk-or-123" };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-123");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("does not override explicit OPENAI_API_KEY", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_KEY: "sk-openai",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-openai");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("respects existing base URL keys", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("respects OPENAI_API_BASE_URL when set", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE_URL: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
});
