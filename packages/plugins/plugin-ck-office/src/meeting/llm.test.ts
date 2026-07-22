import { afterEach, describe, expect, it, vi } from "vitest";
import { DeepseekCaller } from "./llm.js";

function mockDeepseekResponse(payload: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as const;
}

describe("DeepseekCaller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prices v4-flash with separate cache-hit and cache-miss input tokens", async () => {
    const fetchMock = vi.fn(async () =>
      mockDeepseekResponse({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 100,
          prompt_cache_miss_tokens: 900,
          completion_tokens: 50,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caller = new DeepseekCaller("deepseek-test-key");
    const result = await caller.chat({ system: "sys", user: "user" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("deepseek-v4-flash");
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(50);
    expect(result.model).toBe("deepseek-v4-flash");
    expect(result.costCents).toBeCloseTo(0.014028, 6);
  });

  it("prices v4-pro with its own rate card", async () => {
    const fetchMock = vi.fn(async () =>
      mockDeepseekResponse({
        model: "deepseek-v4-pro",
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: {
          prompt_tokens: 1000,
          prompt_cache_hit_tokens: 100,
          prompt_cache_miss_tokens: 900,
          completion_tokens: 50,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const caller = new DeepseekCaller("deepseek-test-key", "deepseek-v4-pro");
    const result = await caller.chat({ system: "sys", user: "user", model: "deepseek-v4-pro" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe("deepseek-v4-pro");
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(50);
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.costCents).toBeCloseTo(0.04353625, 8);
  });
});
