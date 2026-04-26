import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  claudeConfigDir,
  fetchClaudeQuota,
  fetchWithTimeout,
  parseClaudeCliUsageText,
  toPercent,
} from "./quota.js";

// ============================================================================
// toPercent
// ============================================================================

describe("toPercent", () => {
  it("returns null for null input", () => {
    expect(toPercent(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(toPercent(undefined)).toBeNull();
  });

  it("treats values < 1 as fractions (multiplies by 100)", () => {
    expect(toPercent(0.5)).toBe(50);
  });

  it("treats values >= 1 as percentages (no multiplication)", () => {
    expect(toPercent(50)).toBe(50);
  });

  it("rounds fractional results", () => {
    expect(toPercent(0.756)).toBe(76);
  });

  it("rounds percentage values", () => {
    expect(toPercent(75.6)).toBe(76);
  });

  it("returns 0 for 0.0", () => {
    expect(toPercent(0)).toBe(0);
  });

  it("caps result at 100 for fraction input over 1.0x", () => {
    // 0.999 * 100 = 99.9 → rounds to 100
    expect(toPercent(0.999)).toBe(100);
  });

  it("caps result at 100 for percentage input over 100", () => {
    expect(toPercent(150)).toBe(100);
  });

  it("returns 1 for exactly 1 (treated as percentage, not fraction)", () => {
    // 1 is not < 1, so it is treated as a percent value: Math.round(1) = 1
    expect(toPercent(1)).toBe(1);
  });

  it("returns 100 for exactly 100", () => {
    expect(toPercent(100)).toBe(100);
  });
});

// ============================================================================
// claudeConfigDir
// ============================================================================

describe("claudeConfigDir", () => {
  const originalEnv = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalEnv;
    }
  });

  it("returns the CLAUDE_CONFIG_DIR env var when set", () => {
    process.env.CLAUDE_CONFIG_DIR = "/custom/config/dir";
    expect(claudeConfigDir()).toBe("/custom/config/dir");
  });

  it("trims whitespace from the CLAUDE_CONFIG_DIR env var", () => {
    process.env.CLAUDE_CONFIG_DIR = "  /custom/config/dir  ";
    expect(claudeConfigDir()).toBe("/custom/config/dir");
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is not set", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(path.join(os.homedir(), ".claude"));
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty string", () => {
    process.env.CLAUDE_CONFIG_DIR = "";
    expect(claudeConfigDir()).toBe(path.join(os.homedir(), ".claude"));
  });

  it("falls back to ~/.claude when CLAUDE_CONFIG_DIR is whitespace-only", () => {
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(claudeConfigDir()).toBe(path.join(os.homedir(), ".claude"));
  });
});

