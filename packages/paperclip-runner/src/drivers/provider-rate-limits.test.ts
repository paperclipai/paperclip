import { describe, expect, it } from "vitest";
import {
  PROVIDER_RATE_LIMITS_CATEGORY,
  claudeRateLimitSnapshot,
  codexRateLimitSnapshot,
  rateLimitNoticeEvent,
  rateLimitSnapshotChanged,
} from "./provider-rate-limits.js";

const T0 = "2026-11-05T15:00:00.000Z";
const resetsAt = Date.parse("2026-11-05T15:40:00.000Z") / 1000;

describe("codexRateLimitSnapshot", () => {
  it("normalizes primary and secondary windows, credits and reset times", () => {
    const snapshot = codexRateLimitSnapshot({
      rateLimits: {
        limitId: "codex", limitName: null, normalModelSlug: null,
        primary: { usedPercent: 78, windowDurationMins: 300, resetsAt },
        secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: resetsAt + 86400 },
        credits: { hasCredits: true, unlimited: false, balance: "12.40" },
        individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null,
      },
    }, null, T0);
    expect(snapshot).toMatchObject({
      provider: "openai",
      credits: { hasCredits: true, unlimited: false, balance: "12.40" },
      limitReached: null,
      windows: [
        { id: "codex.primary", label: "5-hour window", shortLabel: "5h", usedPercent: 78, resetsAt: "2026-11-05T15:40:00.000Z" },
        { id: "codex.secondary", label: "Weekly", shortLabel: "7d", usedPercent: 41 },
      ],
    });
  });

  it("merges a sparse update without clearing known windows", () => {
    const first = codexRateLimitSnapshot({ rateLimits: {
      limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: resetsAt + 86400 }, credits: null,
    } }, null, T0);
    const second = codexRateLimitSnapshot({ rateLimits: {
      limitId: "codex", primary: { usedPercent: 55, windowDurationMins: null, resetsAt: null }, secondary: null, credits: null,
    } }, first, T0);
    expect(second?.windows.map((window) => [window.id, window.usedPercent, window.windowMinutes, window.resetsAt])).toEqual([
      ["codex.primary", 55, 300, "2026-11-05T15:40:00.000Z"],
      ["codex.secondary", 10, 10080, "2026-11-06T15:40:00.000Z"],
    ]);
  });

  it("marks the fullest window reached when Codex reports a reached type", () => {
    const snapshot = codexRateLimitSnapshot({ rateLimits: {
      limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: resetsAt + 86400 },
      rateLimitReachedType: "rate_limit_reached",
    } }, null, T0);
    expect(snapshot?.limitReached).toEqual({
      windowId: "codex.primary", reason: "rate_limit_reached", resetsAt: "2026-11-05T15:40:00.000Z",
    });
  });

  it("returns null for an empty update", () => {
    expect(codexRateLimitSnapshot({ rateLimits: { limitId: "codex", primary: null, secondary: null } }, null, T0)).toBeNull();
    expect(codexRateLimitSnapshot({}, null, T0)).toBeNull();
  });
});

describe("claudeRateLimitSnapshot", () => {
  it("maps utilization (0..1) per rate-limit type and merges types", () => {
    const five = claudeRateLimitSnapshot({ "_claude/rateLimit": {
      status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.86, resetsAt,
    } }, null, T0);
    const week = claudeRateLimitSnapshot({ "_claude/rateLimit": {
      status: "allowed", rateLimitType: "seven_day", utilization: 0.63,
    } }, five, T0);
    expect(week?.windows).toEqual([
      expect.objectContaining({ id: "claude.five_hour", label: "5-hour window", usedPercent: 86, status: "warning" }),
      expect.objectContaining({ id: "claude.seven_day", label: "Weekly", usedPercent: 63, status: "allowed" }),
    ]);
    expect(week?.limitReached).toBeNull();
  });

  it("reports a rejected window as reached even without utilization", () => {
    const snapshot = claudeRateLimitSnapshot({ "_claude/rateLimit": {
      status: "rejected", rateLimitType: "five_hour", resetsAt,
    } }, null, T0);
    expect(snapshot?.windows[0]?.usedPercent).toBe(100);
    expect(snapshot?.limitReached).toEqual({
      windowId: "claude.five_hour", reason: "rate_limit_reached", resetsAt: "2026-11-05T15:40:00.000Z",
    });
  });

  it("ignores usage updates without rate-limit metadata", () => {
    expect(claudeRateLimitSnapshot(undefined, null, T0)).toBeNull();
    expect(claudeRateLimitSnapshot({ usage: {} }, null, T0)).toBeNull();
  });
});

describe("rateLimitNoticeEvent", () => {
  it("emits an account-scoped notice carrying the snapshot as one JSON detail", () => {
    const snapshot = codexRateLimitSnapshot({ rateLimits: {
      limitId: "codex", primary: { usedPercent: 78, windowDurationMins: 300, resetsAt },
    } }, null, T0)!;
    const event = rateLimitNoticeEvent(snapshot, "codex-rate-limits:1");
    expect(event.eventType).toBe("provider.notice.recorded");
    expect(event.payload).toMatchObject({
      schema: "paperclip.provider.notice.v1", category: PROVIDER_RATE_LIMITS_CATEGORY,
      scope: "account", severity: "info", summary: "Codex rate limits: 5-hour window 78%",
    });
    const details = event.payload.details as Array<{ name: string; value: string }>;
    expect(JSON.parse(details[0]!.value)).toEqual(snapshot);
  });

  it("only reports a change when the content differs", () => {
    const a = codexRateLimitSnapshot({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt } } }, null, T0)!;
    const b = codexRateLimitSnapshot({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt } } }, a, "2026-11-05T15:05:00.000Z")!;
    expect(rateLimitSnapshotChanged(a, b)).toBe(false);
    const c = codexRateLimitSnapshot({ rateLimits: { primary: { usedPercent: 6 } } }, b, T0)!;
    expect(rateLimitSnapshotChanged(b, c)).toBe(true);
  });
});
