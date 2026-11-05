import { describe, expect, it } from "vitest";
import {
  mergeProviderRateLimitSnapshots,
  parseProviderRateLimitSnapshot,
  providerRateLimitSnapshotFromNotice,
  summarizeProviderRateLimits,
  type ProviderRateLimitSnapshot,
} from "./provider-rate-limits.js";

const NOW = Date.parse("2026-11-05T15:18:00.000Z");
const base: ProviderRateLimitSnapshot = {
  schema: "paperclip.provider.rate_limits.v1",
  provider: "openai",
  windows: [
    { id: "codex.primary", label: "5-hour window", shortLabel: "5h", windowMinutes: 300, usedPercent: 78, resetsAt: "2026-11-05T15:40:00.000Z", status: null },
    { id: "codex.secondary", label: "Weekly", shortLabel: "7d", windowMinutes: 10080, usedPercent: 41, resetsAt: "2026-11-09T09:00:00.000Z", status: null },
  ],
  credits: null,
  limitReached: null,
  observedAt: "2026-11-05T15:17:00.000Z",
};

describe("provider rate limits", () => {
  it("summarizes the fullest current window and its tone", () => {
    expect(summarizeProviderRateLimits(base, NOW)).toMatchObject({ tone: "normal", limited: false, window: { id: "codex.primary" } });
    const warm = { ...base, windows: [{ ...base.windows[0]!, usedPercent: 86 }, base.windows[1]!] };
    expect(summarizeProviderRateLimits(warm, NOW)?.tone).toBe("warn");
  });

  it("drops windows whose reset has passed", () => {
    const later = Date.parse("2026-11-05T16:00:00.000Z");
    expect(summarizeProviderRateLimits(base, later)?.window?.id).toBe("codex.secondary");
    expect(summarizeProviderRateLimits(base, Date.parse("2026-11-10T00:00:00.000Z"))).toBeNull();
  });

  it("reports the limited state until the reset", () => {
    const limited = { ...base, limitReached: { windowId: "codex.primary", reason: "rate_limit_reached", resetsAt: "2026-11-05T15:40:00.000Z" } };
    expect(summarizeProviderRateLimits(limited, NOW)).toMatchObject({ tone: "reached", limited: true, limitedUntil: "2026-11-05T15:40:00.000Z" });
    expect(summarizeProviderRateLimits(limited, Date.parse("2026-11-05T15:41:00.000Z"))?.limited).toBe(false);
  });

  it("reads the snapshot from a rate-limit notice and rejects other shapes", () => {
    const payload = {
      schema: "paperclip.provider.notice.v1", category: "provider.rate_limits",
      details: [{ name: "rateLimits", value: JSON.stringify(base) }],
    };
    expect(providerRateLimitSnapshotFromNotice("provider.notice.recorded", payload)).toEqual(base);
    expect(providerRateLimitSnapshotFromNotice("provider.notice.recorded", { ...payload, category: "warning" })).toBeNull();
    expect(providerRateLimitSnapshotFromNotice("provider.notice.recorded", { ...payload, details: [{ name: "rateLimits", value: "{" }] })).toBeNull();
    expect(parseProviderRateLimitSnapshot({ ...base, provider: "google" })).toBeNull();
  });

  it("merges by window and ignores out-of-order snapshots", () => {
    const next = { ...base, windows: [{ ...base.windows[0]!, usedPercent: 90 }], observedAt: "2026-11-05T15:20:00.000Z" };
    expect(mergeProviderRateLimitSnapshots(base, next).windows.map((w) => w.usedPercent)).toEqual([90, 41]);
    expect(mergeProviderRateLimitSnapshots(next, base)).toBe(next);
  });
});
