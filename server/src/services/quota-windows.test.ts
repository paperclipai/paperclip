import { describe, expect, it, vi } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows } from "./quota-windows.js";

const mockedListServerAdapters = vi.mocked(listServerAdapters);

function makeAdapter(
  type: string,
  getQuotaWindows?: () => Promise<{ provider: string; ok: boolean; error?: string; windows: unknown[] }>,
) {
  return { type, getQuotaWindows };
}

// ============================================================================
// fetchAllQuotaWindows — filtering
// ============================================================================

describe("fetchAllQuotaWindows — filtering", () => {
  it("returns empty array when no adapters are registered", async () => {
    mockedListServerAdapters.mockReturnValue([]);
    const results = await fetchAllQuotaWindows();
    expect(results).toEqual([]);
  });

  it("returns empty array when no adapters implement getQuotaWindows", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local") as never,
      makeAdapter("cursor_local") as never,
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toEqual([]);
  });

  it("skips adapters without getQuotaWindows but includes those that have it", async () => {
    const getQuotaWindows = vi.fn().mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", getQuotaWindows) as never,
      makeAdapter("cursor_local") as never, // no getQuotaWindows
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(1);
    expect(getQuotaWindows).toHaveBeenCalledOnce();
  });
});

// ============================================================================
// fetchAllQuotaWindows — successful results
// ============================================================================

describe("fetchAllQuotaWindows — successful adapter results", () => {
  it("returns fulfilled result directly", async () => {
    const expected = { provider: "anthropic", ok: true, windows: [{ remaining: 5 }] };
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", () => Promise.resolve(expected)) as never,
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expected);
  });

  it("returns all results when multiple adapters succeed", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", () => Promise.resolve({ provider: "anthropic", ok: true, windows: [] })) as never,
      makeAdapter("codex_local", () => Promise.resolve({ provider: "openai", ok: true, windows: [] })) as never,
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(2);
  });
});

// ============================================================================
// fetchAllQuotaWindows — error handling and provider slug mapping
// ============================================================================

describe("fetchAllQuotaWindows — error results", () => {
  it("returns error result when adapter getQuotaWindows rejects", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", () => Promise.reject(new Error("rate limited"))) as never,
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("rate limited");
    expect(results[0]!.windows).toEqual([]);
  });

  it("maps claude_local adapter type to 'anthropic' provider in error result", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", () => Promise.reject(new Error("fail"))) as never,
    ]);
    const [result] = await fetchAllQuotaWindows();
    expect(result!.provider).toBe("anthropic");
  });

  it("maps codex_local adapter type to 'openai' provider in error result", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("codex_local", () => Promise.reject(new Error("fail"))) as never,
    ]);
    const [result] = await fetchAllQuotaWindows();
    expect(result!.provider).toBe("openai");
  });

  it("uses adapter type as-is for unknown type in error result", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("gemini_local", () => Promise.reject(new Error("fail"))) as never,
    ]);
    const [result] = await fetchAllQuotaWindows();
    expect(result!.provider).toBe("gemini_local");
  });

  it("handles mix of successful and failed adapters", async () => {
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("claude_local", () => Promise.resolve({ provider: "anthropic", ok: true, windows: [] })) as never,
      makeAdapter("codex_local", () => Promise.reject(new Error("quota unreachable"))) as never,
    ]);
    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(2);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(false);
    expect(results[1]!.provider).toBe("openai");
  });

  it("error string includes the rejection reason", async () => {
    const err = new TypeError("connection refused");
    mockedListServerAdapters.mockReturnValue([
      makeAdapter("cursor_local", () => Promise.reject(err)) as never,
    ]);
    const [result] = await fetchAllQuotaWindows();
    expect(result!.error).toContain("connection refused");
  });
});
