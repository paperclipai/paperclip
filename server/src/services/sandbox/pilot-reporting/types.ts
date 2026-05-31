/**
 * Pure input shapes consumed by the Phase 4A-S4 pilot-reporting components.
 *
 * These shapes are the integration seam between LET-411 (this prep work) and
 * LET-371 (the B6 pilot orchestration). They are intentionally narrow and
 * provider-agnostic: callers project from the live B2 counter store
 * (LET-367), the live B3 panel read-model (LET-368), the E2B status-page
 * poll, and the Paperclip lease history into these typed bundles. The
 * renderers themselves never reach across the seam — no I/O, no provider
 * transport, no secret-store read.
 *
 * If LET-367 / LET-368 ship a shape that diverges from what is declared here,
 * the LET-411 caller adds a thin adapter (see README) instead of mutating
 * the shipped shapes.
 */

export const PILOT_REPORTING_SCHEMA_VERSION = 1 as const;

export type CapState = "within" | "soft_cap" | "hard_cap_disabled";

export type KillSwitchLayerState = "armed" | "tripped" | "manual_disable";

export type ProviderLayerId =
  | "sandbox_provider"
  | "billing_cap"
  | "isolation_guard"
  | "secret_egress_guard";

export type KillSwitchState = {
  /** Layer identifier as exposed by the B3 panel read-model. */
  layer: ProviderLayerId;
  /** Current state. `tripped` and `manual_disable` both halt traffic. */
  state: KillSwitchLayerState;
  /** ISO timestamp of last state change, if recorded. */
  changedAt?: string | null;
  /** Operator-supplied reason for `tripped` / `manual_disable`. */
  reason?: string | null;
};

/**
 * Projection from the B2 counter store. Spend is in whole USD cents to avoid
 * float rounding in the renderer; callers convert.
 */
export type BillingCounterSnapshot = {
  /** UTC day the day-to-date counter represents (YYYY-MM-DD). */
  utcDay: string;
  /** Day-to-date spend in USD cents. */
  dayToDateCents: number;
  /** Month-to-date spend in USD cents. */
  monthToDateCents: number;
  /** Hard daily cap in USD cents. From B2 config; pilot frozen at 20 USD. */
  dailyHardCapCents: number;
  /** Hard monthly cap in USD cents. From B2 config; pilot frozen at 200 USD. */
  monthlyHardCapCents: number;
  /** Soft daily cap — operator warning threshold. */
  dailySoftCapCents?: number | null;
  /** Soft monthly cap — operator warning threshold. */
  monthlySoftCapCents?: number | null;
  /** Resolved day/month state after applying the caps. */
  dayState: CapState;
  monthState: CapState;
};

/**
 * Projection from the B3 panel read-model. Layer states drive the
 * Command Center "kill-switch state per layer" row in the snapshot.
 */
export type ProviderStatusSnapshot = {
  /** Capture timestamp (ISO). */
  capturedAt: string;
  /** Per-layer kill-switch state. */
  killSwitches: ReadonlyArray<KillSwitchState>;
  /** Last lease attempt metadata, if a lease was recorded in this window. */
  lastLease?: {
    leaseId: string;
    provider: "e2b" | string;
    outcome: "success" | "failure";
    completedAt: string;
    coldStartMs?: number | null;
    leaseReadyMs?: number | null;
  } | null;
};

/**
 * Vendor-side health from polling the E2B status-page. Callers fetch and
 * project; the renderer never makes a network call.
 */
export type VendorStatusPageSnapshot = {
  /** Vendor name — `"e2b"` for the pilot. */
  vendor: string;
  /** Capture timestamp (ISO). */
  capturedAt: string;
  /** Vendor uptime over the reported window, 0..1. `null` when unknown. */
  uptimeRatio: number | null;
  /** Vendor-reported incident IDs that overlap the reporting window. */
  activeIncidentIds: ReadonlyArray<string>;
  /** Free-text status. Renderer surfaces it as the vendor health note. */
  statusText?: string | null;
};

export type LeaseLatencyAggregate = {
  successCount: number;
  failureCount: number;
  /** p95 provider cold-start latency in ms. `null` when no samples. */
  coldStartP95Ms: number | null;
  /** p95 end-to-end lease-ready latency in ms. `null` when no samples. */
  leaseReadyP95Ms: number | null;
};

export type IsolationIncidentReport = {
  /** Stable incident id (issue identifier, log id, or operator-assigned). */
  id: string;
  /** ISO timestamp the incident was detected. */
  detectedAt: string;
  /** One-line operator summary. Renderer truncates at 240 chars. */
  summary: string;
  /** Optional pointer back to the issue/comment where the incident lives. */
  link?: string | null;
};

