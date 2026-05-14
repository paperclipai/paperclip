import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchClaudeQuota } from "./quota.js";

// fetchClaudeQuota holds a process-local cache by token-prefix. Tests use
// distinct tokens so each starts cold; a 16-char prefix slice keys it, so
// we deliberately diverge in those first 16 chars.
const TOKEN_A = "tokenAAAAAAAAAAA1tail";
const TOKEN_B = "tokenBBBBBBBBBBB2tail";
const TOKEN_C = "tokenCCCCCCCCCCC3tail";
const TOKEN_D = "tokenDDDDDDDDDDD4tail";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const SAMPLE_BODY = {
  five_hour: { utilization: 0.42, resets_at: "2026-05-06T05:00:00Z" },
  seven_day: { utilization: 0.31, resets_at: "2026-05-12T00:00:00Z" },
};

describe("fetchClaudeQuota cache", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let originalFetch: typeof fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T00:00:00Z"));
    originalFetch = globalThis.fetch;
    fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("returns a fresh API response and caches it", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_BODY));
    const first = await fetchClaudeQuota(TOKEN_A);
    expect(first.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call within the freshness window should hit the cache and
    // skip the network entirely — this is what fixes the 429 storm.
    const second = await fetchClaudeQuota(TOKEN_A);
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the freshness window expires", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_BODY));
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      ...SAMPLE_BODY,
      five_hour: { utilization: 0.55, resets_at: SAMPLE_BODY.five_hour.resets_at },
    }));

    const first = await fetchClaudeQuota(TOKEN_B);
    // 60s freshness — advance just past it.
    vi.advanceTimersByTime(61_000);
    const second = await fetchClaudeQuota(TOKEN_B);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The second call's first window should reflect the second mock, not the first.
    expect(first[0]?.usedPercent).toBe(42);
    expect(second[0]?.usedPercent).toBe(55);
  });

  it("propagates 429 errors when no cache entry exists", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(fetchClaudeQuota(TOKEN_C)).rejects.toThrow(/429/);
  });

  it("does not cache failed responses", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    fetchSpy.mockResolvedValueOnce(jsonResponse(SAMPLE_BODY));
    await expect(fetchClaudeQuota(TOKEN_D)).rejects.toThrow();
    // After the failure, a retry should hit the network again, not return
    // a stale negative cache. The stale-fallback for 429 lives in
    // getQuotaWindows() — fetchClaudeQuota itself stays a thin wrapper.
    const recovered = await fetchClaudeQuota(TOKEN_D);
    expect(recovered.length).toBeGreaterThan(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
