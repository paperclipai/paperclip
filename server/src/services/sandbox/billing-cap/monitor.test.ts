import { describe, expect, it, vi } from "vitest";
import {
  BillingCapMonitor,
  CompositeCapNotifier,
  E2B_PILOT_THRESHOLDS,
  E2B_PROVIDER_KEY,
  InMemoryBillingCapStore,
  NoopCapNotifier,
  type CapNotification,
  type SourceA,
  type SourceASample,
  type SourceB,
  type SourceBSample,
} from "./index.js";

class StaticSourceA implements SourceA {
  constructor(private readonly fixture: SourceASample | null) {}
  async sample(): Promise<SourceASample | null> {
    return this.fixture;
  }
}

class ThrowingSourceA implements SourceA {
  async sample(): Promise<SourceASample | null> {
    throw new Error("vendor offline");
  }
}

class StaticSourceB implements SourceB {
  constructor(private fixture: SourceBSample) {}
  setFixture(fixture: SourceBSample) {
    this.fixture = fixture;
  }
  async sample(): Promise<SourceBSample> {
    return this.fixture;
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function captureNotifier() {
  const calls: CapNotification[] = [];
  return {
    calls,
    notifier: {
      async notify(notification: CapNotification) {
        calls.push(notification);
      },
    },
  };
}

const COMPANY = "company-test";
const NOW = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));

function newMonitor(opts: {
  sourceA?: SourceA | null;
  sourceB: SourceB;
  notifier?: ReturnType<typeof captureNotifier>;
  openMonthlyIncident?: (n: CapNotification) => Promise<string | null>;
} = { sourceB: new StaticSourceB({ dayCents: 0, monthCents: 0, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }) }) {
  const store = new InMemoryBillingCapStore();
  const log = silentLogger();
  const cap = opts.notifier ?? captureNotifier();
  const monitor = new BillingCapMonitor({
    store,
    sourceA: opts.sourceA ?? null,
    sourceB: opts.sourceB,
    notifier: cap.notifier,
    logger: log,
    openMonthlyIncident: opts.openMonthlyIncident,
  });
  return { monitor, store, log, capCalls: cap.calls };
}

