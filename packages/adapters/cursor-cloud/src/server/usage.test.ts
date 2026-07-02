import { describe, expect, it, vi } from "vitest";
import { fetchCursorRunUsage, mapUsageToAdapterResult } from "./usage.js";

describe("fetchCursorRunUsage", () => {
  it("parses usage response for a single run", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        runs: [
          {
            runId: "run-1",
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheWriteTokens: 50,
              cacheReadTokens: 300,
              totalTokens: 1550,
            },
          },
        ],
      }),
    });
    const usage = await fetchCursorRunUsage({
      apiKey: "key",
      agentId: "bc-agent-1",
      runId: "run-1",
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheWriteTokens: 50,
      cacheReadTokens: 300,
      totalTokens: 1550,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.cursor.com/v1/agents/bc-agent-1/usage?runId=run-1",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer key",
          Accept: "application/json",
        },
      },
    );
  });

  it("returns null on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const usage = await fetchCursorRunUsage({
      apiKey: "key",
      agentId: "bc-agent-1",
      runId: "missing",
      fetchImpl: mockFetch as typeof fetch,
    });
    expect(usage).toBeNull();
  });
});

describe("mapUsageToAdapterResult", () => {
  it("maps cacheReadTokens to cachedInputTokens", () => {
    expect(
      mapUsageToAdapterResult({
        inputTokens: 1000,
        outputTokens: 200,
        cacheWriteTokens: 50,
        cacheReadTokens: 300,
        totalTokens: 1550,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 300,
    });
  });
});
