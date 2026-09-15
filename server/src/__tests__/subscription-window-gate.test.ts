import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import {
  boundSubscriptionWindowWait,
  decideSubscriptionWindowWait,
  observeSubscriptionWindow,
  type SubscriptionWindowPolicy,
} from "../services/subscription-window-gate.ts";
import { createQuotaSnapshotReader } from "../services/quota-windows.ts";

const NOW = new Date("2026-09-13T12:00:00.000Z");

function window(overrides: Partial<QuotaWindow> & Pick<QuotaWindow, "key">): QuotaWindow {
  return {
    label: overrides.key ?? "window",
    usedPercent: null,
    resetsAt: null,
    valueLabel: null,
    detail: null,
    ...overrides,
  };
}

function policy(overrides: Partial<SubscriptionWindowPolicy> = {}): SubscriptionWindowPolicy {
  return {
    id: "policy-session",
    scopeType: "company",
    scopeId: "company-1",
    windowKind: "provider_session",
    amount: 80,
    ...overrides,
  };
}

function ok(windows: QuotaWindow[]): ProviderQuotaResult {
  return { provider: "anthropic", ok: true, windows };
}

describe("decideSubscriptionWindowWait", () => {
  it("returns null while usage is below every policy limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([
        window({ key: "five_hour", usedPercent: 79, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 50, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toBeNull();
  });

  it("defers to just after the window reset when usage reaches the limit", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 80, resetsAt: "2026-09-13T14:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait).toMatchObject({
      policyId: "policy-session",
      windowKind: "provider_session",
      quotaKey: "five_hour",
      provider: "anthropic",
      usedPercent: 80,
      usageUnknown: false,
      limitPercent: 80,
      resetsAt: "2026-09-13T14:00:00.000Z",
    });
    expect(wait!.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");
    expect(wait!.reason).toContain("session subscription window is at 80%");
  });

  it("falls back to the default wait when the provider reports no usable reset time", () => {
    const stale = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 95, resetsAt: "2026-09-13T11:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(stale?.resetsAt).toBeNull();
    expect(stale?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");

    const missing = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: 95, resetsAt: null })]),
      provider: "anthropic",
      now: NOW,
      defaultWaitMs: 60_000,
    });
    expect(missing?.resumeAt.toISOString()).toBe("2026-09-13T12:01:00.000Z");
  });

  it("waits for the latest reset when both the session and the week block", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([
        window({ key: "five_hour", usedPercent: 100, resetsAt: "2026-09-13T14:00:00.000Z" }),
        window({ key: "seven_day", usedPercent: 91, resetsAt: "2026-09-18T00:00:00.000Z" }),
      ]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait?.policyId).toBe("policy-week");
    expect(wait?.resumeAt.toISOString()).toBe("2026-09-18T00:00:30.000Z");
  });

  it("holds new runs for a short re-check when a limited window cannot be read", () => {
    const missingWindow = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "seven_day", usedPercent: 100 })]),
      provider: "anthropic",
      now: NOW,
      unknownWaitMs: 5 * 60_000,
    });
    expect(missingWindow).toMatchObject({
      policyId: "policy-session",
      quotaKey: "five_hour",
      usedPercent: null,
      usageUnknown: true,
      limitPercent: 80,
      resetsAt: null,
    });
    expect(missingWindow?.resumeAt.toISOString()).toBe("2026-09-13T12:05:00.000Z");
    expect(missingWindow?.reason).toContain("did not report this window");

    const noUtilization = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: "five_hour", usedPercent: null })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(noUtilization).toMatchObject({ usageUnknown: true, usedPercent: null });
    expect(noUtilization?.reason).toContain("without utilization");

    const failedRead = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { provider: "anthropic", ok: false, error: "Claude CLI /usage: probe ended early", windows: [] },
      provider: "anthropic",
      now: NOW,
    });
    expect(failedRead).toMatchObject({ usageUnknown: true, usedPercent: null });
    expect(failedRead?.reason).toContain("Claude CLI /usage: probe ended early");

    const noRow = decideSubscriptionWindowWait({ policies: [policy()], result: null, provider: "anthropic", now: NOW });
    expect(noRow).toMatchObject({ usageUnknown: true });
  });

  it("lets a stale read defer to the reset but never clear a run", () => {
    const staleAt = {
      provider: "anthropic",
      ok: true,
      stale: true,
      observedAt: "2026-09-13T11:52:00.000Z",
      error: "Anthropic OAuth usage: 429",
      windows: [window({ key: "five_hour", usedPercent: 85, resetsAt: "2026-09-13T14:00:00.000Z" })],
    } satisfies ProviderQuotaResult;
    const saturated = decideSubscriptionWindowWait({ policies: [policy()], result: staleAt, provider: "anthropic", now: NOW });
    expect(saturated).toMatchObject({ usedPercent: 85, usageUnknown: false, resetsAt: "2026-09-13T14:00:00.000Z" });
    expect(saturated?.resumeAt.toISOString()).toBe("2026-09-13T14:00:30.000Z");

    // Below the limit the stale value cannot vouch for headroom: usage may have
    // crossed the limit since that read, so the run holds for a re-check.
    const below = decideSubscriptionWindowWait({
      policies: [policy()],
      result: { ...staleAt, windows: [window({ key: "five_hour", usedPercent: 40 })] },
      provider: "anthropic",
      now: NOW,
      unknownWaitMs: 5 * 60_000,
    });
    expect(below).toMatchObject({ usedPercent: null, usageUnknown: true });
    expect(below?.resumeAt.toISOString()).toBe("2026-09-13T12:05:00.000Z");
    expect(below?.reason).toContain("last good read of 40% at 2026-09-13T11:52:00.000Z cannot clear the limit");
    expect(below?.reason).toContain("Anthropic OAuth usage: 429");

    // A fresh read below the limit clears the run as before.
    expect(
      decideSubscriptionWindowWait({
        policies: [policy()],
        result: ok([window({ key: "five_hour", usedPercent: 40 })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("stays open without a limit even when usage cannot be read", () => {
    expect(
      decideSubscriptionWindowWait({ policies: [policy({ amount: 0 })], result: null, provider: "anthropic", now: NOW }),
    ).toBeNull();
    expect(
      decideSubscriptionWindowWait({
        policies: [],
        result: { provider: "anthropic", ok: false, error: "down", windows: [] },
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("lets a known saturated window outrank an unknown one", () => {
    const wait = decideSubscriptionWindowWait({
      policies: [policy(), policy({ id: "policy-week", windowKind: "provider_week", amount: 90 })],
      result: ok([window({ key: "seven_day", usedPercent: 95, resetsAt: "2026-09-18T00:00:00.000Z" })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(wait?.policyId).toBe("policy-week");
    expect(wait?.usageUnknown).toBe(false);
    expect(wait?.resumeAt.toISOString()).toBe("2026-09-18T00:00:30.000Z");
  });

  it("ignores policies with a zero limit and matches windows by key, not label", () => {
    expect(
      decideSubscriptionWindowWait({
        policies: [policy({ amount: 0 })],
        result: ok([window({ key: "five_hour", usedPercent: 100 })]),
        provider: "anthropic",
        now: NOW,
      }),
    ).toBeNull();
    // A window without the session key is not the session window, however it
    // is labeled: the policy holds for a re-check rather than reading its 100%.
    const mislabeled = decideSubscriptionWindowWait({
      policies: [policy()],
      result: ok([window({ key: null, label: "Current session", usedPercent: 100 })]),
      provider: "anthropic",
      now: NOW,
    });
    expect(mislabeled).toMatchObject({ usageUnknown: true, usedPercent: null });
  });
});

describe("observeSubscriptionWindow", () => {
  it("reads the matching window from an ok provider result", () => {
    const result: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      windows: [window({ key: "seven_day", usedPercent: 42, resetsAt: "2026-09-18T00:00:00.000Z" })],
    };
    expect(observeSubscriptionWindow(result, "provider_week")).toEqual({
      usedPercent: 42,
      resetsAt: "2026-09-18T00:00:00.000Z",
      stale: false,
      observedAt: null,
    });
    expect(observeSubscriptionWindow(result, "provider_session")).toBeNull();
  });

  it("carries the snapshot's staleness and read time through", () => {
    const result: ProviderQuotaResult = {
      provider: "anthropic",
      ok: true,
      stale: true,
      observedAt: "2026-09-13T11:55:00.000Z",
      error: "Anthropic OAuth usage: 429",
      windows: [window({ key: "five_hour", usedPercent: 61 })],
    };
    expect(observeSubscriptionWindow(result, "provider_session")).toEqual({
      usedPercent: 61,
      resetsAt: null,
      stale: true,
      observedAt: "2026-09-13T11:55:00.000Z",
    });
  });

  it("returns null for a failed provider result", () => {
    expect(
      observeSubscriptionWindow({ provider: "anthropic", ok: false, error: "down", windows: [] }, "provider_week"),
    ).toBeNull();
  });
});

describe("boundSubscriptionWindowWait", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("keeps the reported resume time while the wait is inside the bound", () => {
    const waitStartedAt = new Date(NOW.getTime() - 3 * DAY_MS);
    const resumeAt = new Date(NOW.getTime() + 15 * 60 * 1000);
    const bound = boundSubscriptionWindowWait({ waitStartedAt, resumeAt, now: NOW, maxWaitMs: 8 * DAY_MS });
    expect(bound.exhausted).toBe(false);
    expect(bound.deadline.toISOString()).toBe(new Date(waitStartedAt.getTime() + 8 * DAY_MS).toISOString());
    expect(bound.resumeAt).toBe(resumeAt);
  });

  it("clamps a resume time past the deadline to the deadline", () => {
    const waitStartedAt = new Date(NOW.getTime() - 7 * DAY_MS);
    const bound = boundSubscriptionWindowWait({
      waitStartedAt,
      resumeAt: new Date("2099-01-01T00:00:00.000Z"),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(bound.exhausted).toBe(false);
    expect(bound.resumeAt.toISOString()).toBe(new Date(waitStartedAt.getTime() + 8 * DAY_MS).toISOString());
  });

  it("reports exhaustion once the wait has lasted the maximum, not after a number of deferrals", () => {
    const waitStartedAt = new Date(NOW.getTime() - 8 * DAY_MS);
    const bound = boundSubscriptionWindowWait({
      waitStartedAt,
      resumeAt: new Date(NOW.getTime() + 15 * 60 * 1000),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(bound.exhausted).toBe(true);

    // A weekly window re-checked every 15 minutes for six days is still a valid wait.
    const sixDays = boundSubscriptionWindowWait({
      waitStartedAt: new Date(NOW.getTime() - 6 * DAY_MS),
      resumeAt: new Date(NOW.getTime() + 15 * 60 * 1000),
      now: NOW,
      maxWaitMs: 8 * DAY_MS,
    });
    expect(sixDays.exhausted).toBe(false);
  });
});

describe("createQuotaSnapshotReader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares one fetch between concurrent callers and reuses it inside the ttl", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });

    const [first, second] = await Promise.all([read({ now: NOW }), read({ now: NOW })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    const within = await read({ now: new Date(NOW.getTime() + 59_000) });
    expect(within).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refetches once the ttl has elapsed", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000 });
    const first = await read({ now: NOW });
    const later = await read({ now: new Date(first.fetchedAt.getTime() + 1_001) });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(later).not.toBe(first);
  });

  it("fails open by returning a not-ok snapshot instead of throwing", async () => {
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => {
      throw new Error("usage endpoint unreachable");
    });
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });
    const snapshot = await read({ now: NOW });
    expect(snapshot.results).toEqual([
      expect.objectContaining({ ok: false, error: "Error: usage endpoint unreachable", windows: [] }),
    ]);
  });

  it("stamps every ok row with the time it was read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetch = vi.fn(async (): Promise<ProviderQuotaResult[]> => [
      { provider: "anthropic", ok: true, windows: [window({ key: "five_hour", usedPercent: 12 })] },
    ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000 });
    const snapshot = await read({ now: NOW });
    expect(snapshot.results[0]).toMatchObject({ ok: true, observedAt: NOW.toISOString() });
    expect(snapshot.results[0]?.stale).toBeUndefined();
  });

  it("keeps the last good read of a provider when its refresh fails, marked stale with the new error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const good: ProviderQuotaResult = {
      provider: "anthropic",
      source: "anthropic-oauth",
      ok: true,
      windows: [window({ key: "five_hour", usedPercent: 40, resetsAt: "2026-09-13T15:00:00.000Z" })],
    };
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([good, { provider: "openai", ok: true, windows: [] }])
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: false, error: "Claude CLI /usage: probe ended early", windows: [] },
        { provider: "openai", ok: true, windows: [] },
      ]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 60_000, maxStaleMs: 10 * 60_000 });

    const first = await read({ now: NOW });
    expect(first.results[0]).toMatchObject({ ok: true, observedAt: NOW.toISOString() });

    const later = new Date(NOW.getTime() + 61_000);
    vi.setSystemTime(later);
    const second = await read({ now: later });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(second.results[0]).toEqual({
      ...good,
      observedAt: NOW.toISOString(),
      stale: true,
      error: "Claude CLI /usage: probe ended early",
      errorFamily: null,
    });
    // The other provider refreshed fine and is not stale.
    expect(second.results[1]).toMatchObject({ provider: "openai", ok: true, observedAt: later.toISOString() });
    expect(second.results[1]?.stale).toBeUndefined();
  });

  it("reports a provider as unavailable once its last good read is older than the stale bound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const failure: ProviderQuotaResult = { provider: "anthropic", ok: false, error: "down", windows: [] };
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: true, windows: [window({ key: "five_hour", usedPercent: 40 })] },
      ])
      .mockResolvedValue([failure]);
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000, maxStaleMs: 5_000 });

    await read({ now: NOW });
    const withinBound = new Date(NOW.getTime() + 4_000);
    vi.setSystemTime(withinBound);
    expect((await read({ now: withinBound })).results[0]).toMatchObject({ ok: true, stale: true });

    const pastBound = new Date(NOW.getTime() + 6_000);
    vi.setSystemTime(pastBound);
    expect((await read({ now: pastBound })).results[0]).toEqual(failure);

    // Once forgotten, a further failure has nothing to fall back on either.
    const later = new Date(NOW.getTime() + 8_000);
    vi.setSystemTime(later);
    expect((await read({ now: later })).results[0]).toEqual(failure);
  });

  it("attributes a fetch that throws outright to every known provider so their last good read stands in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fetch = vi
      .fn<() => Promise<ProviderQuotaResult[]>>()
      .mockResolvedValueOnce([
        { provider: "anthropic", ok: true, windows: [window({ key: "seven_day", usedPercent: 70 })] },
      ])
      .mockRejectedValueOnce(new Error("registry exploded"));
    const read = createQuotaSnapshotReader({ fetch, ttlMs: 1_000, maxStaleMs: 60_000 });

    await read({ now: NOW });
    const later = new Date(NOW.getTime() + 2_000);
    vi.setSystemTime(later);
    const snapshot = await read({ now: later });
    expect(snapshot.results).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        ok: true,
        stale: true,
        error: "Error: registry exploded",
        windows: [window({ key: "seven_day", usedPercent: 70 })],
      }),
    ]);
  });
});
