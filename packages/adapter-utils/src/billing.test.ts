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

  it("returns openrouter when OPENROUTER_API_BASE points at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        { OPENROUTER_API_BASE: "https://openrouter.ai/api/v1" } as NodeJS.ProcessEnv,
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

  it("treats whitespace-only OPENROUTER_API_KEY as absent", () => {
    expect(
      inferOpenAiCompatibleBiller({ OPENROUTER_API_KEY: "   " } as NodeJS.ProcessEnv, "openai"),
    ).toBe("openai");
  });

  it("prefers OPENAI_BASE_URL over OPENAI_API_BASE when both are set", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_BASE_URL: "https://api.openai.com/v1",
          OPENAI_API_BASE: "https://openrouter.ai/api/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });

  it("falls through when OPENAI_BASE_URL is whitespace-only to OPENAI_API_BASE at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_BASE_URL: "   ",
          OPENAI_API_BASE: "https://openrouter.ai/api/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("falls through past whitespace OPENAI_BASE_URL and OPENAI_API_BASE to OPENAI_API_BASE_URL at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_BASE_URL: "\t",
          OPENAI_API_BASE: "  ",
          OPENAI_API_BASE_URL: "https://openrouter.ai/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("prefers OPENAI_API_BASE over OPENAI_API_BASE_URL when both are set (first non-empty wins)", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_API_BASE: "https://openrouter.ai/api/v1",
          OPENAI_API_BASE_URL: "https://api.openai.com/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
  });

  it("prefers OPENAI_API_BASE_URL over OPENROUTER_API_BASE when both are set", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_API_BASE_URL: "https://api.openai.com/v1",
          OPENROUTER_API_BASE: "https://openrouter.ai/api/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openai");
  });

  it("falls through past whitespace OPENAI_* vars to OPENROUTER_API_BASE at OpenRouter", () => {
    expect(
      inferOpenAiCompatibleBiller(
        {
          OPENAI_BASE_URL: " ",
          OPENAI_API_BASE: "\t",
          OPENAI_API_BASE_URL: "  ",
          OPENROUTER_API_BASE: "https://openrouter.ai/api/v1",
        } as NodeJS.ProcessEnv,
        "openai",
      ),
    ).toBe("openrouter");
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

  it("promotes OPENAI_API_BASE to OPENAI_BASE_URL when OPENAI_BASE_URL is unset", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://example.com/v1");
  });

  it("respects OPENAI_BASE_URL when set", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_BASE_URL: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://example.com/v1");
  });

  it("treats whitespace-only OPENAI_BASE_URL as unset and promotes OPENAI_API_BASE for CLI compatibility", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_BASE_URL: "   ",
      OPENAI_API_BASE: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://example.com/v1");
    expect(env.OPENAI_API_BASE).toBe("https://example.com/v1");
  });

  it("promotes OPENAI_API_BASE_URL when OPENAI_BASE_URL is whitespace-only", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_BASE_URL: "\t",
      OPENAI_API_BASE: "  ",
      OPENAI_API_BASE_URL: "https://openrouter.ai/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/v1");
  });

  it("promotes OPENAI_API_BASE_URL to OPENAI_BASE_URL when OPENAI_BASE_URL is unset", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE_URL: "https://example.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://example.com/v1");
  });

  it("does nothing when OPENROUTER_API_KEY is only whitespace", () => {
    const env: Record<string, string> = { OPENROUTER_API_KEY: "  \t  " };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });

  it("maps when OPENAI_API_KEY is only whitespace (treated as unset)", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_KEY: "   ",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("trims OPENROUTER_API_KEY when copying to OPENAI_API_KEY", () => {
    const env: Record<string, string> = { OPENROUTER_API_KEY: "  sk-or-1  " };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("prefers OPENAI_API_BASE over OPENAI_API_BASE_URL when promoting to OPENAI_BASE_URL", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE: "https://openrouter.ai/api/v1",
      OPENAI_API_BASE_URL: "https://api.openai.com/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("promotes OPENROUTER_API_BASE to OPENAI_BASE_URL when OPENAI_* base vars are unset", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENROUTER_API_BASE: "https://openrouter.ai/api/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_API_KEY).toBe("sk-or-1");
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });

  it("prefers OPENAI_API_BASE_URL over OPENROUTER_API_BASE when promoting to OPENAI_BASE_URL", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_API_BASE_URL: "https://api.openai.com/v1",
      OPENROUTER_API_BASE: "https://openrouter.ai/api/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  });

  it("promotes whitespace-skipped chain to OPENROUTER_API_BASE for CLI compatibility", () => {
    const env: Record<string, string> = {
      OPENROUTER_API_KEY: "sk-or-1",
      OPENAI_BASE_URL: " ",
      OPENAI_API_BASE: "\t",
      OPENAI_API_BASE_URL: "  ",
      OPENROUTER_API_BASE: "https://openrouter.ai/api/v1",
    };
    applyOpenRouterOpenAiEnvMapping(env);
    expect(env.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
  });
});
