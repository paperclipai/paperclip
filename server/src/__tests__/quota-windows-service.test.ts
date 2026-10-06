import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_QUOTA_PACING_SETTINGS, type ProviderQuotaResult } from "@paperclipai/shared";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import {
  QUOTA_WINDOWS_CACHE_TTL_MS,
  QUOTA_WINDOWS_ERROR_CACHE_TTL_MS,
  fetchAllQuotaWindows,
  resetQuotaWindowsCacheForTests,
} from "../services/quota-windows.js";
import { createQuotaPacingController } from "../services/quota-pacing.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");

const codexResult: ProviderQuotaResult = {
  provider: "openai",
  source: "codex-rpc",
  ok: true,
  windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function registerAdapters(...adapters: Array<{ type: string; getQuotaWindows: () => Promise<ProviderQuotaResult> }>) {
  vi.mocked(listServerAdapters).mockReturnValue(adapters as never);
}

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetQuotaWindowsCacheForTests();
  });

  afterEach(() => {
    resetQuotaWindowsCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    registerAdapters(
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue(codexResult) },
      { type: "claude_local", getQuotaWindows: vi.fn(() => new Promise<ProviderQuotaResult>(() => {})) },
    );

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      { ...codexResult, fetchedAt: NOW.toISOString() },
      {
        provider: "anthropic",
        ok: false,
        error: "quota polling timed out after 20s",
        windows: [],
        fetchedAt: new Date(NOW.getTime() + 20_000).toISOString(),
      },
    ]);
  });

  it("turns a rejected adapter call into an error result", async () => {
    registerAdapters({ type: "codex_local", getQuotaWindows: vi.fn().mockRejectedValue(new Error("boom")) });

    expect(await fetchAllQuotaWindows()).toEqual([
      { provider: "openai", ok: false, error: "Error: boom", windows: [], fetchedAt: NOW.toISOString() },
    ]);
  });

  it("shares one in-flight provider request between concurrent callers", async () => {
    const response = deferred<ProviderQuotaResult>();
    const getQuotaWindows = vi.fn(() => response.promise);
    registerAdapters({ type: "codex_local", getQuotaWindows });

    const first = fetchAllQuotaWindows();
    const second = fetchAllQuotaWindows();
    response.resolve(codexResult);

    const [firstResults, secondResults] = await Promise.all([first, second]);
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);
    expect(secondResults).toEqual(firstResults);
    expect(firstResults[0]).toMatchObject({ ok: true, fetchedAt: NOW.toISOString() });
  });

  it("serves a call within the TTL from the cache and fetches again after it", async () => {
    const getQuotaWindows = vi.fn(async () => codexResult);
    registerAdapters({ type: "codex_local", getQuotaWindows });

    await fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(QUOTA_WINDOWS_CACHE_TTL_MS - 1);
    const cached = await fetchAllQuotaWindows();
    expect(getQuotaWindows).toHaveBeenCalledTimes(1);
    // A cached result keeps the time its provider answered.
    expect(cached[0]?.fetchedAt).toBe(NOW.toISOString());

    await vi.advanceTimersByTimeAsync(1);
    const refreshed = await fetchAllQuotaWindows();
    expect(getQuotaWindows).toHaveBeenCalledTimes(2);
    expect(refreshed[0]?.fetchedAt).toBe(new Date(NOW.getTime() + QUOTA_WINDOWS_CACHE_TTL_MS).toISOString());
  });

  it("keeps a failed result only briefly and caches each provider on its own", async () => {
    const codexQuota = vi.fn(async () => codexResult);
    const claudeQuota = vi
      .fn<() => Promise<ProviderQuotaResult>>()
      .mockResolvedValueOnce({ provider: "anthropic", ok: false, error: "rate limited", windows: [] })
      .mockResolvedValue({ provider: "anthropic", ok: true, windows: [] });
    registerAdapters(
      { type: "codex_local", getQuotaWindows: codexQuota },
      { type: "claude_local", getQuotaWindows: claudeQuota },
    );

    expect((await fetchAllQuotaWindows())[1]).toMatchObject({ ok: false, error: "rate limited" });
    // A burst of callers right after the failure reuses it.
    await vi.advanceTimersByTimeAsync(QUOTA_WINDOWS_ERROR_CACHE_TTL_MS - 1);
    expect((await fetchAllQuotaWindows())[1]).toMatchObject({ ok: false });
    expect(claudeQuota).toHaveBeenCalledTimes(1);

    // After the short error TTL only the failed provider is asked again.
    await vi.advanceTimersByTimeAsync(1);
    expect((await fetchAllQuotaWindows())[1]).toMatchObject({ ok: true });
    expect(claudeQuota).toHaveBeenCalledTimes(2);
    expect(codexQuota).toHaveBeenCalledTimes(1);
  });

  it("serves a pacing poll from the result of a Costs page load a moment earlier", async () => {
    const sessionSeconds = 5 * 60 * 60;
    const getQuotaWindows = vi.fn(async (): Promise<ProviderQuotaResult> => ({
      provider: "anthropic",
      ok: true,
      windows: [
        {
          label: "Current session",
          usedPercent: 60,
          resetsAt: new Date(NOW.getTime() + (sessionSeconds / 2) * 1000).toISOString(),
          valueLabel: null,
          kind: "session",
          windowSeconds: sessionSeconds,
        },
      ],
    }));
    registerAdapters({ type: "claude_local", getQuotaWindows });

    // The quota-windows route reads through the same shared fetch.
    await fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(5_000);
    const controller = createQuotaPacingController({
      loadSettings: async () => ({ ...DEFAULT_QUOTA_PACING_SETTINGS, enabled: true }),
    });
    await controller.ready;

    expect(getQuotaWindows).toHaveBeenCalledTimes(1);
    expect(controller.effectiveMaxConcurrentRuns("claude_local", 4)).toBe(1);
    // Staleness counts from when the provider answered, not from the poll.
    expect(controller.getState().providers[0]).toMatchObject({
      provider: "anthropic",
      mode: "low",
      lastPolledAt: NOW.toISOString(),
    });
    controller.stop();
  });
});