describe("BillingCapMonitor — tick orchestration", () => {
  it("AC #3 daily soft cap: emits warning notification + soft event, does not flip provider", async () => {
    const { monitor, store, capCalls } = newMonitor({
      sourceB: new StaticSourceB({ dayCents: 16_00, monthCents: 16_00, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.capState).toBe("soft-cap-breached");
    expect(result.spend.dayCents).toBe(16_00);
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.providerEnableLayerEnabled).toBe(true);
    expect(state?.dayHardCapBreachedAt).toBeNull();
    expect(capCalls.some((c) => c.kind === "soft_cap_breached" && c.tone === "warning")).toBe(true);
    expect(capCalls.every((c) => c.kind !== "hard_cap_breached")).toBe(true);
  });

  it("AC #3 daily hard cap: atomically flips provider-enable, emits danger+interrupt notification", async () => {
    const { monitor, store, capCalls } = newMonitor({
      sourceB: new StaticSourceB({ dayCents: 20_00, monthCents: 20_00, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.capState).toBe("hard-cap-breached-auto-disabled");
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.providerEnableLayerEnabled).toBe(false);
    expect(state?.dayHardCapBreachedAt).toEqual(NOW);
    const hard = capCalls.find((c) => c.kind === "hard_cap_breached");
    expect(hard).toBeDefined();
    expect(hard?.tone).toBe("danger");
    expect(hard?.interrupt).toBe(true);
  });

  it("AC #3 monthly hard cap: flips provider-enable AND opens an incident issue via hook", async () => {
    const openIncident = vi.fn(async () => "incident-issue-99");
    const { monitor, store, capCalls } = newMonitor({
      sourceB: new StaticSourceB({ dayCents: 5_00, monthCents: 250_00, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
      openMonthlyIncident: openIncident,
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.capState).toBe("hard-cap-breached-auto-disabled");
    expect(openIncident).toHaveBeenCalledTimes(1);
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.monthHardCapBreachedAt).toEqual(NOW);
    expect(state?.providerEnableLayerEnabled).toBe(false);
    expect(capCalls.some((c) => c.kind === "monthly_incident_opened")).toBe(true);
    const incidentEvent = result.events.find((e) => e.kind === "monthly_incident_opened");
    expect(incidentEvent?.incidentIssueId).toBe("incident-issue-99");
  });

  it("AC #4 refuses to re-enable autonomously while a monthly hard-cap breach is on record", async () => {
    const { monitor, store, capCalls } = newMonitor({
      sourceB: new StaticSourceB({ dayCents: 0, monthCents: 0, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    // Manually establish a monthly hard-cap breach via the store.
    await store.flipProviderEnable({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: "auto-cap-monitor",
      reason: "month_hard_cap_breached",
      at: NOW,
      recordHardCapBreach: "month",
    });
    const result = await monitor.flipOperatorToggle({
      companyId: COMPANY,
      enable: true,
      reason: "operator trying to re-enable",
      actorLabel: "operator:test",
    });
    expect(result.event.kind).toBe("reenable_refused");
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.providerEnableLayerEnabled).toBe(false);
    expect(capCalls.some((c) => c.kind === "reenable_refused")).toBe(true);
  });

  it("AC #1 SourceA failure falls back to SourceB and continues without aborting the tick", async () => {
    const { monitor, capCalls } = newMonitor({
      sourceA: new ThrowingSourceA(),
      sourceB: new StaticSourceB({ dayCents: 15_50, monthCents: 15_50, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.source).toBe("internal-estimate");
    expect(result.spend.dayCents).toBe(15_50);
    expect(capCalls.some((c) => c.kind === "soft_cap_breached")).toBe(true);
  });

  it("AC #1 SourceA returning null marks status unavailable and uses internal estimate", async () => {
    const { monitor } = newMonitor({
      sourceA: new StaticSourceA(null),
      sourceB: new StaticSourceB({ dayCents: 100, monthCents: 200, dayRuntimeSeconds: 10, monthRuntimeSeconds: 20, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.source).toBe("internal-estimate");
  });

  it("AC #6 SourceA payload carrying a credential-shaped field is treated as parse-error → fallback", async () => {
    const { monitor } = newMonitor({
      sourceA: new StaticSourceA({
        dayCents: 18_00,
        monthCents: 18_00,
        rawRedacted: { e2bSandboxToken: "e2b_abcdefghijklmnopqrstu" } as Record<string, unknown>,
      }),
      sourceB: new StaticSourceB({ dayCents: 12_00, monthCents: 12_00, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(result.source).toBe("internal-estimate");
    expect(result.spend.dayCents).toBe(12_00);
  });

  it("idempotent: a second tick at the same hard-cap level does not re-notify", async () => {
    const sourceB = new StaticSourceB({ dayCents: 20_00, monthCents: 20_00, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 });
    const { monitor, capCalls } = newMonitor({ sourceB });
    await monitor.tick({ companyId: COMPANY, now: NOW });
    const beforeSecondTick = capCalls.length;
    await monitor.tick({ companyId: COMPANY, now: new Date(NOW.getTime() + 60_000) });
    expect(capCalls.length).toBe(beforeSecondTick);
  });

  it("operator-toggle off path emits operator_toggle_flipped event", async () => {
    const { monitor, store } = newMonitor({
      sourceB: new StaticSourceB({ dayCents: 0, monthCents: 0, dayRuntimeSeconds: 0, monthRuntimeSeconds: 0, ratePerSecondCents: 0.01 }),
    });
    const result = await monitor.flipOperatorToggle({
      companyId: COMPANY,
      enable: false,
      reason: "manual pause",
      actorLabel: "operator:test",
    });
    expect(result.event.kind).toBe("operator_toggle_flipped");
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.operatorToggleEnabled).toBe(false);
  });
});

describe("Cap notifier composition", () => {
  it("NoopCapNotifier swallows notifications without throwing", async () => {
    const noop = new NoopCapNotifier();
    await expect(
      noop.notify({
        companyId: COMPANY,
        provider: E2B_PROVIDER_KEY,
        kind: "soft_cap_breached",
        tone: "warning",
        title: "x",
        body: "y",
      }),
    ).resolves.toBeUndefined();
  });
  it("CompositeCapNotifier aggregates failures into a single thrown error", async () => {
    const failing = { async notify() { throw new Error("boom"); } };
    const composite = new CompositeCapNotifier([new NoopCapNotifier(), failing]);
    await expect(
      composite.notify({
        companyId: COMPANY,
        provider: E2B_PROVIDER_KEY,
        kind: "operator_toggle_flipped",
        tone: "info",
        title: "x",
        body: "y",
      }),
    ).rejects.toThrow(/Cap notifier composite failed/);
  });
});

describe("E2B pilot thresholds (S3 §3)", () => {
  it("matches the documented cap values", () => {
    expect(E2B_PILOT_THRESHOLDS).toEqual({
      daySoftCents: 15_00,
      dayHardCents: 20_00,
      monthSoftCents: 150_00,
      monthHardCents: 200_00,
    });
  });
});
