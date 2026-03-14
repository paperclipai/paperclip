import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import type { QuotaWindow } from "@paperclipai/adapter-utils";

// Pure utility functions — import directly from adapter source
import {
  toPercent,
  fetchWithTimeout,
  fetchClaudeQuota,
  readClaudeToken,
  claudeConfigDir,
} from "@paperclipai/adapter-claude-local/server";

import {
  secondsToWindowLabel,
  readCodexToken,
  fetchCodexQuota,
  codexHomeDir,
} from "@paperclipai/adapter-codex-local/server";

// ---------------------------------------------------------------------------
// toPercent
// ---------------------------------------------------------------------------

describe("toPercent", () => {
  it("returns null for null input", () => {
    expect(toPercent(null)).toBe(null);
  });

  it("returns null for undefined input", () => {
    expect(toPercent(undefined)).toBe(null);
  });

  it("converts 0 to 0", () => {
    expect(toPercent(0)).toBe(0);
  });

  it("converts 0.5 to 50", () => {
    expect(toPercent(0.5)).toBe(50);
  });

  it("converts 1.0 to 100", () => {
    expect(toPercent(1.0)).toBe(100);
  });

  it("clamps overshoot to 100", () => {
    // floating-point utilization can slightly exceed 1.0
    expect(toPercent(1.001)).toBe(100);
    expect(toPercent(1.01)).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(toPercent(0.333)).toBe(33);
    expect(toPercent(0.666)).toBe(67);
  });
});

// ---------------------------------------------------------------------------
// secondsToWindowLabel
// ---------------------------------------------------------------------------

describe("secondsToWindowLabel", () => {
  it("returns fallback for null seconds", () => {
    expect(secondsToWindowLabel(null, "Primary")).toBe("Primary");
  });

  it("returns fallback for undefined seconds", () => {
    expect(secondsToWindowLabel(undefined, "Secondary")).toBe("Secondary");
  });

  it("labels windows under 6 hours as '5h'", () => {
    expect(secondsToWindowLabel(3600, "fallback")).toBe("5h");   // 1h
    expect(secondsToWindowLabel(18000, "fallback")).toBe("5h");  // 5h exactly
  });

  it("labels windows up to 24 hours as '24h'", () => {
    expect(secondsToWindowLabel(21600, "fallback")).toBe("24h"); // 6h (≥6h boundary)
    expect(secondsToWindowLabel(86400, "fallback")).toBe("24h"); // 24h exactly
  });

  it("labels windows up to 7 days as '7d'", () => {
    expect(secondsToWindowLabel(86401, "fallback")).toBe("7d");   // just over 24h
    expect(secondsToWindowLabel(604800, "fallback")).toBe("7d"); // 7d exactly
  });

  it("labels windows beyond 7 days with actual day count", () => {
    expect(secondsToWindowLabel(1209600, "fallback")).toBe("14d"); // 14d
    expect(secondsToWindowLabel(2592000, "fallback")).toBe("30d"); // 30d
  });
});

// ---------------------------------------------------------------------------
// WHAM used_percent normalization (codex / openai)
// ---------------------------------------------------------------------------

