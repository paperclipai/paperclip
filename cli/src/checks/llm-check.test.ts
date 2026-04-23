import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { llmCheck } from "./llm-check.js";

function makeConfig(overrides: {
  llm?: null | { provider: string; apiKey?: string | null };
}): PaperclipConfig {
  return { llm: overrides.llm ?? null } as unknown as PaperclipConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// llmCheck — no LLM configured
// ============================================================================

describe("llmCheck — no LLM configured", () => {
  it("returns pass when config.llm is null/falsy", async () => {
    const result = await llmCheck(makeConfig({ llm: null }));
    expect(result.status).toBe("pass");
  });

  it("sets name to 'LLM provider'", async () => {
    const result = await llmCheck(makeConfig({ llm: null }));
    expect(result.name).toBe("LLM provider");
  });

  it("does not make a network call when llm is not configured", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await llmCheck(makeConfig({ llm: null }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// llmCheck — LLM configured but no API key
// ============================================================================

describe("llmCheck — provider configured, no API key", () => {
  it("returns pass when apiKey is missing", async () => {
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: undefined } }));
    expect(result.status).toBe("pass");
  });

  it("returns pass when apiKey is null", async () => {
    const result = await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: null } }));
    expect(result.status).toBe("pass");
  });

  it("message includes the provider name", async () => {
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: null } }));
    expect(result.message).toContain("claude");
  });

  it("does not make a network call when no API key is present", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: null } }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// llmCheck — Claude provider, API key present
// ============================================================================

describe("llmCheck — claude provider with API key", () => {
  it("returns pass when Anthropic returns 200 (ok)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "sk-ant-test" } }));
    expect(result.status).toBe("pass");
    expect(result.message).toContain("valid");
  });

  it("returns pass when Anthropic returns 400 (bad request but key accepted)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 400 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "sk-ant-test" } }));
    expect(result.status).toBe("pass");
  });

  it("returns fail for 401 unauthorized", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 401 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "bad-key" } }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("401");
  });

  it("returns warn for unexpected status codes", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 503 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "sk-ant-test" } }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("503");
  });

  it("returns warn when fetch throws a network error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new Error("network unreachable"));
    const result = await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "sk-ant-test" } }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Could not reach");
  });

  it("calls the Anthropic API endpoint", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 }),
    );
    await llmCheck(makeConfig({ llm: { provider: "claude", apiKey: "sk-ant-test" } }));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("anthropic.com"),
      expect.anything(),
    );
  });
});

// ============================================================================
// llmCheck — OpenAI provider, API key present
// ============================================================================

describe("llmCheck — openai provider with API key", () => {
  it("returns pass when OpenAI returns 200", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: "sk-test" } }));
    expect(result.status).toBe("pass");
    expect(result.message).toContain("valid");
  });

  it("returns fail for 401 unauthorized", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 401 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: "bad-key" } }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("401");
  });

  it("returns warn for unexpected status code", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 429 }),
    );
    const result = await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: "sk-test" } }));
    expect(result.status).toBe("warn");
    expect(result.message).toContain("429");
  });

  it("returns warn when fetch throws a network error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(new TypeError("failed to fetch"));
    const result = await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: "sk-test" } }));
    expect(result.status).toBe("warn");
  });

  it("calls the OpenAI API endpoint", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("{}", { status: 200 }),
    );
    await llmCheck(makeConfig({ llm: { provider: "openai", apiKey: "sk-test" } }));
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("openai.com"),
      expect.anything(),
    );
  });
});
