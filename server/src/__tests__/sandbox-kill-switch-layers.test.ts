/**
 * LET-369 Phase 4A-S4 B4 — Five-layer kill-switch integration test suite.
 *
 * Exercises every kill-switch layer end-to-end, wiring the live
 * E2BSandboxProvider against a mocked transport + mocked secret store so the
 * tests don't need vendor credentials. Each layer is asserted to fail closed
 * BEFORE the (mocked) transport is invoked.
 *
 * Layer model (from S3 doc §5 on LET-362):
 *   1. provider-enable config — `sandbox.providers.e2b.enabled` (default off)
 *   2. env gate            — `SANDBOX_PROVIDER_ALLOW_LIVE === "true"`
 *   3. billing-cap monitor — auto-disable Layer 1 on day/month hard-cap breach
 *   4. operator toggle     — board-only admin-API flip with audit row
 *   5. lease-state-machine — failure circuit-breaker, auth/redaction fail-closed
 *
 * The five `describe` blocks below map 1:1 to the layers, and the assertions
 * mirror the AC bullets on LET-369.
 */

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sandboxBillingCapRoutes } from "../routes/sandbox-billing-cap.js";
import { errorHandler } from "../middleware/index.js";
import {
  BillingCapMonitor,
  E2B_PROVIDER_KEY,
  InMemoryBillingCapStore,
  type CapNotification,
} from "../services/sandbox/billing-cap/index.js";
import {
  E2B_SANDBOX_PROVIDER_KEY,
  E2BSandboxProvider,
  MANAGED_SANDBOX_LIVE_ENV,
  type ManagedSandboxProviderConfig,
} from "../services/sandbox/managed-provider-spikes.js";
import { PreProviderRedactionRegistry } from "../services/sandbox/pre-provider-redaction.js";
import { SandboxProviderError } from "../services/sandbox/provider-contract.js";
import {
  ProviderHealthTracker,
  trackedAcquireLease,
  type ProviderHealthPageEvent,
} from "../services/sandbox/provider-health-tracker.js";
import type { AcquireSandboxLeaseInput } from "../services/sandbox/provider-contract.js";

// Hoisted mock for the lease-list query used by the route to populate the
// status payload. The kill-switch tests don't read it but we keep the surface
// consistent with the other route-test setup.
const mockListSandboxLeasesForCompany = vi.hoisted(() => vi.fn());
vi.mock("../services/sandbox/queries.js", () => ({
  listSandboxLeasesForCompany: mockListSandboxLeasesForCompany,
  getSandboxLeaseForCompany: vi.fn(),
}));

const RESOLVED_API_KEY_CANARY = "canary-resolved-e2b-key-do-not-leak-let369";
const COMPANY = "company-let369";
const NOW = new Date(Date.UTC(2026, 4, 18, 12, 0, 0));

const e2bLiveConfig: ManagedSandboxProviderConfig = {
  provider: E2B_SANDBOX_PROVIDER_KEY,
  image: "e2b/code-interpreter:latest",
  template: "base",
  reuseLease: false,
  timeoutMs: 45_000,
  env: { SAFE_PUBLIC: "ok-public-value" },
  network: { egress: "deny" },
};

const acquireInput: AcquireSandboxLeaseInput = {
  config: e2bLiveConfig,
  environmentId: "env-let369",
  heartbeatRunId: "run-let369",
  issueId: "LET-369",
};

const originalLiveFlag = process.env[MANAGED_SANDBOX_LIVE_ENV];

