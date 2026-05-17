import { describe, expect, it } from "vitest";
import { buildStatusView, type SandboxProviderDescriptor } from "./status-view.js";
import { E2B_PILOT_THRESHOLDS } from "./policy.js";
import type { BillingCapStateRow } from "./store.js";

const NOW = new Date(Date.UTC(2026, 4, 17, 12, 0, 0));
const PROVIDER: SandboxProviderDescriptor = {
  key: "e2b",
  displayLabel: "E2B (Firecracker microVMs, managed)",
  apiKeyConfigured: false,
  secretRefRedactedSuffix: null,
};

function row(overrides: Partial<BillingCapStateRow> = {}): BillingCapStateRow {
  return {
    companyId: "company-1",
    provider: "e2b",
    dayWindowStart: new Date(Date.UTC(2026, 4, 17)),
    daySpentCents: 0,
    dayHardCapBreachedAt: null,
    monthWindowStart: new Date(Date.UTC(2026, 4, 1)),
    monthSpentCents: 0,
    monthHardCapBreachedAt: null,
    providerEnableLayerEnabled: true,
    providerEnableReason: null,
    providerEnableActorLabel: null,
    providerEnableTransitionAt: null,
    operatorToggleEnabled: true,
    operatorToggleReason: null,
    operatorToggleActorLabel: null,
    operatorToggleTransitionAt: null,
    lastPolledAt: NOW,
    lastSource: "internal-estimate",
    ...overrides,
  };
}

describe("buildStatusView", () => {
  it("returns within-cap defaults for empty state", () => {
    const view = buildStatusView({
      now: NOW,
      provider: PROVIDER,
      state: null,
      recentEvents: [],
      recentLeases: [],
      allowLive: false,
      previewOnly: true,
      canOperate: false,
      operatorLockedReason: "test",
    });
    expect(view.capState).toBe("within-cap");
    expect(view.spend.day.spentUsd).toBe(0);
    expect(view.spend.day.hardCapUsd).toBe(E2B_PILOT_THRESHOLDS.dayHardCents / 100);
    expect(view.killSwitch.layers.find((l) => l.id === "env-gate")?.state).toBe("disabled");
    expect(view.operatorToggle.canOperate).toBe(false);
  });

  it("marks provider-enable layer disabled when state has providerEnableLayerEnabled=false", () => {
    const view = buildStatusView({
      now: NOW,
      provider: PROVIDER,
      state: row({
        providerEnableLayerEnabled: false,
        providerEnableReason: "day_hard_cap_breached",
        providerEnableActorLabel: "auto-cap-monitor",
        providerEnableTransitionAt: NOW,
        dayHardCapBreachedAt: NOW,
        daySpentCents: 20_00,
        monthSpentCents: 20_00,
      }),
      recentEvents: [],
      recentLeases: [],
      allowLive: true,
      previewOnly: true,
      canOperate: true,
      operatorLockedReason: null,
    });
    expect(view.capState).toBe("hard-cap-breached-auto-disabled");
    const layer = view.killSwitch.layers.find((l) => l.id === "provider-enable-config");
    expect(layer?.state).toBe("disabled");
    expect(layer?.lastTransition?.actorLabel).toBe("auto-cap-monitor");
  });

  it("classifies billing-cap-monitor layer as degraded on soft cap", () => {
    const view = buildStatusView({
      now: NOW,
      provider: PROVIDER,
      state: row({ daySpentCents: 15_00, monthSpentCents: 15_00 }),
      recentEvents: [],
      recentLeases: [],
      allowLive: true,
      previewOnly: true,
      canOperate: true,
      operatorLockedReason: null,
    });
    expect(view.capState).toBe("soft-cap-breached");
    expect(view.killSwitch.layers.find((l) => l.id === "billing-cap-monitor")?.state).toBe("degraded");
  });

  it("surfaces last incident from monthly_incident_opened event", () => {
    const view = buildStatusView({
      now: NOW,
      provider: PROVIDER,
      state: row({ monthHardCapBreachedAt: NOW }),
      recentEvents: [
        {
          id: "evt-1",
          companyId: "company-1",
          provider: "e2b",
          kind: "monthly_incident_opened",
          windowKind: "month",
          spentCents: 200_00,
          thresholdCents: 200_00,
          projectionCents: null,
          actorLabel: "auto-cap-monitor",
          reason: "Paperclip incident issue opened",
          incidentIssueId: "issue-99",
          metadata: null,
          occurredAt: NOW,
        },
      ],
      recentLeases: [],
      allowLive: true,
      previewOnly: true,
      canOperate: true,
      operatorLockedReason: null,
    });
    expect(view.lastIncident?.issueIdentifier).toBe("issue-99");
    expect(view.lastIncident?.issueHref).toBe("/issues/issue-99");
  });
});