describe("WHAM used_percent normalization via fetchCodexQuota", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(body: unknown) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => body,
    } as Response);
  }

  it("treats values >= 1 as already-percentage (50 → 50%)", async () => {
    mockFetch({
      rate_limit: {
        primary_window: {
          used_percent: 50,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(50);
  });

  it("treats values < 1 as fraction and multiplies by 100 (0.5 → 50%)", async () => {
    mockFetch({
      rate_limit: {
        primary_window: {
          used_percent: 0.5,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(50);
  });

  it("treats value exactly 1.0 as 1% (not 100%) — the < 1 heuristic boundary", async () => {
    // 1.0 is NOT < 1, so it is treated as already-percentage → 1%
    mockFetch({
      rate_limit: {
        primary_window: {
          used_percent: 1.0,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(1);
  });

  it("treats value 0 as 0%", async () => {
    mockFetch({
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(0);
  });

  it("clamps 100% to 100 (no overshoot)", async () => {
    mockFetch({
      rate_limit: {
        primary_window: {
          used_percent: 105,
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(100);
  });

  it("sets usedPercent to null when used_percent is absent", async () => {
    mockFetch({
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18000,
          reset_at: null,
        },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.usedPercent).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// readClaudeToken — filesystem paths
// ---------------------------------------------------------------------------

describe("readClaudeToken", () => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedEnv;
    }
    vi.restoreAllMocks();
  });

  it("returns null when credentials.json does not exist", async () => {
    // Point to a directory that does not have credentials.json
    process.env.CLAUDE_CONFIG_DIR = "/tmp/__no_such_paperclip_dir__";
    const token = await readClaudeToken();
    expect(token).toBe(null);
  });

  it("returns null for malformed JSON", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-claude-${Date.now()}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "credentials.json"), "not-json"),
      ),
    );
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const token = await readClaudeToken();
    expect(token).toBe(null);
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns null when claudeAiOauth key is missing", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-claude-${Date.now()}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "credentials.json"), JSON.stringify({ other: "data" })),
      ),
    );
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const token = await readClaudeToken();
    expect(token).toBe(null);
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns null when accessToken is an empty string", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-claude-${Date.now()}`);
    const creds = { claudeAiOauth: { accessToken: "" } };
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "credentials.json"), JSON.stringify(creds)),
      ),
    );
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const token = await readClaudeToken();
    expect(token).toBe(null);
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns the token when credentials file is well-formed", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-claude-${Date.now()}`);
    const creds = { claudeAiOauth: { accessToken: "my-test-token" } };
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "credentials.json"), JSON.stringify(creds)),
      ),
    );
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    const token = await readClaudeToken();
    expect(token).toBe("my-test-token");
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });
});

// ---------------------------------------------------------------------------
// readCodexToken — filesystem paths
// ---------------------------------------------------------------------------

describe("readCodexToken", () => {
  const savedEnv = process.env.CODEX_HOME;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedEnv;
    }
  });

  it("returns null when auth.json does not exist", async () => {
    process.env.CODEX_HOME = "/tmp/__no_such_paperclip_codex_dir__";
    const result = await readCodexToken();
    expect(result).toBe(null);
  });

  it("returns null for malformed JSON", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-codex-${Date.now()}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "auth.json"), "{bad json"),
      ),
    );
    process.env.CODEX_HOME = tmpDir;
    const result = await readCodexToken();
    expect(result).toBe(null);
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns null when accessToken is absent", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-codex-${Date.now()}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify({ accountId: "acc-1" })),
      ),
    );
    process.env.CODEX_HOME = tmpDir;
    const result = await readCodexToken();
    expect(result).toBe(null);
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns token and accountId when both are present", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-codex-${Date.now()}`);
    const auth = { accessToken: "codex-token", accountId: "acc-123" };
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify(auth)),
      ),
    );
    process.env.CODEX_HOME = tmpDir;
    const result = await readCodexToken();
    expect(result).toEqual({ token: "codex-token", accountId: "acc-123" });
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });

  it("returns token with null accountId when accountId is absent", async () => {
    const tmpDir = path.join(os.tmpdir(), `paperclip-test-codex-${Date.now()}`);
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(tmpDir, { recursive: true }).then(() =>
        fs.writeFile(path.join(tmpDir, "auth.json"), JSON.stringify({ accessToken: "tok" })),
      ),
    );
    process.env.CODEX_HOME = tmpDir;
    const result = await readCodexToken();
    expect(result).toEqual({ token: "tok", accountId: null });
    await import("node:fs/promises").then((fs) => fs.rm(tmpDir, { recursive: true }));
  });
});

// ---------------------------------------------------------------------------
// fetchClaudeQuota — response parsing
// ---------------------------------------------------------------------------