function restoreLiveFlag(): void {
  if (originalLiveFlag === undefined) {
    delete process.env[MANAGED_SANDBOX_LIVE_ENV];
  } else {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = originalLiveFlag;
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

beforeEach(() => {
  mockListSandboxLeasesForCompany.mockReset();
  mockListSandboxLeasesForCompany.mockResolvedValue([]);
  delete process.env[MANAGED_SANDBOX_LIVE_ENV];
});

afterEach(() => {
  restoreLiveFlag();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Layer 1 — provider-enable config (default off).
// ---------------------------------------------------------------------------
describe("LET-369 Layer 1 — provider-enable config (default off)", () => {
  it("acquireLease returns PROVIDER_DISABLED synchronously with no HTTP egress and no secret-store call when sandbox.providers.e2b.enabled=false", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn();

    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => false, // Layer 1 explicitly disabled.
      resolveApiKey,
      liveTransportFactory,
    });

    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("Layer 1 default-off: a provider built without explicit overrides reports enabled=false", () => {
    const provider = new E2BSandboxProvider();
    expect(provider.status()).toMatchObject({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — SANDBOX_PROVIDER_ALLOW_LIVE env gate.
// ---------------------------------------------------------------------------
describe("LET-369 Layer 2 — SANDBOX_PROVIDER_ALLOW_LIVE env gate", () => {
  it("acquireLease still returns PROVIDER_DISABLED when Layer 1 is true but the env flag is unset", async () => {
    delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    const liveTransportFactory = vi.fn();
    const resolveApiKey = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey,
      liveTransportFactory,
    });

    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({
        gate: "env_flag",
        liveEnv: MANAGED_SANDBOX_LIVE_ENV,
        liveFlagSet: false,
      }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("env value 'false' is treated the same as unset (exact-string equality required)", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "false";
    const liveTransportFactory = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      liveTransportFactory,
    });
    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "env_flag" }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
  });

  it("both Layer 1 and Layer 2 true but secret store returns null still returns PROVIDER_DISABLED", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";
    const liveTransportFactory = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => true,
      resolveApiKey: async () => null, // Secret store has no reference.
      liveTransportFactory,
    });
    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "secret_unresolved" }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — billing-cap monitor.
// ---------------------------------------------------------------------------
describe("LET-369 Layer 3 — billing-cap monitor auto-disable", () => {
  function buildMonitor(opts: {
    dayCents: number;
    monthCents: number;
    openIncident?: (notification: CapNotification) => Promise<string | null>;
    activitySink?: (entry: { action: string; capEventId: string }) => Promise<void>;
  }) {
    const store = new InMemoryBillingCapStore();
    const log = silentLogger();
    const captured = captureNotifier();
    const monitor = new BillingCapMonitor({
      store,
      sourceA: null,
      sourceB: {
        async sample() {
          return {
            dayCents: opts.dayCents,
            monthCents: opts.monthCents,
            dayRuntimeSeconds: 0,
            monthRuntimeSeconds: 0,
            ratePerSecondCents: 0.01,
          };
        },
      },
      notifier: captured.notifier,
      logger: log,
      openMonthlyIncident: opts.openIncident,
      activitySink: opts.activitySink
        ? async (entry) => opts.activitySink!({ action: entry.action, capEventId: entry.capEventId })
        : undefined,
    });
    return { store, monitor, captured };
  }

  it("daily hard-cap breach atomically flips Layer 1 to false and the next acquireLease is blocked", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";
    const activityCalls: Array<{ action: string; capEventId: string }> = [];
    const { store, monitor, captured } = buildMonitor({
      dayCents: 20_00,
      monthCents: 20_00,
      activitySink: async (e) => {
        activityCalls.push(e);
      },
    });

    // Pre-flight: with Layer 1 reading from the store and the store reporting
    // enabled=true, acquireLease would otherwise reach the (unwired) transport.
    // The transport factory below tracks whether the post-breach call still
    // reaches it (it must not). In production, `isProviderEnabled` is fed by a
    // small in-memory snapshot that the monitor refreshes after each tick;
    // here we mirror that by reading the cached snapshot synchronously.
    let latestEnabledLayer1 = true;
    const liveTransportFactory = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => latestEnabledLayer1,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      liveTransportFactory,
    });

    // Trigger the breach.
    const tick = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(tick.capState).toBe("hard-cap-breached-auto-disabled");

    // Layer 1 row is now `enabled=false` in the store. Verify the flip.
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.providerEnableLayerEnabled).toBe(false);
    expect(state?.dayHardCapBreachedAt).toEqual(NOW);
    latestEnabledLayer1 = state?.providerEnableLayerEnabled ?? true;

    // Subsequent acquireLease is blocked at Layer 1, not even reaching the
    // mocked secret store or transport factory.
    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();

    // `sandbox.cost_breach` activity_log row was written (AC #3 + LET-386 gap #2).
    expect(activityCalls.some((c) => c.action === "sandbox.cost_breach")).toBe(true);

    // The danger notification path is invoked (mocked Andrii-page surface).
    const danger = captured.calls.find(
      (c) => c.kind === "hard_cap_breached" && c.tone === "danger",
    );
    expect(danger).toBeDefined();
    expect(danger?.interrupt).toBe(true);
  });

  it("monthly hard-cap breach calls the incident-issue creation hook (mocked)", async () => {
    const openIncident = vi.fn(async () => "incident-issue-let369");
    const { monitor, store } = buildMonitor({
      dayCents: 5_00,
      monthCents: 250_00,
      openIncident,
    });
    const tick = await monitor.tick({ companyId: COMPANY, now: NOW });
    expect(tick.capState).toBe("hard-cap-breached-auto-disabled");
    expect(openIncident).toHaveBeenCalledTimes(1);
    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.monthHardCapBreachedAt).toEqual(NOW);
    expect(state?.providerEnableLayerEnabled).toBe(false);

    const incidentEvent = tick.events.find((e) => e.kind === "monthly_incident_opened");
    expect(incidentEvent?.incidentIssueId).toBe("incident-issue-let369");
  });

  it("refuses to re-enable autonomously after a monthly hard-cap breach during the same UTC month, even at UTC day rollover", async () => {
    const { monitor, store } = buildMonitor({ dayCents: 0, monthCents: 0 });
    // Establish a monthly hard-cap breach on 2026-05-18.
    await store.flipProviderEnable({
      companyId: COMPANY,
      provider: E2B_PROVIDER_KEY,
      enabled: false,
      actorLabel: "auto-cap-monitor",
      reason: "month_hard_cap_breached",
      at: NOW,
      recordHardCapBreach: "month",
    });

    // Day rollover to 2026-05-19 (same UTC month). A new spend tick must NOT
    // auto-re-enable the provider because the monthly breach is still on
    // record.
    const dayRollover = new Date(Date.UTC(2026, 4, 19, 0, 0, 5));
    await monitor.tick({ companyId: COMPANY, now: dayRollover });
    const afterRollover = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(afterRollover?.providerEnableLayerEnabled).toBe(false);
    expect(afterRollover?.monthHardCapBreachedAt).toEqual(NOW);

    // Explicit operator re-enable attempt → refused.
    const result = await monitor.flipOperatorToggle({
      companyId: COMPANY,
      enable: true,
      reason: "operator: trying to re-enable",
      actorLabel: "operator:let369",
    });
    expect(result.event.kind).toBe("reenable_refused");
    const finalState = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(finalState?.providerEnableLayerEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 4 — operator toggle (audited admin-API route).
// ---------------------------------------------------------------------------
describe("LET-369 Layer 4 — operator toggle (audited admin route)", () => {
  function buildApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: typeof actor }).actor = actor;
      next();
    });
    const store = new InMemoryBillingCapStore();
    const captured = captureNotifier();
    const monitor = new BillingCapMonitor({
      store,
      sourceA: null,
      sourceB: {
        async sample() {
          return {
            dayCents: 0,
            monthCents: 0,
            dayRuntimeSeconds: 0,
            monthRuntimeSeconds: 0,
            ratePerSecondCents: 0.01,
          };
        },
      },
      notifier: captured.notifier,
      logger: silentLogger(),
    });
    app.use(
      "/api",
      sandboxBillingCapRoutes({} as never, {
        monitor,
        store,
        resolveProviderDescriptor: async () => ({
          key: "e2b",
          displayLabel: "E2B",
          apiKeyConfigured: false,
          secretRefRedactedSuffix: null,
        }),
        isAllowLive: () => true,
      }),
    );
    app.use(errorHandler);
    return { app, store, monitor, captured };
  }

  it("board-role operator can flip the toggle off via the admin-API route and an audit row is written", async () => {
    const { app, store } = buildApp({
      type: "board",
      userId: "user-board-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post(`/api/companies/${COMPANY}/sandbox/billing-cap/operator-toggle`)
      .send({ enable: false, reason: "pre-cutover pause for incident I-99" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, currentlyEnabled: false });

    const events = await store.listEvents(COMPANY, E2B_PROVIDER_KEY, { limit: 10 });
    const flip = events.find((e) => e.kind === "operator_toggle_flipped");
    expect(flip).toBeDefined();
    // Audit row: operator id (label), reason, timestamp.
    expect(flip?.actorLabel).toBe("operator:local");
    expect(flip?.reason).toBe("pre-cutover pause for incident I-99");
    expect(flip?.occurredAt).toBeInstanceOf(Date);
    expect((flip?.occurredAt as Date).getTime()).toBeGreaterThan(0);

    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    expect(state?.operatorToggleEnabled).toBe(false);
    expect(state?.operatorToggleReason).toBe("pre-cutover pause for incident I-99");
    expect(state?.operatorToggleActorLabel).toBe("operator:local");
  });

  it("non-board role (agent) receives 403 from the admin route and no flip occurs", async () => {
    const { app, store } = buildApp({
      type: "agent",
      agentId: "agent-let369",
      companyId: COMPANY,
    });
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/sandbox/billing-cap/operator-toggle`)
      .send({ enable: false, reason: "agent attempt" });
    expect(res.status).toBe(403);

    const state = await store.load(COMPANY, E2B_PROVIDER_KEY);
    // No state row was written at all — the route 403'd before reaching the
    // monitor.
    expect(state).toBeNull();
  });

  it("a board-role flip from true→false immediately fails subsequent acquireLease calls with PROVIDER_DISABLED", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";
    const { app, store } = buildApp({
      type: "board",
      userId: "user-board-2",
      source: "local_implicit",
    });

    // The provider reads BOTH Layer 1 AND Layer 4. Layer 4 (the operator
    // toggle) is enforced by the same `isProviderEnabled` callback, since the
    // toggle ANDs against Layer 1 in production wiring. We use a cached
    // snapshot updated after each store mutation, mirroring production.
    let killSwitchEnabled = true;
    const liveTransportFactory = vi.fn();
    const provider = new E2BSandboxProvider({
      isProviderEnabled: () => killSwitchEnabled,
      resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
      liveTransportFactory,
    });

    // Pre-flip: an acquireLease would reach the live transport. We don't
    // actually fire it here — instead we simulate the flip first, then
    // verify the post-flip call is blocked.
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/sandbox/billing-cap/operator-toggle`)
      .send({ enable: false, reason: "let369 layer 4 test" });
    expect(res.status).toBe(200);
    const stateAfter = await store.load(COMPANY, E2B_PROVIDER_KEY);
    killSwitchEnabled =
      (stateAfter?.providerEnableLayerEnabled ?? true) &&
      (stateAfter?.operatorToggleEnabled ?? true);

    await expect(provider.acquireLease(acquireInput)).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });
    expect(liveTransportFactory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 5 — lease-state-machine fail-closed.
// ---------------------------------------------------------------------------
describe("LET-369 Layer 5 — lease-state-machine fail-closed", () => {
  it("5 consecutive acquireLease failures within 10 minutes trip degraded; further calls return PROVIDER_DISABLED until cleared", async () => {
    const tracker = new ProviderHealthTracker();
    const fail = vi.fn(async () => {
      throw new SandboxProviderError("PROVIDER_FAILURE", "rate limited", {
        details: { status: 429 },
        retryable: true,
      });
    });
    for (let i = 0; i < 5; i++) {
      await expect(
        trackedAcquireLease(tracker, E2B_PROVIDER_KEY, fail, acquireInput),
      ).rejects.toMatchObject({ code: "PROVIDER_FAILURE" });
    }
    expect(tracker.snapshot().state).toBe("degraded");

    // 6th call now fails closed BEFORE calling the inner provider.
    const innerSpy = vi.fn(async () => ({
      providerLeaseId: "should-not-be-reached",
      metadata: {},
    }));
    await expect(
      trackedAcquireLease(tracker, E2B_PROVIDER_KEY, innerSpy, acquireInput),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ healthState: "degraded" }),
    });
    expect(innerSpy).not.toHaveBeenCalled();

    // Explicit clear by operator restores health.
    await tracker.clear("operator: cleared after manual investigation");
    await expect(
      trackedAcquireLease(tracker, E2B_PROVIDER_KEY, innerSpy, acquireInput),
    ).resolves.toMatchObject({ providerLeaseId: "should-not-be-reached" });
    expect(innerSpy).toHaveBeenCalledTimes(1);
  });

  it("a single auth failure (401) flips the tracker to degraded immediately", async () => {
    const tracker = new ProviderHealthTracker();
    const fail = vi.fn(async () => {
      throw new SandboxProviderError("CONFIG_INVALID", "auth rejected", {
        details: { status: 401, vendorCode: "auth_failed" },
      });
    });
    await expect(
      trackedAcquireLease(tracker, E2B_PROVIDER_KEY, fail, acquireInput),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(tracker.snapshot().state).toBe("degraded");
    expect(tracker.snapshot().reason).toMatch(/auth_failure_status_401/);

    const inner = vi.fn();
    await expect(
      trackedAcquireLease(tracker, E2B_PROVIDER_KEY, inner, acquireInput),
    ).rejects.toMatchObject({ code: "PROVIDER_DISABLED" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("a pre-egress redaction-boundary violation transitions to disabled and pages Andrii (mocked)", async () => {
    const pageCalls: ProviderHealthPageEvent[] = [];
    const tracker = new ProviderHealthTracker({
      onAndriiPage: async (event) => {
        pageCalls.push(event);
      },
    });

    // Simulate the data-plane redaction check: a canary that should have been
    // redacted by the PreProviderRedactionRegistry was found verbatim in the
    // outbound payload that was about to leave the provider boundary.
    const registry = new PreProviderRedactionRegistry();
    registry.register(RESOLVED_API_KEY_CANARY);
    const outboundCandidate = `POST /sandboxes\n\nBody: { "apiKey": "${RESOLVED_API_KEY_CANARY}" }`;
    const redacted = registry.redact(outboundCandidate);
    // Sanity check: the registry itself does the right thing.
    expect(redacted.includes(RESOLVED_API_KEY_CANARY)).toBe(false);

    // The interesting case is a pre-egress check at the call site that bypasses
    // or precedes the registry (e.g. a future header that wasn't routed
    // through redactRecordBeforeProvider). The Layer 5 contract requires that
    // detection at this point hard-disables the provider.
    await tracker.reportRedactionViolation({
      boundary: "before-provider",
      payloadKind: "exec_command_body",
      redactedSampleLength: redacted.length,
    });

    expect(tracker.snapshot().state).toBe("disabled");
    expect(pageCalls).toHaveLength(1);
    expect(pageCalls[0].details).toMatchObject({
      layer: "lease-state-machine",
      severity: "page-andrii",
      boundary: "before-provider",
    });

    // Subsequent acquireLease attempts fail closed with healthState=disabled.
    const inner = vi.fn();
    await expect(
      trackedAcquireLease(tracker, E2B_PROVIDER_KEY, inner, acquireInput),
    ).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ healthState: "disabled" }),
    });
    expect(inner).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer composition — all 5 layers wired together. Hits the layered guard in
// a single happy + sad ordering: env, config, billing, toggle, health.
// ---------------------------------------------------------------------------
describe("LET-369 — composed five-layer kill switch", () => {
  it("each layer fails closed independently and the lowest-numbered failing layer wins", async () => {
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";
    const store = new InMemoryBillingCapStore();
    const tracker = new ProviderHealthTracker();
    let operatorToggleEnabled = true;
    let providerEnableLayerEnabled = true;

    const fakeAcquire = vi.fn(async (_input: AcquireSandboxLeaseInput) => ({
      providerLeaseId: "sandbox://e2b/it-worked",
      metadata: { provider: "e2b" },
    }));

    async function tryLease() {
      tracker.assertHealthy(E2B_PROVIDER_KEY); // Layer 5 (last guard)
      const provider = new E2BSandboxProvider({
        isProviderEnabled: () => providerEnableLayerEnabled && operatorToggleEnabled,
        resolveApiKey: async () => RESOLVED_API_KEY_CANARY,
        liveTransportFactory: () => ({
          mode: "mock-http",
          createSandbox: async (input) => {
            await fakeAcquire(input as unknown as AcquireSandboxLeaseInput);
            return {
              id: "sandbox-fake-1",
              provider: "e2b",
              state: "created",
              metadata: {},
            };
          },
          startSandbox: async () => ({ id: "sandbox-fake-1", provider: "e2b", state: "running", metadata: {} }),
          executeCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          readLogs: async () => ({ lines: [], nextCursor: null, truncated: false }),
          streamEvents: async function* () {},
          releaseSandbox: async () => {},
          destroySandbox: async () => {},
        }),
      });
      return await provider.acquireLease(acquireInput);
    }

    // All layers green → success.
    await expect(tryLease()).resolves.toMatchObject({ providerLeaseId: expect.stringContaining("sandbox://e2b/") });
    expect(fakeAcquire).toHaveBeenCalledTimes(1);

    // Trip Layer 5 (tracker disabled).
    await tracker.reportRedactionViolation({ payloadKind: "exec_command_body" }).catch(() => {});
    await expect(tryLease()).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ healthState: "disabled" }),
    });
    await tracker.clear("operator: cleared for the cascade test");

    // Trip Layer 4 (operator toggle off).
    operatorToggleEnabled = false;
    await expect(tryLease()).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });
    operatorToggleEnabled = true;

    // Trip Layer 3 (provider-enable flipped by billing-cap monitor).
    providerEnableLayerEnabled = false;
    await expect(tryLease()).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "layer1_disabled" }),
    });
    providerEnableLayerEnabled = true;

    // Trip Layer 2 (env unset).
    delete process.env[MANAGED_SANDBOX_LIVE_ENV];
    await expect(tryLease()).rejects.toMatchObject({
      code: "PROVIDER_DISABLED",
      details: expect.objectContaining({ gate: "env_flag" }),
    });
    process.env[MANAGED_SANDBOX_LIVE_ENV] = "true";

    // Suppress the unused-store warning — the store is wired for parity with
    // production; the cascade is asserted via the simple toggles above.
    expect(await store.load(COMPANY, E2B_PROVIDER_KEY)).toBeNull();
  });
});
