import { describe, expect, it, vi, afterEach } from "vitest";
import { resolveDotPath, fetchQuotaCost } from "@paperclipai/adapter-codex-local/server";

// ---------------------------------------------------------------------------
// resolveDotPath
// ---------------------------------------------------------------------------

describe("resolveDotPath", () => {
  it("resolves a top-level numeric field", () => {
    expect(resolveDotPath({ totalCostUsd: 12.5 }, "totalCostUsd")).toBe(12.5);
  });

  it("resolves a nested dot-path", () => {
    const obj = { usage: { fiveHour: { estimatedCostUsdUsed: 3.46 } } };
    expect(resolveDotPath(obj, "usage.fiveHour.estimatedCostUsdUsed")).toBe(3.46);
  });

  it("returns null for a missing path", () => {
    expect(resolveDotPath({ a: { b: 1 } }, "a.c")).toBeNull();
  });

  it("returns null when the resolved value is a string, not a number", () => {
    expect(resolveDotPath({ cost: "3.46" }, "cost")).toBeNull();
  });

  it("returns null when the resolved value is null", () => {
    expect(resolveDotPath({ cost: null }, "cost")).toBeNull();
  });

  it("returns null when obj is not an object", () => {
    expect(resolveDotPath(null, "cost")).toBeNull();
    expect(resolveDotPath(42, "cost")).toBeNull();
    expect(resolveDotPath("string", "cost")).toBeNull();
  });

  it("returns 0 for a zero value (valid number)", () => {
    expect(resolveDotPath({ cost: 0 }, "cost")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchQuotaCost
// ---------------------------------------------------------------------------

const baseCostApi = {
  url: "https://example.com/quota",
  key: "test-key",
  field: "usage.fiveHour.estimatedCostUsdUsed",
  timeoutMs: 5000,
  attributionMode: "strict_dedicated_key" as const,
};

describe("fetchQuotaCost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the resolved numeric value on a successful 200 response", async () => {
    const body = { usage: { fiveHour: { estimatedCostUsdUsed: 3.46 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => body,
    }));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBe(3.46);
    expect(warnings).toHaveLength(0);
  });

  it("returns null and warns on HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
    }));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("HTTP 401"))).toBe(true);
  });

  it("returns null and warns on HTTP 403", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
    }));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("HTTP 403"))).toBe(true);
  });

  it("returns null and warns on network/fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("connection refused")));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("connection refused"))).toBe(true);
  });

  it("returns null and warns on abort/timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new DOMException("The operation was aborted.", "AbortError")));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("timed out") || w.includes("failed"))).toBe(true);
  });

  it("returns null and warns when response JSON is malformed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error("Unexpected token"); },
    }));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
  });

  it("returns null and warns when configured field does not exist in response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ usage: { daily: { estimatedCostUsdUsed: 1.0 } } }),
    }));

    const warnings: string[] = [];
    const result = await fetchQuotaCost(baseCostApi, async (msg) => { warnings.push(msg); });

    expect(result).toBeNull();
    expect(warnings.some((w) => w.includes("did not resolve to a number"))).toBe(true);
  });

  it("sends Authorization Bearer header", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ usage: { fiveHour: { estimatedCostUsdUsed: 1.0 } } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await fetchQuotaCost(baseCostApi, async () => {});

    const [, options] = mockFetch.mock.calls[0];
    expect((options as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });
});
