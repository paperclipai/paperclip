import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";
import { logger } from "../middleware/logger.js";

describe("fetchAllQuotaWindows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns adapter results without waiting for a slower provider to finish forever", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      {
        type: "codex_local",
        getQuotaWindows: vi.fn().mockResolvedValue({
          provider: "openai",
          source: "codex-rpc",
          ok: true,
          windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
        }),
      },
      {
        type: "claude_local",
        getQuotaWindows: vi.fn(() => new Promise(() => {})),
      },
    ] as never);

    const promise = fetchAllQuotaWindows();
    await vi.advanceTimersByTimeAsync(20_001);
    const results = await promise;

    expect(results).toEqual([
      {
        provider: "openai",
        source: "codex-rpc",
        ok: true,
        windows: [{ label: "5h limit", usedPercent: 2, resetsAt: null, valueLabel: null, detail: null }],
      },
      {
        provider: "anthropic",
        ok: false,
        error: "Subscription quota is currently unavailable. Check usage with your provider.",
        windows: [],
      },
    ]);
  });

  it("keeps command diagnostics out of API responses and redacts them in server logs", async () => {
    const diagnostic = 'Command failed: sh -c probe --token fixture-private-token';
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: vi.fn().mockResolvedValue({
        provider: "anthropic", ok: false, windows: [], error: diagnostic,
      }) },
      { type: "codex_local", getQuotaWindows: vi.fn().mockRejectedValue(new Error(diagnostic)) },
    ] as never);

    const results = await fetchAllQuotaWindows();
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Subscription quota is currently unavailable. Check usage with your provider.");
    }
    expect(JSON.stringify(results)).not.toContain("Command failed");
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      adapterType: "claude_local", diagnostic: expect.stringContaining("Command failed"),
    }), "Provider subscription quota unavailable");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("fixture-private-token");
  });

  it("isolates synchronous probe failures and preserves structured auth failure information", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: () => { throw new Error("local command unavailable"); } },
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue({
        provider: "openai", source: "codex-rpc", ok: false,
        errorFamily: "refresh_token_expired", error: "private diagnostic", windows: [],
      }) },
    ] as never);
    const results = await fetchAllQuotaWindows();
    expect(results[0]).toMatchObject({ provider: "anthropic", ok: false });
    expect(results[1]).toMatchObject({
      provider: "openai", source: "codex-rpc", ok: false, errorFamily: "refresh_token_expired",
    });
    expect(JSON.stringify(results)).not.toContain("private diagnostic");
  });
});