// ============================================================================
// fetchWithTimeout
// ============================================================================

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns the fetch response when it resolves before timeout", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const response = await fetchWithTimeout("https://example.com", {}, 5000);
    expect(response.status).toBe(200);
    fetchSpy.mockRestore();
  });

  it("passes through additional init options to fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchWithTimeout("https://example.com", { method: "POST" }, 5000);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe("POST");
    fetchSpy.mockRestore();
  });

  it("includes an AbortSignal in the fetch options", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await fetchWithTimeout("https://example.com", {}, 5000);
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    fetchSpy.mockRestore();
  });

  it("aborts the request when the timeout fires", async () => {
    vi.useFakeTimers();
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_, init) => {
      return new Promise<Response>((_, reject) => {
        (init as RequestInit).signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const promise = fetchWithTimeout("https://example.com", {}, 100);
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

// ============================================================================
// fetchClaudeQuota
// ============================================================================

describe("fetchClaudeQuota", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws when the API returns a non-ok status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(fetchClaudeQuota("my-token")).rejects.toThrow("401");
  });

  it("includes Authorization and anthropic-beta headers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await fetchClaudeQuota("tok-abc");
    const headers = (fetchSpy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-abc");
    expect(headers["anthropic-beta"]).toContain("oauth");
  });

  it("returns empty array when API body has no quota fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows).toEqual([]);
  });

  it("parses five_hour window into 'Current session' entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ five_hour: { utilization: 0.45, resets_at: "2026-04-23T10:00:00Z" } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows).toHaveLength(1);
    expect(windows[0]!.label).toBe("Current session");
    expect(windows[0]!.usedPercent).toBe(45);
    expect(windows[0]!.resetsAt).toBe("2026-04-23T10:00:00Z");
  });

  it("parses seven_day window into 'Current week (all models)' entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ seven_day: { utilization: 0.30 } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows).toHaveLength(1);
    expect(windows[0]!.label).toBe("Current week (all models)");
    expect(windows[0]!.usedPercent).toBe(30);
  });

  it("parses seven_day_sonnet window into 'Current week (Sonnet only)' entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ seven_day_sonnet: { utilization: 60 } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.label).toBe("Current week (Sonnet only)");
    expect(windows[0]!.usedPercent).toBe(60);
  });

  it("parses seven_day_opus window into 'Current week (Opus only)' entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ seven_day_opus: { utilization: 0.75 } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.label).toBe("Current week (Opus only)");
    expect(windows[0]!.usedPercent).toBe(75);
  });

  it("applies toPercent to utilization: fraction < 1 is multiplied by 100", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ five_hour: { utilization: 0.234 } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.usedPercent).toBe(23); // Math.round(23.4)
  });

  it("sets usedPercent null when utilization is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ five_hour: { utilization: null } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.usedPercent).toBeNull();
  });

  it("parses extra_usage with is_enabled=false as 'Not enabled'", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ extra_usage: { is_enabled: false } }), { status: 200 }),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.label).toBe("Extra usage");
    expect(windows[0]!.usedPercent).toBeNull();
    expect(windows[0]!.valueLabel).toBe("Not enabled");
    expect(windows[0]!.detail).toBe("Extra usage not enabled");
  });

  it("parses extra_usage with monthly_limit and used_credits as formatted amounts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000, currency: "USD" } }),
        { status: 200 },
      ),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows[0]!.label).toBe("Extra usage");
    // $10.00 / $50.00 (values in cents converted to dollars)
    expect(windows[0]!.valueLabel).toContain("$10.00");
    expect(windows[0]!.valueLabel).toContain("$50.00");
  });

  it("returns multiple windows when multiple fields present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          five_hour: { utilization: 0.1 },
          seven_day: { utilization: 0.2 },
        }),
        { status: 200 },
      ),
    );
    const windows = await fetchClaudeQuota("tok");
    expect(windows).toHaveLength(2);
    expect(windows[0]!.label).toBe("Current session");
    expect(windows[1]!.label).toBe("Current week (all models)");
  });
});

// ============================================================================
// parseClaudeCliUsageText — basic parsing
// ============================================================================

describe("parseClaudeCliUsageText — basic section parsing", () => {
  it("parses a minimal usage text with only 'Current session'", () => {
    const text = "Current session\n45%\n";
    const windows = parseClaudeCliUsageText(text);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.label).toBe("Current session");
    expect(windows[0]!.usedPercent).toBe(45);
  });

  it("parses multiple sections", () => {
    const text = [
      "Current session",
      "45%",
      "Current week (all models)",
      "30%",
    ].join("\n");
    const windows = parseClaudeCliUsageText(text);
    expect(windows).toHaveLength(2);
    expect(windows[0]!.label).toBe("Current session");
    expect(windows[1]!.label).toBe("Current week (all models)");
  });

  it("normalizes 'Current week' section labels to canonical form", () => {
    const text = "Current session\n50%\nCurrent week Sonnet only\n20%\n";
    const windows = parseClaudeCliUsageText(text);
    expect(windows[1]!.label).toBe("Current week (Sonnet only)");
  });

  it("normalizes 'Current week Opus only' to canonical form", () => {
    const text = "Current session\n50%\nCurrent week Opus only\n20%\n";
    const windows = parseClaudeCliUsageText(text);
    expect(windows[1]!.label).toBe("Current week (Opus only)");
  });

  it("includes 'Extra usage' section", () => {
    const text = "Current session\n50%\nExtra usage\n$5.00 / $50.00\n";
    const windows = parseClaudeCliUsageText(text);
    const extra = windows.find((w) => w.label === "Extra usage");
    expect(extra).toBeTruthy();
  });

  it("throws when 'Current session' section is absent", () => {
    const text = "Current week (all models)\n30%\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("Could not parse Claude CLI usage output.");
  });
});

// ============================================================================
// parseClaudeCliUsageText — percentage parsing
// ============================================================================

