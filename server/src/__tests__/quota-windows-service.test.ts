import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

const mockSubscriptionCredentials = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-connections.js", () => ({
  aiConnectionService: () => ({ subscriptionCredentials: mockSubscriptionCredentials }),
}));

vi.mock("@paperclipai/adapter-codex-local/server", () => ({
  getQuotaWindowsForAuth: vi.fn(async (raw: string) => ({
    provider: "openai",
    source: "codex-wham",
    ok: true,
    windows: [{ label: raw, usedPercent: 3, resetsAt: null, valueLabel: null, detail: null }],
  })),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows, fetchCompanyQuotaWindows } from "../services/quota-windows.js";

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
        error: "quota polling timed out after 20s",
        windows: [],
      },
    ]);
  });
});

describe("fetchCompanyQuotaWindows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const failedLocal = { provider: "openai", ok: false, error: "no local codex auth token", windows: [] };
  const claude = { provider: "anthropic", ok: true, windows: [] };

  const okWindow = (label: string, usedPercent = 3) => ({ label, usedPercent, resetsAt: null, valueLabel: null, detail: null });

  it("drops the failed local Codex probe when managed OpenAI accounts exist and names each account", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue(failedLocal) },
      { type: "claude_local", getQuotaWindows: vi.fn().mockResolvedValue(claude) },
    ] as never);
    mockSubscriptionCredentials.mockResolvedValue([
      { name: "My OpenAI subscription", value: async () => "auth-json" },
    ]);

    const results = await fetchCompanyQuotaWindows({} as never, "company-1", "user-1");

    expect(mockSubscriptionCredentials).toHaveBeenCalledWith("company-1", "user-1", "openai");
    expect(results).toEqual([
      claude,
      {
        provider: "openai",
        source: "codex-wham",
        ok: true,
        accountName: "My OpenAI subscription",
        windows: [okWindow("auth-json")],
      },
    ]);
  });

  it("returns one result per account, leaving the window labels alone", async () => {
    const localOk = { provider: "openai", source: "codex-rpc", ok: true, windows: [okWindow("5h limit", 9)] };
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue(localOk) },
    ] as never);
    mockSubscriptionCredentials.mockResolvedValue([
      { name: "Plus", value: async () => "plus" },
      { name: "Pro", value: async () => "pro" },
    ]);

    const results = await fetchCompanyQuotaWindows({} as never, "company-1", "user-1");

    expect(results).toEqual([
      { ...localOk, accountName: "Local Codex login" },
      { provider: "openai", source: "codex-wham", ok: true, accountName: "Plus", windows: [okWindow("plus")] },
      { provider: "openai", source: "codex-wham", ok: true, accountName: "Pro", windows: [okWindow("pro")] },
    ]);
  });

  it("keeps the error of a managed account whose quota cannot be read next to the accounts that work", async () => {
    const localOk = { provider: "openai", source: "codex-rpc", ok: true, windows: [okWindow("5h limit", 9)] };
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue(localOk) },
    ] as never);
    mockSubscriptionCredentials.mockResolvedValue([
      { name: "Plus", value: async () => "plus" },
      { name: "Broken", value: async () => { throw new Error("Reconnect this AI account"); } },
    ]);

    const results = await fetchCompanyQuotaWindows({} as never, "company-1", "user-1");

    expect(results).toEqual([
      { ...localOk, accountName: "Local Codex login" },
      { provider: "openai", source: "codex-wham", ok: true, accountName: "Plus", windows: [okWindow("plus")] },
      { provider: "openai", ok: false, accountName: "Broken", error: "Reconnect this AI account", windows: [] },
    ]);
  });

  it("returns the local results untouched when the company has no managed OpenAI account", async () => {
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "codex_local", getQuotaWindows: vi.fn().mockResolvedValue(failedLocal) },
    ] as never);
    mockSubscriptionCredentials.mockResolvedValue([]);

    expect(await fetchCompanyQuotaWindows({} as never, "company-1", "user-1")).toEqual([failedLocal]);
  });
});
