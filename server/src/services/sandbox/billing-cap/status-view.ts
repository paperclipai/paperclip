/**
 * Phase 4A-S4 B2 (LET-367): builds the B3 status payload from the persisted
 * `sandbox_billing_cap_state` row + recent events + recent leases.
 *
 * The shape mirrors `ui/src/api/sandbox-billing-cap.ts` (B3 contract) — kept
 * in lockstep so the panel renders against the same names B2 emits.
 */

import { utcDayBounds, utcMonthBounds } from "./window.js";
import {
  E2B_PILOT_THRESHOLDS,
  evaluateCaps,
  type BillingCapThresholds,
} from "./policy.js";
import type { BillingCapEventRow, BillingCapStateRow } from "./store.js";
import type { SandboxBillingSourceLabel } from "./usage-source.js";

export type SandboxKillSwitchLayerId =
  | "provider-enable-config"
  | "env-gate"
  | "billing-cap-monitor"
  | "operator-toggle"
  | "lease-state-machine";

export type SandboxKillSwitchLayerState = "enabled" | "disabled" | "degraded";

export interface SandboxKillSwitchTransition {
  at: string;
  actorLabel: string;
}

export interface SandboxKillSwitchLayer {
  id: SandboxKillSwitchLayerId;
  label: string;
  state: SandboxKillSwitchLayerState;
  reason: string | null;
  lastTransition: SandboxKillSwitchTransition | null;
}

export interface SandboxSpendWindow {
  spentUsd: number;
  hardCapUsd: number;
  softCapUsd: number;
  periodStart: string;
  periodEnd: string;
}

export interface SandboxProviderDescriptor {
  key: string;
  displayLabel: string;
  apiKeyConfigured: boolean;
  secretRefRedactedSuffix: string | null;
}

export interface SandboxProviderLeaseSummary {
  id: string;
  state: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  runtimeCostEstimateUsd: number | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
}

export interface SandboxProviderIncident {
  eventKind: string;
  occurredAt: string;
  summary: string;
  issueIdentifier: string | null;
  issueHref: string | null;
}

export interface SandboxOperatorToggle {
  currentlyEnabled: boolean;
  canOperate: boolean;
  lockedReason: string | null;
}

export type SandboxBillingCapState =
  | "within-cap"
  | "soft-cap-breached"
  | "hard-cap-breached-auto-disabled";

export interface SandboxBillingCapStatusMeta {
  previewOnly: boolean;
  allowLive: boolean;
  generatedAt: string;
  source: SandboxBillingSourceLabel;
}

export interface SandboxBillingCapStatusView {
  meta: SandboxBillingCapStatusMeta;
  provider: SandboxProviderDescriptor;
  spend: {
    day: SandboxSpendWindow;
    month: SandboxSpendWindow;
  };
  capState: SandboxBillingCapState;
  killSwitch: { layers: SandboxKillSwitchLayer[] };
  recentLeases: SandboxProviderLeaseSummary[];
  lastIncident: SandboxProviderIncident | null;
  operatorToggle: SandboxOperatorToggle;
}

export interface BuildStatusViewInput {
  now: Date;
  provider: SandboxProviderDescriptor;
  state: BillingCapStateRow | null;
  recentEvents: BillingCapEventRow[];
  recentLeases: SandboxProviderLeaseSummary[];
  allowLive: boolean;
  previewOnly: boolean;
  canOperate: boolean;
  operatorLockedReason: string | null;
  thresholds?: BillingCapThresholds;
}

const KILL_SWITCH_LABELS: Record<SandboxKillSwitchLayerId, string> = {
  "provider-enable-config": "Provider-enable config",
  "env-gate": "Environment gate (SANDBOX_PROVIDER_ALLOW_LIVE)",
  "billing-cap-monitor": "Billing-cap monitor",
  "operator-toggle": "Operator toggle",
  "lease-state-machine": "Lease state machine",
};

function centsToUsdNumber(cents: number): number {
  return Math.round(cents) / 100;
}

function isoOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function buildStatusView(input: BuildStatusViewInput): SandboxBillingCapStatusView {
  const thresholds = input.thresholds ?? E2B_PILOT_THRESHOLDS;
  const day = utcDayBounds(input.now);
  const month = utcMonthBounds(input.now);
  const state = input.state;
  const daySpentCents = state?.daySpentCents ?? 0;
  const monthSpentCents = state?.monthSpentCents ?? 0;
  const evaluation = evaluateCaps({
    daySpentCents,
    monthSpentCents,
    thresholds,
  });

  const dayWindow: SandboxSpendWindow = {
    spentUsd: centsToUsdNumber(daySpentCents),
    hardCapUsd: centsToUsdNumber(thresholds.dayHardCents),
    softCapUsd: centsToUsdNumber(thresholds.daySoftCents),
    periodStart: (state?.dayWindowStart ?? day.start).toISOString(),
    periodEnd: day.end.toISOString(),
  };
  const monthWindow: SandboxSpendWindow = {
    spentUsd: centsToUsdNumber(monthSpentCents),
    hardCapUsd: centsToUsdNumber(thresholds.monthHardCents),
    softCapUsd: centsToUsdNumber(thresholds.monthSoftCents),
    periodStart: (state?.monthWindowStart ?? month.start).toISOString(),
    periodEnd: month.end.toISOString(),
  };

  const providerEnableLayer: SandboxKillSwitchLayer = {
    id: "provider-enable-config",
    label: KILL_SWITCH_LABELS["provider-enable-config"],
    state: state?.providerEnableLayerEnabled === false ? "disabled" : "enabled",
    reason: state?.providerEnableReason ?? null,
    lastTransition: state?.providerEnableTransitionAt
      ? {
          at: state.providerEnableTransitionAt.toISOString(),
          actorLabel: state.providerEnableActorLabel ?? "system",
        }
      : null,
  };
  const envGateLayer: SandboxKillSwitchLayer = {
    id: "env-gate",
    label: KILL_SWITCH_LABELS["env-gate"],
    state: input.allowLive ? "enabled" : "disabled",
    reason: input.allowLive ? null : "SANDBOX_PROVIDER_ALLOW_LIVE is not set",
    lastTransition: null,
  };
  const billingCapLayer: SandboxKillSwitchLayer = {
    id: "billing-cap-monitor",
    label: KILL_SWITCH_LABELS["billing-cap-monitor"],
    state:
      state?.dayHardCapBreachedAt || state?.monthHardCapBreachedAt
        ? "disabled"
        : evaluation.capState === "soft-cap-breached"
          ? "degraded"
          : "enabled",
    reason:
      state?.monthHardCapBreachedAt
        ? "monthly hard cap breached"
        : state?.dayHardCapBreachedAt
          ? "daily hard cap breached"
          : evaluation.capState === "soft-cap-breached"
            ? "soft cap reached"
            : null,
    lastTransition:
      state?.monthHardCapBreachedAt
        ? {
            at: state.monthHardCapBreachedAt.toISOString(),
            actorLabel: "auto-cap-monitor",
          }
        : state?.dayHardCapBreachedAt
          ? {
              at: state.dayHardCapBreachedAt.toISOString(),
              actorLabel: "auto-cap-monitor",
            }
          : null,
  };
  const operatorLayer: SandboxKillSwitchLayer = {
    id: "operator-toggle",
    label: KILL_SWITCH_LABELS["operator-toggle"],
    state: state?.operatorToggleEnabled === false ? "disabled" : "enabled",
    reason: state?.operatorToggleReason ?? null,
    lastTransition: state?.operatorToggleTransitionAt
      ? {
          at: state.operatorToggleTransitionAt.toISOString(),
          actorLabel: state.operatorToggleActorLabel ?? "operator",
        }
      : null,
  };
  const leaseLayer: SandboxKillSwitchLayer = {
    id: "lease-state-machine",
    label: KILL_SWITCH_LABELS["lease-state-machine"],
    // The lease state machine itself is owned by the docker / e2b providers
    // and reports here as `enabled` unless an external signal degrades it.
    state: "enabled",
    reason: null,
    lastTransition: null,
  };

  const lastIncidentEvent =
    input.recentEvents.find(
      (event) =>
        event.kind === "monthly_incident_opened" ||
        event.kind === "hard_cap_breached" ||
        event.kind === "auto_disable_engaged",
    ) ?? null;
  const lastIncident: SandboxProviderIncident | null = lastIncidentEvent
    ? {
        eventKind:
          lastIncidentEvent.kind === "hard_cap_breached"
            ? "sandbox.cost_breach"
            : lastIncidentEvent.kind === "auto_disable_engaged"
              ? "sandbox.kill_switch.flipped"
              : "sandbox.cost_breach",
        occurredAt: lastIncidentEvent.occurredAt.toISOString(),
        summary: lastIncidentEvent.reason ?? lastIncidentEvent.kind,
        issueIdentifier: lastIncidentEvent.incidentIssueId,
        issueHref: lastIncidentEvent.incidentIssueId
          ? `/issues/${lastIncidentEvent.incidentIssueId}`
          : null,
      }
    : null;

  return {
    meta: {
      previewOnly: input.previewOnly,
      allowLive: input.allowLive,
      generatedAt: input.now.toISOString(),
      source: (state?.lastSource as SandboxBillingSourceLabel | null) ?? "internal-estimate",
    },
    provider: input.provider,
    spend: { day: dayWindow, month: monthWindow },
    capState: evaluation.capState,
    killSwitch: {
      layers: [providerEnableLayer, envGateLayer, billingCapLayer, operatorLayer, leaseLayer],
    },
    recentLeases: input.recentLeases,
    lastIncident,
    operatorToggle: {
      currentlyEnabled: input.allowLive,
      canOperate: input.canOperate,
      lockedReason: input.operatorLockedReason,
    },
  };
}

/** Helper for the route layer to fall back gracefully on `lastPolledAt`. */
export function deriveLastPolledIso(state: BillingCapStateRow | null): string | null {
  return state?.lastPolledAt ? isoOrNull(state.lastPolledAt) : null;
}
