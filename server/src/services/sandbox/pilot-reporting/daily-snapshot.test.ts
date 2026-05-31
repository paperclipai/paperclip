import { describe, expect, it } from "vitest";

import {
  projectBillingSnapshot,
  renderDailySnapshot,
  resolveCapState,
  successRate,
} from "./daily-snapshot.js";
import type {
  DailySnapshotInput,
  KillSwitchState,
  ProviderStatusSnapshot,
  VendorStatusPageSnapshot,
} from "./types.js";

function armedSwitches(): KillSwitchState[] {
  return [
    { layer: "sandbox_provider", state: "armed", changedAt: "2026-05-18T00:00:00Z", reason: null },
    { layer: "billing_cap", state: "armed", changedAt: "2026-05-18T00:00:00Z", reason: null },
    { layer: "isolation_guard", state: "armed", changedAt: "2026-05-18T00:00:00Z", reason: null },
    { layer: "secret_egress_guard", state: "armed", changedAt: "2026-05-18T00:00:00Z", reason: null },
  ];
}

function baseVendor(): VendorStatusPageSnapshot {
  return {
    vendor: "e2b",
    capturedAt: "2026-05-18T00:05:00Z",
    uptimeRatio: 0.999,
    activeIncidentIds: [],
    statusText: "All systems operational",
  };
}

function baseProviderStatus(): ProviderStatusSnapshot {
  return {
    capturedAt: "2026-05-18T00:05:00Z",
    killSwitches: armedSwitches(),
    lastLease: {
      leaseId: "lease-1",
      provider: "e2b",
      outcome: "success",
      completedAt: "2026-05-17T23:50:00Z",
      coldStartMs: 320,
      leaseReadyMs: 1100,
    },
  };
}

function withinCapInput(overrides: Partial<DailySnapshotInput> = {}): DailySnapshotInput {
  return {
    utcDay: "2026-05-18",
    pilotId: "phase-4a-s4-e2b-pilot",
    billing: projectBillingSnapshot({
      utcDay: "2026-05-18",
      dayToDateCents: 250,
      monthToDateCents: 4500,
      dailyHardCapCents: 2000,
      monthlyHardCapCents: 20000,
      dailySoftCapCents: 1500,
      monthlySoftCapCents: 15000,
    }),
    providerStatus: baseProviderStatus(),
    vendor: baseVendor(),
    leaseTally: {
      successCount: 47,
      failureCount: 1,
      coldStartP95Ms: 330,
      leaseReadyP95Ms: 1200,
    },
    isolationIncidents: [],
    secretLeaks: [],
    truthLabel: "preview",
    ...overrides,
  };
}

describe("renderDailySnapshot", () => {
  it("produces the green within-cap snapshot with no banners", () => {
    const out = renderDailySnapshot(withinCapInput());
    expect(out).toContain("# phase-4a-s4-e2b-pilot — daily snapshot (2026-05-18 UTC)");
    expect(out).toContain("Truth label: `preview`");
    expect(out).toContain("Day-to-date spend | $2.50 | $20.00 | ✅ within");
    expect(out).toContain("Month-to-date spend | $45.00 | $200.00 | ✅ within");
    expect(out).toContain("Lease success rate (running tally) | 97.92%");
    expect(out).toContain("p95 cold start | 330 ms");
    expect(out).toContain("Isolation incidents | 0");
    expect(out).toContain("Raw-secret leaks | 0");
    expect(out).toContain("sandbox_provider | ✅ armed");
    expect(out).not.toContain("Action banners");
  });

  it("flags soft-cap state without auto-disabling", () => {
    const input = withinCapInput({
      billing: projectBillingSnapshot({
        utcDay: "2026-05-18",
        dayToDateCents: 1600,
        monthToDateCents: 16000,
        dailyHardCapCents: 2000,
        monthlyHardCapCents: 20000,
        dailySoftCapCents: 1500,
        monthlySoftCapCents: 15000,
      }),
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("⚠️ soft cap");
    expect(out).toContain("Soft cap reached — operator warning");
    expect(out).not.toContain("HARD CAP REACHED");
  });

  it("flags hard-cap auto-disable as the lead banner", () => {
    const input = withinCapInput({
      billing: projectBillingSnapshot({
        utcDay: "2026-05-18",
        dayToDateCents: 2000,
        monthToDateCents: 17000,
        dailyHardCapCents: 2000,
        monthlyHardCapCents: 20000,
        dailySoftCapCents: 1500,
        monthlySoftCapCents: 15000,
      }),
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("🛑 hard cap (auto-disabled)");
    expect(out).toContain("HARD CAP REACHED — provider auto-disabled by B2");
  });

  it("flags isolation incidents and surfaces detail rows", () => {
    const input = withinCapInput({
      isolationIncidents: [
        {
          id: "iso-1",
          detectedAt: "2026-05-18T03:14:00Z",
          summary: "Provider returned cross-tenant filesystem handle",
          link: "https://example.invalid/LET-365#iso-1",
        },
      ],
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("Isolation incidents | 1");
    expect(out).toContain("### Isolation incident detail");
    expect(out).toContain("`iso-1`");
    expect(out).toContain("isolation incident(s) flagged this window");
  });

  it("flags raw-secret leak detections", () => {
    const input = withinCapInput({
      secretLeaks: [
        {
          id: "leak-7",
          detectedAt: "2026-05-18T04:00:00Z",
          summary: "API key reflected in provider audit log",
        },
      ],
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("Raw-secret leaks | 1");
    expect(out).toContain("### Raw-secret leak detail");
    expect(out).toContain("raw-secret leak(s) flagged this window");
  });

  it("warns when vendor uptime dips below 99.5%", () => {
    const input = withinCapInput({
      vendor: { ...baseVendor(), uptimeRatio: 0.991, activeIncidentIds: ["e2b-2026-05-18-A"] },
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("Uptime (window): 99.10%");
    expect(out).toContain("Vendor uptime 99.10% is below the 99.5% exit threshold");
    expect(out).toContain("Vendor reports 1 active incident(s)");
  });

  it("renders no-samples placeholder when lease tally is empty", () => {
    const input = withinCapInput({
      leaseTally: {
        successCount: 0,
        failureCount: 0,
        coldStartP95Ms: null,
        leaseReadyP95Ms: null,
      },
    });
    const out = renderDailySnapshot(input);
    expect(out).toContain("Lease success rate (running tally) | _no samples_");
    expect(out).toContain("p95 cold start | _no samples_");
  });
});

describe("helpers", () => {
  it("resolveCapState moves through within → soft → hard", () => {
    expect(resolveCapState(0, 100, 50)).toBe("within");
    expect(resolveCapState(50, 100, 50)).toBe("soft_cap");
    expect(resolveCapState(100, 100, 50)).toBe("hard_cap_disabled");
    expect(resolveCapState(120, 100, 50)).toBe("hard_cap_disabled");
    expect(resolveCapState(60, 100, null)).toBe("within");
  });

  it("successRate handles zero-sample and ratio cases", () => {
    expect(successRate({ successCount: 0, failureCount: 0, coldStartP95Ms: null, leaseReadyP95Ms: null })).toBeNull();
    expect(successRate({ successCount: 95, failureCount: 5, coldStartP95Ms: null, leaseReadyP95Ms: null })).toBe(0.95);
  });
});
