import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { resolveZaiConfig } from "./config.js";

describe("resolveZaiConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.ZAI_API_KEY;
    delete process.env.ZAI_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("prefers config.apiKey over env", () => {
    process.env.ZAI_API_KEY = "from-env";
    const resolved = resolveZaiConfig({ apiKey: "from-config" });
    expect(resolved.apiKey).toBe("from-config");
  });

  it("falls back to ZAI_API_KEY env", () => {
    process.env.ZAI_API_KEY = "from-env";
    const resolved = resolveZaiConfig({});
    expect(resolved.apiKey).toBe("from-env");
  });

  it("returns null apiKey when neither is set", () => {
    const resolved = resolveZaiConfig({});
    expect(resolved.apiKey).toBeNull();
  });

  it("normalizes trailing slash on baseUrl", () => {
    const resolved = resolveZaiConfig({ baseUrl: "https://api.z.ai/api/paas/v4/" });
    expect(resolved.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  it("applies default baseUrl (Coding Plan endpoint) when empty", () => {
    const resolved = resolveZaiConfig({});
    expect(resolved.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  it("respects general pay-as-you-go baseUrl override", () => {
    const resolved = resolveZaiConfig({ baseUrl: "https://api.z.ai/api/paas/v4" });
    expect(resolved.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  it("parses tools array", () => {
    const resolved = resolveZaiConfig({
      tools: [
        {
          type: "function",
          function: {
            name: "lookup_issue",
            description: "Look up an issue by id",
            parameters: { type: "object", properties: { id: { type: "string" } } },
          },
        },
        { function: {} }, // ignored (no name)
      ],
    });
    expect(resolved.tools).toHaveLength(1);
    expect(resolved.tools[0].function.name).toBe("lookup_issue");
  });

  it("normalizes responseFormat aliases", () => {
    expect(resolveZaiConfig({ responseFormat: "json" }).responseFormat).toBe("json_object");
    expect(resolveZaiConfig({ responseFormat: "json_object" }).responseFormat).toBe("json_object");
    expect(resolveZaiConfig({ responseFormat: "text" }).responseFormat).toBe("text");
    expect(resolveZaiConfig({ responseFormat: "nonsense" }).responseFormat).toBeNull();
  });

  it("defaults stream to true and allows toggle off", () => {
    expect(resolveZaiConfig({}).stream).toBe(true);
    expect(resolveZaiConfig({ stream: false }).stream).toBe(false);
  });

  it("clamps timeoutMs to a minimum of 1000", () => {
    expect(resolveZaiConfig({ timeoutMs: 0 }).timeoutMs).toBe(1_000);
    expect(resolveZaiConfig({ timeoutMs: 30_000 }).timeoutMs).toBe(30_000);
  });
});
