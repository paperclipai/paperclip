/**
 * LET-391 Phase 4A-S4 integration test.
 *
 * Proves the end-to-end fail-closed contract:
 *
 *   LET-367 cap monitor flips `sandbox_billing_cap_state.providerEnableLayerEnabled`
 *     → persisted via `BillingCapStore`
 *       → read by `createE2BBillingCapLayerResolver`
 *         → consumed by `E2BSandboxProvider`'s `resolveBillingCapLayers` gate
 *           → `acquireLease` throws PROVIDER_DISABLED (reason="billing-cap-monitor")
 *
 * The integration test deliberately wires the REAL `BillingCapMonitor` against
 * an in-memory store (no Postgres dependency) and the REAL provider gate, so a
 * regression in any single hop fails the test. The three-gate LET-366 path is
 * pre-passed (env+layer1+secret) so the only remaining gate that can block is
 * the LET-391 layer-1 read-side enforcement — exactly what the issue asks for.
 *
 * Also covers operator-toggle blocking and resolver-error fail-closed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTO_CAP_MONITOR_ACTOR,
  BillingCapMonitor,
  E2B_PILOT_THRESHOLDS,
  E2B_PROVIDER_KEY,
  InMemoryBillingCapStore,
  NoopCapNotifier,
  billingCapStateRowToLayerSnapshot,
  createE2BBillingCapLayerResolver,
  type SourceA,
  type SourceB,
  type SourceBSample,
} from "./index.js";
import {
  E2B_SANDBOX_PROVIDER_KEY,
  E2BSandboxProvider,
  MANAGED_SANDBOX_LIVE_ENV,
  type ManagedSandboxProviderConfig,
} from "../managed-provider-spikes.js";

const COMPANY = "company-let391-pilot";
const ISSUE = "issue-let391-acquire";
const RUN = "run-let391-acquire";
const ENV = "env-let391-acquire";

const originalLiveFlag = process.env.SANDBOX_PROVIDER_ALLOW_LIVE;

function restoreLiveFlag(): void {
  if (originalLiveFlag === undefined) {
    delete process.env.SANDBOX_PROVIDER_ALLOW_LIVE;
  } else {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = originalLiveFlag;
  }
}

const e2bLiveConfig: ManagedSandboxProviderConfig = {
  provider: E2B_SANDBOX_PROVIDER_KEY,
  image: "e2b/code-interpreter:latest",
  template: "base",
  reuseLease: false,
  timeoutMs: 45_000,
  network: { egress: "deny" },
};

class StaticSourceB implements SourceB {
  constructor(private fixture: SourceBSample) {}
  setFixture(fixture: SourceBSample): void {
    this.fixture = fixture;
  }
  async sample(): Promise<SourceBSample> {
    return this.fixture;
  }
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function buildProvider(input: {
  store: InMemoryBillingCapStore;
  liveTransportFactory: ReturnType<typeof vi.fn>;
  resolveCompanyId?: () => Promise<string | null>;
  resolveApiKey?: () => Promise<string | null>;
}) {
  const resolver = createE2BBillingCapLayerResolver({
    store: input.store,
    resolveCompanyId: input.resolveCompanyId ?? (async () => COMPANY),
  });
  return new E2BSandboxProvider({
    isProviderEnabled: () => true,
    resolveApiKey: input.resolveApiKey ?? (async () => "resolved-canary-do-not-leak"),
    resolveBillingCapLayers: resolver,
    fetchImpl: globalThis.fetch.bind(globalThis),
    liveTransportFactory: input.liveTransportFactory,
  });
}

function leaseInput() {
  return {
    config: e2bLiveConfig,
    environmentId: ENV,
    heartbeatRunId: RUN,
    issueId: ISSUE,
  };
}

describe("LET-391 E2B live provider × billing-cap state integration", () => {
  beforeEach(() => {
    process.env.SANDBOX_PROVIDER_ALLOW_LIVE = "true";
  });
  afterEach(() => {
    restoreLiveFlag();
    vi.restoreAllMocks();
  });

  it("projects null state row to a null snapshot (allow when no row exists yet)", () => {
    expect(billingCapStateRowToLayerSnapshot(null)).toBeNull();
  });

  it("allows the first live lease before any monitor tick has written a state row", async () => {
    const store = new InMemoryBillingCapStore();
    const liveTransportFactory = vi.fn(() => ({
      mode: "live-http" as const,
      createSandbox: vi.fn(async () => ({ id: "sbx-1", provider: "e2b" as const, state: "created" as const, metadata: {} })),
      startSandbox: vi.fn(),
      executeCommand: vi.fn(),
      readLogs: vi.fn(),
      streamEvents: vi.fn(),
      releaseSandbox: vi.fn(),
      destroySandbox: vi.fn(),
    }));
    const provider = buildProvider({ store, liveTransportFactory });
    const lease = await provider.acquireLease(leaseInput());
    expect(lease.providerLeaseId).toBe("sandbox://e2b/sbx-1");
    expect(liveTransportFactory).toHaveBeenCalledTimes(1);
  });

  it("blocks live lease with reason='billing-cap-monitor' AFTER the cap monitor auto-disables on a hard-cap breach", async () => {
    const store = new InMemoryBillingCapStore();
    // Burn the daily budget through the REAL monitor → REAL store path to
    // mirror what happens in production when spend crosses the day hard cap.
    const sourceB = new StaticSourceB({
      dayCents: E2B_PILOT_THRESHOLDS.dayHardCents + 10,
      monthCents: E2B_PILOT_THRESHOLDS.dayHardCents + 10,
      dayRuntimeSeconds: 1,
      monthRuntimeSeconds: 1,
      ratePerSecondCents: 0.01,
    });
    const monitor = new BillingCapMonitor({
      store,
      sourceA: null,
      sourceB,
      notifier: new NoopCapNotifier(),
      logger: silentLogger(),
    });
    const tick = await monitor.tick({ companyId: COMPANY, now: new Date("2026-05-18T00:00:00Z") });
    expect(tick.capState).toBe("hard-cap-breached-auto-disabled");
    const persisted = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(persisted?.providerEnableLayerEnabled).toBe(false);
    expect(persisted?.dayHardCapBreachedAt).toBeInstanceOf(Date);

    // Now a concurrent live acquireLease must fail closed BEFORE any HTTP
    // egress and BEFORE the live transport is constructed.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn(async () => "resolved-canary-do-not-leak");
    const provider = buildProvider({ store, liveTransportFactory, resolveApiKey });
    await expect(provider.acquireLease(leaseInput())).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({
        provider: E2B_SANDBOX_PROVIDER_KEY,
        liveEnv: MANAGED_SANDBOX_LIVE_ENV,
        gate: "billing_cap_layers",
        reason: "billing-cap-monitor",
        providerEnableLayerEnabled: false,
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("blocks live lease with reason='operator-toggle' when an operator pauses live acquisitions", async () => {
    const store = new InMemoryBillingCapStore();
    await store.flipOperatorToggle({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: "operator-test",
      reason: "kill_switch_paused_for_audit",
      at: new Date("2026-05-18T00:00:00Z"),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn(async () => "resolved-canary-do-not-leak");
    const provider = buildProvider({ store, liveTransportFactory, resolveApiKey });
    await expect(provider.acquireLease(leaseInput())).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({
        gate: "billing_cap_layers",
        reason: "operator-toggle",
        operatorToggleEnabled: false,
        operatorToggleReason: "kill_switch_paused_for_audit",
      }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("returns the cap-monitor-reason in the error body when one was persisted with the flip", async () => {
    const store = new InMemoryBillingCapStore();
    await store.flipProviderEnable({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: AUTO_CAP_MONITOR_ACTOR,
      reason: "month_hard_cap_breached",
      at: new Date("2026-05-18T00:00:00Z"),
      recordHardCapBreach: "month",
    });
    const liveTransportFactory = vi.fn();
    const provider = buildProvider({ store, liveTransportFactory });
    await expect(provider.acquireLease(leaseInput())).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      message: "month_hard_cap_breached",
      details: expect.objectContaining({
        reason: "billing-cap-monitor",
        providerEnableReason: "month_hard_cap_breached",
      }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
  });

  it("treats a thrown resolver as fail-closed: PROVIDER_DISABLED with reason='billing-cap-monitor'", async () => {
    const liveTransportFactory = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => "resolved-canary-do-not-leak",
      resolveBillingCapLayers: async () => {
        throw new Error("billing-cap store unreachable");
      },
      fetchImpl: globalThis.fetch.bind(globalThis),
      liveTransportFactory,
    });
    await expect(provider.acquireLease(leaseInput())).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({
        gate: "billing_cap_layers",
        reason: "billing-cap-monitor",
        resolverError: "billing-cap store unreachable",
      }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
  });

  it("allows live lease after the cap row exists but both layers remain enabled", async () => {
    const store = new InMemoryBillingCapStore();
    // Establish a row with both layers enabled (e.g. the very first counter
    // tick before any breach).
    await store.upsertCounters({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      now: new Date("2026-05-18T00:00:00Z"),
      source: "internal-estimate",
      daySpentCents: 0,
      monthSpentCents: 0,
    });
    const persisted = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(persisted?.providerEnableLayerEnabled).toBe(true);
    expect(persisted?.operatorToggleEnabled).toBe(true);

    const liveTransportFactory = vi.fn(() => ({
      mode: "live-http" as const,
      createSandbox: vi.fn(async () => ({ id: "sbx-ok", provider: "e2b" as const, state: "created" as const, metadata: {} })),
      startSandbox: vi.fn(),
      executeCommand: vi.fn(),
      readLogs: vi.fn(),
      streamEvents: vi.fn(),
      releaseSandbox: vi.fn(),
      destroySandbox: vi.fn(),
    }));
    const provider = buildProvider({ store, liveTransportFactory });
    const lease = await provider.acquireLease(leaseInput());
    expect(lease.providerLeaseId).toBe("sandbox://e2b/sbx-ok");
    expect(liveTransportFactory).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates the layer gate on every acquireLease (cap flip takes effect immediately, not just at transport init)", async () => {
    const store = new InMemoryBillingCapStore();
    const liveTransportFactory = vi.fn(() => ({
      mode: "live-http" as const,
      createSandbox: vi.fn(async () => ({ id: "sbx-first", provider: "e2b" as const, state: "created" as const, metadata: {} })),
      startSandbox: vi.fn(),
      executeCommand: vi.fn(),
      readLogs: vi.fn(),
      streamEvents: vi.fn(),
      releaseSandbox: vi.fn(),
      destroySandbox: vi.fn(),
    }));
    const provider = buildProvider({ store, liveTransportFactory });

    // First acquireLease succeeds (no row → null snapshot → allow).
    await expect(provider.acquireLease(leaseInput())).resolves.toMatchObject({
      providerLeaseId: "sandbox://e2b/sbx-first",
    });
    expect(liveTransportFactory).toHaveBeenCalledTimes(1);

    // Cap monitor flips the layer mid-flight.
    await store.flipProviderEnable({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: AUTO_CAP_MONITOR_ACTOR,
      reason: "day_hard_cap_breached",
      at: new Date("2026-05-18T01:00:00Z"),
      recordHardCapBreach: "day",
    });

    // Second acquireLease MUST fail closed even though the live transport is
    // already initialised — this is the regression the integration prevents.
    await expect(provider.acquireLease(leaseInput())).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ reason: "billing-cap-monitor" }),
    });
    expect(liveTransportFactory).toHaveBeenCalledTimes(1);
  });

  it("a null companyId resolver returns null snapshot → allow (matches pre-pilot bootstrap)", async () => {
    const store = new InMemoryBillingCapStore();
    // Persist a HARD-cap-breached row for COMPANY — the resolver must not see
    // it because resolveCompanyId returns null, so the lease is allowed.
    await store.flipProviderEnable({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: AUTO_CAP_MONITOR_ACTOR,
      reason: "day_hard_cap_breached",
      at: new Date("2026-05-18T00:00:00Z"),
      recordHardCapBreach: "day",
    });
    const liveTransportFactory = vi.fn(() => ({
      mode: "live-http" as const,
      createSandbox: vi.fn(async () => ({ id: "sbx-anon", provider: "e2b" as const, state: "created" as const, metadata: {} })),
      startSandbox: vi.fn(),
      executeCommand: vi.fn(),
      readLogs: vi.fn(),
      streamEvents: vi.fn(),
      releaseSandbox: vi.fn(),
      destroySandbox: vi.fn(),
    }));
    const provider = buildProvider({
      store,
      liveTransportFactory,
      resolveCompanyId: async () => null,
    });
    const lease = await provider.acquireLease(leaseInput());
    expect(lease.providerLeaseId).toBe("sandbox://e2b/sbx-anon");
  });
});