describe("fetchClaudeQuota", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(body: unknown, ok = true, status = 200) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      json: async () => body,
    } as Response);
  }

  it("throws when the API returns a non-200 status", async () => {
    mockFetch({}, false, 401);
    await expect(fetchClaudeQuota("token")).rejects.toThrow("anthropic usage api returned 401");
  });

  it("returns an empty array when all window fields are absent", async () => {
    mockFetch({});
    const windows = await fetchClaudeQuota("token");
    expect(windows).toEqual([]);
  });

  it("parses five_hour window", async () => {
    mockFetch({ five_hour: { utilization: 0.4, resets_at: "2026-01-01T00:00:00Z" } });
    const windows = await fetchClaudeQuota("token");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "5h", usedPercent: 40, resetsAt: "2026-01-01T00:00:00Z" });
  });

  it("parses seven_day window", async () => {
    mockFetch({ seven_day: { utilization: 0.75, resets_at: null } });
    const windows = await fetchClaudeQuota("token");
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "7d", usedPercent: 75, resetsAt: null });
  });

  it("parses seven_day_sonnet and seven_day_opus windows", async () => {
    mockFetch({
      seven_day_sonnet: { utilization: 0.2, resets_at: null },
      seven_day_opus: { utilization: 0.9, resets_at: null },
    });
    const windows = await fetchClaudeQuota("token");
    expect(windows).toHaveLength(2);
    expect(windows[0]!.label).toBe("Sonnet 7d");
    expect(windows[1]!.label).toBe("Opus 7d");
  });

  it("sets usedPercent to null when utilization is absent", async () => {
    mockFetch({ five_hour: { resets_at: null } });
    const windows = await fetchClaudeQuota("token");
    expect(windows[0]!.usedPercent).toBe(null);
  });

  it("includes all four windows when all are present", async () => {
    mockFetch({
      five_hour: { utilization: 0.1, resets_at: null },
      seven_day: { utilization: 0.2, resets_at: null },
      seven_day_sonnet: { utilization: 0.3, resets_at: null },
      seven_day_opus: { utilization: 0.4, resets_at: null },
    });
    const windows = await fetchClaudeQuota("token");
    expect(windows).toHaveLength(4);
    const labels = windows.map((w: QuotaWindow) => w.label);
    expect(labels).toEqual(["5h", "7d", "Sonnet 7d", "Opus 7d"]);
  });
});

// ---------------------------------------------------------------------------
// fetchCodexQuota — response parsing (credits, windows)
// ---------------------------------------------------------------------------

describe("fetchCodexQuota", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetch(body: unknown, ok = true, status = 200) {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok,
      status,
      json: async () => body,
    } as Response);
  }

  it("throws when the WHAM API returns a non-200 status", async () => {
    mockFetch({}, false, 403);
    await expect(fetchCodexQuota("token", null)).rejects.toThrow("chatgpt wham api returned 403");
  });

  it("passes ChatGPT-Account-Id header when accountId is provided", async () => {
    mockFetch({});
    await fetchCodexQuota("token", "acc-xyz");
    const callInit = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((callInit.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBe("acc-xyz");
  });

  it("omits ChatGPT-Account-Id header when accountId is null", async () => {
    mockFetch({});
    await fetchCodexQuota("token", null);
    const callInit = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((callInit.headers as Record<string, string>)["ChatGPT-Account-Id"]).toBeUndefined();
  });

  it("returns empty array when response body is empty", async () => {
    mockFetch({});
    const windows = await fetchCodexQuota("token", null);
    expect(windows).toEqual([]);
  });

  it("parses primary_window with 24h label", async () => {
    mockFetch({
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 86400, reset_at: "2026-01-02T00:00:00Z" },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "24h", usedPercent: 30, resetsAt: "2026-01-02T00:00:00Z" });
  });

  it("parses secondary_window alongside primary_window", async () => {
    mockFetch({
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604800 },
      },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.label).toBe("5h");
    expect(windows[1]!.label).toBe("7d");
  });

  it("includes Credits window when credits present and not unlimited", async () => {
    mockFetch({
      credits: { balance: 420, unlimited: false },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "Credits", valueLabel: "$4.20 remaining", usedPercent: null });
  });

  it("omits Credits window when unlimited is true", async () => {
    mockFetch({
      credits: { balance: 9999, unlimited: true },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows).toEqual([]);
  });

  it("shows 'N/A' valueLabel when credits balance is null", async () => {
    mockFetch({
      credits: { balance: null, unlimited: false },
    });
    const windows = await fetchCodexQuota("token", null);
    expect(windows[0]!.valueLabel).toBe("N/A");
  });
});

// ---------------------------------------------------------------------------
// fetchWithTimeout — abort on timeout
// ---------------------------------------------------------------------------

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resolves normally when fetch completes before timeout", async () => {
    const mockResponse = { ok: true, status: 200, json: async () => ({}) } as Response;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const result = await fetchWithTimeout("https://example.com", {}, 5000);
    expect(result.ok).toBe(true);
  });

  it("rejects with abort error when fetch takes too long", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      ),
    );

    const promise = fetchWithTimeout("https://example.com", {}, 1000);
    vi.advanceTimersByTime(1001);
    await expect(promise).rejects.toThrow("aborted");
  });
});
