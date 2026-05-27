import { describe, expect, it, vi } from "vitest";

import type { ObservabilityStore } from "../services/observability-store.js";
import {
  createTierDigestScheduler,
  nextFireAt,
  tierDigestSchedulerConfigFromEnv,
} from "../services/tier-digest-scheduler.js";
import type { TierDigestWebhookDispatcher } from "../services/tier-digest-webhook.js";

function fakeStore(): ObservabilityStore {
  return {
    enabled: true,
    dbPath: ":memory:",
    recordInvocation: () => undefined,
    queryTierMix: () => [],
    queryTier1CostSince: () => 0,
    close: () => undefined,
  };
}

function fakeDispatcher(): TierDigestWebhookDispatcher & {
  calls: number;
} {
  let calls = 0;
  const d = {
    enabled: true,
    calls,
    dispatch: () => {
      calls += 1;
      d.calls = calls;
    },
    dispatchAndWait: async () => {
      calls += 1;
      d.calls = calls;
      return "sent" as const;
    },
  };
  return d;
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("nextFireAt", () => {
  it("picks today's slot if it is in the future", () => {
    // 2026-05-24 is EDT (UTC-4) — 08:15 ET = 12:15 UTC.
    const now = new Date("2026-05-24T05:00:00Z");
    const next = nextFireAt({
      now,
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
    });
    expect(next.toISOString()).toBe("2026-05-24T12:15:00.000Z");
  });

  it("rolls forward to tomorrow if today's slot already passed", () => {
    const now = new Date("2026-05-24T13:00:00Z"); // past 08:15 ET
    const next = nextFireAt({
      now,
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
    });
    expect(next.toISOString()).toBe("2026-05-25T12:15:00.000Z");
  });

  it("respects EST (winter) offset", () => {
    // 2026-01-15 is EST (UTC-5) — 08:15 ET = 13:15 UTC.
    const now = new Date("2026-01-15T00:00:00Z");
    const next = nextFireAt({
      now,
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
    });
    expect(next.toISOString()).toBe("2026-01-15T13:15:00.000Z");
  });

  it("handles UTC timezone as identity", () => {
    const now = new Date("2026-05-24T05:00:00Z");
    const next = nextFireAt({ now, hour: 8, minute: 15, timezone: "UTC" });
    expect(next.toISOString()).toBe("2026-05-24T08:15:00.000Z");
  });

  it("returns strictly future timestamps (never equal to now)", () => {
    // 2026-05-24T12:15:00Z IS the target instant. Calling at exactly that
    // moment must roll forward.
    const now = new Date("2026-05-24T12:15:00Z");
    const next = nextFireAt({
      now,
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
    });
    expect(next.getTime()).toBeGreaterThan(now.getTime());
    expect(next.toISOString()).toBe("2026-05-25T12:15:00.000Z");
  });
});

describe("createTierDigestScheduler", () => {
  it("computes delay from `now` to next fire and arms a timer", () => {
    const now = new Date("2026-05-24T05:00:00Z");
    const setT = vi.fn(((_cb: () => void, _ms: number) =>
      ({} as ReturnType<typeof setTimeout>)) as any);
    const clearT = vi.fn();
    const scheduler = createTierDigestScheduler({
      store: fakeStore(),
      dispatcher: fakeDispatcher(),
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
      now: () => now,
      setTimeoutImpl: setT as any,
      clearTimeoutImpl: clearT as any,
      log: silentLog(),
    });
    scheduler.start();
    expect(scheduler.running).toBe(true);
    expect(setT).toHaveBeenCalledTimes(1);
    const delayMs = setT.mock.calls[0]![1] as number;
    // 05:00 → 12:15 UTC = 7h15m = 26100000 ms
    expect(delayMs).toBe(26100000);
    expect(scheduler.nextDelayMs()).toBe(26100000);
  });

  it("start() is idempotent", () => {
    const setT = vi.fn(((_cb: () => void, _ms: number) =>
      ({} as ReturnType<typeof setTimeout>)) as any);
    const scheduler = createTierDigestScheduler({
      store: fakeStore(),
      dispatcher: fakeDispatcher(),
      now: () => new Date("2026-05-24T05:00:00Z"),
      setTimeoutImpl: setT as any,
      clearTimeoutImpl: () => undefined,
      log: silentLog(),
    });
    scheduler.start();
    scheduler.start();
    scheduler.start();
    expect(setT).toHaveBeenCalledTimes(1);
  });

  it("stop() clears the pending timer", () => {
    const handle = { id: "h" } as unknown as ReturnType<typeof setTimeout>;
    const setT = vi.fn(((_cb: () => void, _ms: number) => handle) as any);
    const clearT = vi.fn();
    const scheduler = createTierDigestScheduler({
      store: fakeStore(),
      dispatcher: fakeDispatcher(),
      now: () => new Date("2026-05-24T05:00:00Z"),
      setTimeoutImpl: setT as any,
      clearTimeoutImpl: clearT as any,
      log: silentLog(),
    });
    scheduler.start();
    scheduler.stop();
    expect(scheduler.running).toBe(false);
    expect(clearT).toHaveBeenCalledWith(handle);
    expect(scheduler.nextDelayMs()).toBe(null);
  });

  it("fireOnce() dispatches a digest synchronously", async () => {
    const dispatcher = fakeDispatcher();
    const scheduler = createTierDigestScheduler({
      store: fakeStore(),
      dispatcher,
      now: () => new Date("2026-05-24T13:15:00Z"),
      setTimeoutImpl: (() => ({} as ReturnType<typeof setTimeout>)) as any,
      clearTimeoutImpl: () => undefined,
      log: silentLog(),
    });
    const digest = await scheduler.fireOnce();
    expect(digest.totalInvocations).toBe(0);
    expect(dispatcher.calls).toBe(1);
  });

  it("re-arms after firing (timer callback path)", async () => {
    let savedCb: (() => void) | null = null;
    const setT = vi.fn(((cb: () => void, _ms: number) => {
      savedCb = cb;
      return {} as ReturnType<typeof setTimeout>;
    }) as any);
    const dispatcher = fakeDispatcher();
    const scheduler = createTierDigestScheduler({
      store: fakeStore(),
      dispatcher,
      now: () => new Date("2026-05-24T05:00:00Z"),
      setTimeoutImpl: setT as any,
      clearTimeoutImpl: () => undefined,
      log: silentLog(),
    });
    scheduler.start();
    expect(setT).toHaveBeenCalledTimes(1);
    expect(savedCb).not.toBeNull();
    savedCb!();
    // Allow the async fireOnce() chain to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatcher.calls).toBe(1);
    // A second timer should have been armed.
    expect(setT).toHaveBeenCalledTimes(2);
  });
});

describe("tierDigestSchedulerConfigFromEnv", () => {
  it("returns defaults when env empty", () => {
    expect(tierDigestSchedulerConfigFromEnv({} as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      hour: 8,
      minute: 15,
      timezone: "America/New_York",
    });
  });

  it("respects PAPERCLIP_TIER_DIGEST_SCHEDULER_ENABLED=false", () => {
    expect(
      tierDigestSchedulerConfigFromEnv({
        PAPERCLIP_TIER_DIGEST_SCHEDULER_ENABLED: "false",
      } as NodeJS.ProcessEnv).enabled,
    ).toBe(false);
  });

  it("parses hour/minute/timezone overrides", () => {
    expect(
      tierDigestSchedulerConfigFromEnv({
        PAPERCLIP_TIER_DIGEST_SCHEDULE_HOUR: "9",
        PAPERCLIP_TIER_DIGEST_SCHEDULE_MINUTE: "30",
        PAPERCLIP_TIER_DIGEST_TIMEZONE: "America/Los_Angeles",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      enabled: true,
      hour: 9,
      minute: 30,
      timezone: "America/Los_Angeles",
    });
  });
});
