import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  fetchClaudeQuota: vi.fn(),
  readClaudeTokenFromDir: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchClaudeQuota, readClaudeTokenFromDir } from "@paperclipai/adapter-claude-local/server";
import { fetchAllQuotaWindows, getQuotaWindowsForAccounts } from "../services/quota-windows.js";

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

describe("getQuotaWindowsForAccounts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDb(accounts: object[]) {
    const updateChain = { set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue(undefined) };
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(accounts),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue(updateChain),
      _updateChain: updateChain,
    };
  }

  it("returns empty windows for bedrock and api_key accounts without fetching", async () => {
    const db = makeDb([
      { id: "acc-1", label: "Bedrock", mode: "bedrock", credentialDir: null, lastQuotaCheckAt: null, lastUtilizationFiveHour: null, lastUtilizationSevenDay: null, lastQuotaError: null },
      { id: "acc-2", label: "API Key", mode: "api_key", credentialDir: null, lastQuotaCheckAt: null, lastUtilizationFiveHour: null, lastUtilizationSevenDay: null, lastQuotaError: null },
    ]);

    const results = await getQuotaWindowsForAccounts("company-1", db as never);

    expect(vi.mocked(fetchClaudeQuota)).not.toHaveBeenCalled();
    expect(results).toEqual([
      { accountId: "acc-1", label: "Bedrock", windows: [] },
      { accountId: "acc-2", label: "API Key", windows: [] },
    ]);
  });

  it("returns cached windows when lastQuotaCheckAt is within 60s (mock-clock)", async () => {
    vi.useFakeTimers();
    const recentCheck = new Date(Date.now() - 30_000); // 30s ago
    const db = makeDb([
      {
        id: "acc-1",
        label: "OAuth",
        mode: "oauth",
        credentialDir: "/some/dir",
        lastQuotaCheckAt: recentCheck,
        lastUtilizationFiveHour: "42",
        lastUtilizationSevenDay: "71",
        lastQuotaError: null,
      },
    ]);

    const results = await getQuotaWindowsForAccounts("company-1", db as never);

    expect(vi.mocked(fetchClaudeQuota)).not.toHaveBeenCalled();
    expect(results).toEqual([
      {
        accountId: "acc-1",
        label: "OAuth",
        windows: [
          { label: "Current session", usedPercent: 42, resetsAt: null, valueLabel: null, detail: null },
          { label: "Current week (all models)", usedPercent: 71, resetsAt: null, valueLabel: null, detail: null },
        ],
        error: undefined,
      },
    ]);
    vi.useRealTimers();
  });

  it("live-fetches and saves to DB when cache is stale (> 60s)", async () => {
    const staleCheck = new Date(Date.now() - 120_000); // 2 min ago
    const db = makeDb([
      {
        id: "acc-1",
        label: "OAuth",
        mode: "oauth",
        credentialDir: "/creds",
        lastQuotaCheckAt: staleCheck,
        lastUtilizationFiveHour: "10",
        lastUtilizationSevenDay: "20",
        lastQuotaError: null,
      },
    ]);

    vi.mocked(readClaudeTokenFromDir).mockResolvedValue("tok-abc");
    vi.mocked(fetchClaudeQuota).mockResolvedValue([
      { label: "Current session", usedPercent: 55, resetsAt: null, valueLabel: null, detail: null },
      { label: "Current week (all models)", usedPercent: 80, resetsAt: null, valueLabel: null, detail: null },
    ]);

    const results = await getQuotaWindowsForAccounts("company-1", db as never);

    expect(vi.mocked(readClaudeTokenFromDir)).toHaveBeenCalledWith("/creds");
    expect(vi.mocked(fetchClaudeQuota)).toHaveBeenCalledWith("tok-abc");
    expect(db.update).toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      accountId: "acc-1",
      windows: [
        { label: "Current session", usedPercent: 55 },
        { label: "Current week (all models)", usedPercent: 80 },
      ],
    });
  });

  it("returns error when no OAuth token found for oauth account", async () => {
    const db = makeDb([
      {
        id: "acc-1",
        label: "OAuth",
        mode: "oauth",
        credentialDir: "/creds",
        lastQuotaCheckAt: null,
        lastUtilizationFiveHour: null,
        lastUtilizationSevenDay: null,
        lastQuotaError: null,
      },
    ]);

    vi.mocked(readClaudeTokenFromDir).mockResolvedValue(null);

    const results = await getQuotaWindowsForAccounts("company-1", db as never);

    expect(results[0]).toMatchObject({ accountId: "acc-1", windows: null, error: expect.stringContaining("No OAuth token") });
  });
});