export type SecretLeakReport = {
  id: string;
  detectedAt: string;
  /** One-line operator summary. Never contains the raw secret. */
  summary: string;
  link?: string | null;
};

/** Bundle the daily-snapshot generator consumes. */
export type DailySnapshotInput = {
  /** Logical pilot day this snapshot represents (YYYY-MM-DD, UTC). */
  utcDay: string;
  /** Pilot identifier used in headings (e.g. `phase-4a-s4-e2b-pilot`). */
  pilotId: string;
  billing: BillingCounterSnapshot;
  providerStatus: ProviderStatusSnapshot;
  vendor: VendorStatusPageSnapshot;
  /** Running lease tally as of the snapshot capture. */
  leaseTally: LeaseLatencyAggregate;
  /** Isolation incidents detected during the reporting window. */
  isolationIncidents: ReadonlyArray<IsolationIncidentReport>;
  /** Raw-secret leak detections during the reporting window. */
  secretLeaks: ReadonlyArray<SecretLeakReport>;
  /**
   * `preview` until Andrii G2 fires and the live provider is enabled, then
   * `live`. The renderer surfaces this label in the snapshot header so
   * downstream readers can never confuse a stub-driven snapshot with a
   * live-pilot one.
   */
  truthLabel: "preview" | "live";
};

/** Exit-criteria thresholds frozen from LET-371 §"Exit criteria". */
export type ExitCriteriaThresholds = {
  leaseSuccessRateMin: number; // 0..1, e.g. 0.95
  coldStartP95MsMax: number; // e.g. 500
  leaseReadyP95MsMax: number; // e.g. 1500
  isolationIncidentsMax: number; // 0
  secretLeaksMax: number; // 0
  monthlyHardCapCents: number; // 20000 (= USD 200)
  vendorUptimeMin: number; // 0.995
};

export type OperatorConfidenceComment = {
  /** Role label, e.g. `Architect`, `QA Validator`, `Hermes Orchestrator`. */
  role: string;
  /** Display name of the operator who posted the comment. */
  operator: string;
  /** Verdict captured from the comment body. */
  verdict: "go" | "no_go" | "abstain";
  /** ISO timestamp of the comment. */
  postedAt: string;
  /** Pointer back to the LET-365 comment id (UUID). */
  commentId: string;
  /** Optional free-text excerpt for the report body (renderer truncates). */
  excerpt?: string | null;
};

export type DailySnapshotTallyEntry = {
  utcDay: string;
  leaseSuccessRate: number | null;
  coldStartP95Ms: number | null;
  daySpendCents: number;
  monthToDateCents: number;
  isolationIncidents: number;
  secretLeaks: number;
  vendorUptimeRatio: number | null;
  capState: CapState;
};

export type ExitCriteriaInput = {
  /** Pilot identifier, e.g. `phase-4a-s4-e2b-pilot`. */
  pilotId: string;
  /** Pilot window (ISO date strings, inclusive UTC days). */
  windowStartUtcDay: string;
  windowEndUtcDay: string;
  /** Aggregates across the full pilot window. */
  windowLeaseTally: LeaseLatencyAggregate;
  /** Final billing snapshot at window close. */
  finalBilling: BillingCounterSnapshot;
  /** Vendor uptime computed across the pilot window, 0..1. */
  vendorUptimeRatio: number | null;
  /** All daily snapshot tally rows for the pilot window. */
  dailyTally: ReadonlyArray<DailySnapshotTallyEntry>;
  /** Incident log — empty in a green pilot. */
  isolationIncidents: ReadonlyArray<IsolationIncidentReport>;
  secretLeaks: ReadonlyArray<SecretLeakReport>;
  /** Operator-confidence comments — must be 3 `go` for a clean pass. */
  operatorConfidenceComments: ReadonlyArray<OperatorConfidenceComment>;
  /** Threshold bundle (frozen from LET-371). */
  thresholds: ExitCriteriaThresholds;
  /** Optional explicit halt event if the pilot stopped early. */
  earlyHalt?: {
    triggeredAt: string;
    trigger: "cost_breach" | "isolation_incident" | "latency_failure" | "secret_leak" | "operator_halt";
    summary: string;
    incidentLink?: string | null;
  } | null;
  /** `preview` until G2 fires, then `live`. */
  truthLabel: "preview" | "live";
};

/** Frozen defaults that the Phase 4A-S4 pilot has approved. */
export const PILOT_EXIT_CRITERIA_DEFAULTS: ExitCriteriaThresholds = {
  leaseSuccessRateMin: 0.95,
  coldStartP95MsMax: 500,
  leaseReadyP95MsMax: 1500,
  isolationIncidentsMax: 0,
  secretLeaksMax: 0,
  monthlyHardCapCents: 20000,
  vendorUptimeMin: 0.995,
};