describe("parseClaudeCliUsageText — percentage parsing", () => {
  it("parses integer percentage directly", () => {
    const windows = parseClaudeCliUsageText("Current session\n72%\n");
    expect(windows[0]!.usedPercent).toBe(72);
  });

  it("parses decimal percentage (rounds)", () => {
    const windows = parseClaudeCliUsageText("Current session\n72.6%\n");
    expect(windows[0]!.usedPercent).toBe(73);
  });

  it("inverts percentage when line contains 'remaining'", () => {
    const windows = parseClaudeCliUsageText("Current session\n30% remaining\n");
    expect(windows[0]!.usedPercent).toBe(70); // 100 - 30
  });

  it("inverts percentage when line contains 'left'", () => {
    const windows = parseClaudeCliUsageText("Current session\n20% left\n");
    expect(windows[0]!.usedPercent).toBe(80);
  });

  it("inverts percentage when line contains 'available'", () => {
    const windows = parseClaudeCliUsageText("Current session\n40% available\n");
    expect(windows[0]!.usedPercent).toBe(60);
  });

  it("sets usedPercent null when no percentage found in section", () => {
    const windows = parseClaudeCliUsageText("Current session\nSome text without a percentage\n");
    expect(windows[0]!.usedPercent).toBeNull();
  });

  it("caps percentage at 100", () => {
    const windows = parseClaudeCliUsageText("Current session\n150%\n");
    expect(windows[0]!.usedPercent).toBe(100);
  });

  it("clamps inverted percentage at 0 (100% remaining = 0% used)", () => {
    const windows = parseClaudeCliUsageText("Current session\n100% remaining\n");
    expect(windows[0]!.usedPercent).toBe(0);
  });
});

// ============================================================================
// parseClaudeCliUsageText — error extraction
// ============================================================================

describe("parseClaudeCliUsageText — error extraction", () => {
  it("throws for token_expired in text", () => {
    const text = "Current session\ntoken_expired\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("token expired");
  });

  it("throws for 'token has expired' in text", () => {
    const text = "Current session\nToken has expired\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("token expired");
  });

  it("throws for authentication_error in text", () => {
    const text = "Current session\nauthentication_error\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("authentication error");
  });

  it("throws for rate_limit_error in text", () => {
    const text = "Current session\nrate_limit_error\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("rate limited");
  });

  it("throws for 'rate limited' phrase in text", () => {
    const text = "Current session\nrate limited\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("rate limited");
  });

  it("throws for 'failed to load usage data' in text", () => {
    const text = "Current session\nFailed to load usage data\n";
    expect(() => parseClaudeCliUsageText(text)).toThrow("could not load usage data");
  });
});

// ============================================================================
// parseClaudeCliUsageText — terminal text cleanup
// ============================================================================

describe("parseClaudeCliUsageText — terminal text cleanup", () => {
  it("strips ANSI escape codes", () => {
    // ANSI color code + reset
    const text = "\u001B[32mCurrent session\u001B[0m\n45%\n";
    const windows = parseClaudeCliUsageText(text);
    expect(windows[0]!.label).toBe("Current session");
    expect(windows[0]!.usedPercent).toBe(45);
  });

  it("handles backspace characters in text", () => {
    // "Currrent session" with a backspace fixing the extra 'r'
    const text = "Currr\bent session\n45%\n";
    const windows = parseClaudeCliUsageText(text);
    expect(windows[0]!.label).toBe("Current session");
  });

  it("handles carriage returns by converting to newlines", () => {
    const text = "Current session\r45%\r";
    const windows = parseClaudeCliUsageText(text);
    expect(windows[0]!.usedPercent).toBe(45);
  });

  it("strips null bytes from text", () => {
    const text = "Current\u0000 session\n45%\n";
    // After stripping null byte: "Current session"
    const windows = parseClaudeCliUsageText(text);
    expect(windows[0]!.label).toBe("Current session");
  });
});

// ============================================================================
// parseClaudeCliUsageText — Settings panel trimming
// ============================================================================

describe("parseClaudeCliUsageText — Settings panel trimming", () => {
  it("trims to the latest 'Settings:' panel when present", () => {
    // Earlier output before settings panel should be ignored
    const text = [
      "Some earlier output",
      "Fake current session",
      "99%",
      "Settings: some config",
      "Current session",
      "45%",
    ].join("\n");
    const windows = parseClaudeCliUsageText(text);
    // Only one "Current session" section from after "Settings:"
    expect(windows).toHaveLength(1);
    expect(windows[0]!.usedPercent).toBe(45);
  });

  it("stops parsing at 'status dialog dismissed' stop marker", () => {
    // trimToLatestUsagePanel requires "usage" and "current session" in the tail
    const text = [
      "Settings: usage info",
      "Current session",
      "45%",
      "status dialog dismissed",
      "Current week (all models)",
      "30%",
    ].join("\n");
    const windows = parseClaudeCliUsageText(text);
    // "Current week" should be cut off by the stop marker
    expect(windows.find((w) => w.label === "Current week (all models)")).toBeUndefined();
  });
});
