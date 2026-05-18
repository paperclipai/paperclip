/**
 * LET-368 (Phase 4A-S4 B3): typed client + stable read-model interface for
 * the sandbox billing-cap + kill-switch status surface. B2 ships the actual
 * `/companies/:id/sandbox/billing-cap/status` endpoint; this module is the
 * frozen contract the B3 Command Center panel reads against, so the two
 * workstreams can merge in parallel.
 *
 * Hard invariants this contract enforces:
 *   - No raw vendor credential is ever transported to the browser. The
 *     server returns `apiKeyConfigured: boolean` plus an optional redacted
 *     suffix of the *secret-ref name* (never the secret value).
 *   - Spend numbers are read out of the persisted B2 counter store. The
 *     browser never hits the vendor usage endpoint directly.
 *   - All response payloads carry a `previewOnly` flag mirroring the
 *     `SANDBOX_PROVIDER_ALLOW_LIVE` env gate so the UI can render the
 *     "Vendor pilot not yet live" banner inherited from LET-352.
 *
 * Until B2 mounts the route, the query returns 404; the panel handles that
 * as the "no-data-yet" empty state required by Definition of Done.
 */

import { api } from "./client";

export type SandboxBillingSourceLabel = "e2b-usage-api" | "internal-estimate";

export type SandboxBillingCapState =
  | "within-cap"
  | "soft-cap-breached"
  | "hard-cap-breached-auto-disabled";

export type SandboxKillSwitchLayerId =
  | "provider-enable-config"
  | "env-gate"
  | "billing-cap-monitor"
  | "operator-toggle"
  | "lease-state-machine";

export type SandboxKillSwitchLayerState = "enabled" | "disabled" | "degraded";

export interface SandboxKillSwitchTransition {
  /** ISO-8601 timestamp of the most recent state transition. */
  at: string;
  /**
   * Display label of the actor that flipped the layer (operator id, system,
   * `auto-cap-monitor`). The server is responsible for redacting any
   * sensitive identifier before sending.
   */
  actorLabel: string;
}

export interface SandboxKillSwitchLayer {
  id: SandboxKillSwitchLayerId;
  /** Operator-facing label, e.g. "Provider-enable config". */
  label: string;
  state: SandboxKillSwitchLayerState;
  /** Optional short reason rendered alongside a degraded/disabled chip. */
  reason: string | null;
  lastTransition: SandboxKillSwitchTransition | null;
}

export interface SandboxSpendWindow {
  /** Display value, e.g. `0.00`. Server-side rounded to 2dp. */
  spentUsd: number;
  hardCapUsd: number;
  softCapUsd: number;
  /** ISO-8601 window bounds in UTC. Day = UTC midnight to midnight. */
  periodStart: string;
  periodEnd: string;
}

export interface SandboxProviderDescriptor {
  /** Stable machine key — e.g. `e2b`. */
  key: string;
  /** Display label, e.g. `E2B (Firecracker microVMs, managed)`. */
  displayLabel: string;
  /**
   * True iff the secret-ref pointing at the vendor API key is populated in
   * the secret store. Raw value is never sent to the browser.
   */
  apiKeyConfigured: boolean;
  /**
   * Last ≤4 chars of the secret-ref NAME (never of the value). May be null
   * when the ref is unset; absent on older server builds.
   */
  secretRefRedactedSuffix: string | null;
}

export interface SandboxProviderLeaseSummary {
  id: string;
  /** Lease lifecycle state (`requested` … `failed`). */
  state: string;
  startedAt: string;
  endedAt: string | null;
  /** Wallclock duration in seconds. Null when still running. */
  durationSeconds: number | null;
  /** Best-effort cost estimate in USD (B2 counter store value). */
  runtimeCostEstimateUsd: number | null;
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
}

export interface SandboxProviderIncident {
  /** Stable event kind, e.g. `sandbox.cost_breach`, `sandbox.kill_switch.flipped`. */
  eventKind: string;
  occurredAt: string;
  summary: string;
  /**
   * Optional pointer to the `sandbox/cost-breach` issue B2 opens on hard-cap
   * breach. Present only when an issue was opened.
   */
  issueIdentifier: string | null;
  issueHref: string | null;
}

export interface SandboxOperatorToggle {
  /** True when `SANDBOX_PROVIDER_ALLOW_LIVE === "true"` on the server. */
  currentlyEnabled: boolean;
  /**
   * Permission flag from the server: viewer is a board-role user AND the
   * pilot is in a state that accepts toggling. Non-board roles always
   * receive `false` regardless of `currentlyEnabled`.
   */
  canOperate: boolean;
  /**
   * Optional copy explaining *why* `canOperate` is false (e.g. "Requires
   * board role per project pull-request policy"). Stable enough for the
   * UI to render verbatim.
   */
  lockedReason: string | null;
}

export interface SandboxBillingCapStatusMeta {
  previewOnly: boolean;
  /** Mirrors `SANDBOX_PROVIDER_ALLOW_LIVE`. False ⇒ "Vendor pilot not yet live" banner. */
  allowLive: boolean;
  /** ISO-8601 backend snapshot time. UI surfaces this as the freshness chip. */
  generatedAt: string;
  /** Where the spend numbers came from. */
  source: SandboxBillingSourceLabel;
}

export interface SandboxBillingCapStatus {
  meta: SandboxBillingCapStatusMeta;
  provider: SandboxProviderDescriptor;
  spend: {
    day: SandboxSpendWindow;
    month: SandboxSpendWindow;
  };
  capState: SandboxBillingCapState;
  killSwitch: {
    layers: SandboxKillSwitchLayer[];
  };
  recentLeases: SandboxProviderLeaseSummary[];
  lastIncident: SandboxProviderIncident | null;
  operatorToggle: SandboxOperatorToggle;
}

export interface SandboxOperatorToggleFlipRequest {
  /**
   * Desired post-flip state. Server may reject (HTTP 409) if the current
   * state already matches.
   */
  enable: boolean;
  /**
   * Operator-supplied free-text reason. The server is responsible for
   * persisting this in the audit log along with operator id + timestamp.
   * Required (server returns 422 if empty/whitespace).
   */
  reason: string;
}

export interface SandboxOperatorToggleFlipResponse {
  ok: true;
  /** Echoes the new state after the audited flip. */
  currentlyEnabled: boolean;
}

export const sandboxBillingCapApi = {
  /**
   * Fetch the provider-status read model. The endpoint is owned by B2 and
   * is mounted under the existing `/api/companies/:id/sandbox/*` namespace
   * (no new public REST surface area).
   */
  getStatus: (companyId: string) =>
    api.get<SandboxBillingCapStatus>(`/companies/${companyId}/sandbox/billing-cap/status`),

  /**
   * Audited operator toggle for the provider-enable config layer. The
   * server-side handler is the only write path on this surface and lives
   * behind the existing admin-API authz check (board role required). The
   * UI must always disable this control when `operatorToggle.canOperate`
   * is false; the call is here for callers that have been pre-authorised.
   */
  flipOperatorToggle: (companyId: string, body: SandboxOperatorToggleFlipRequest) =>
    api.post<SandboxOperatorToggleFlipResponse>(
      `/companies/${companyId}/sandbox/billing-cap/operator-toggle`,
      body,
    ),
};
