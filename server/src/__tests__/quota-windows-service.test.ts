import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../adapters/registry.js", () => ({
  listServerAdapters: vi.fn(),
}));

import { listServerAdapters } from "../adapters/registry.js";
import { fetchAllQuotaWindows } from "../services/quota-windows.js";

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

  it("filters adapters and passes quota context through to the requested provider", async () => {
    const claudeQuota = vi.fn().mockResolvedValue({
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [],
    });
    const codexQuota = vi.fn().mockResolvedValue({
      provider: "openai",
      source: "codex-rpc",
      ok: true,
      windows: [],
    });
    vi.mocked(listServerAdapters).mockReturnValue([
      { type: "claude_local", getQuotaWindows: claudeQuota },
      { type: "codex_local", getQuotaWindows: codexQuota },
    ] as never);

    const results = await fetchAllQuotaWindows({
      adapterTypes: ["claude_local"],
      contextsByAdapterType: {
        claude_local: {
          companyId: "company-1",
          agentId: "agent-1",
          adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/tmp/managed/.claude" } },
        },
      },
    });

    expect(results).toEqual([
      {
        provider: "anthropic",
        source: "anthropic-oauth",
        ok: true,
        windows: [],
      },
    ]);
    expect(claudeQuota).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: "agent-1",
      adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/tmp/managed/.claude" } },
    });
    expect(codexQuota).not.toHaveBeenCalled();
  });
});
