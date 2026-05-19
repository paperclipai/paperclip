/**
 * @fileoverview Adapter-level circuit breaker — ADR-0006 / CLI-121
 *
 * State machine per adapter type:
 *   Closed  → (trip condition met)    → Open
 *   Open    → (resumeAt elapsed)      → Half-Open
 *   Half-Open → (probe success × N)   → Closed
 *   Half-Open → (probe failure)       → Open
 *
 * Admin routes (CLI-159) call forceQuarantine() and resetBreaker().
 * Failure accounting (CLI-156 classifyAdapterFailure) calls recordFailure().
 *
 * All state is in-process. The server restart clears the breaker; persistent
 * storage is a follow-up (counters survive until the outage is resolved).
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type CircuitPhase = "Closed" | "Open" | "HalfOpen";

export interface TripEvidence {
  adapterType: string;
  failureReason: string;
  agentId?: string | null;
  occurredAt: number;
}

export interface CircuitState {
  adapterType: string;
  phase: CircuitPhase;
  /** Absolute ms timestamp when the circuit tripped (entered Open). */
  trippedAt: number | null;
  /** Absolute ms timestamp after which Open may transition to HalfOpen. */
  resumeAt: number | null;
  /** Human-readable reason the breaker tripped (e.g., "burst_threshold_exceeded"). */
  tripReason: string | null;
  /** Last N failures that triggered the trip. */
  tripEvidence: TripEvidence[];
  /** Consecutive probe successes in HalfOpen. */
  probeSuccessCount: number;
  /** How many times the breaker has re-tripped within reTripGraceSec. */
  reTripCount: number;
  /** Timestamp of most recent Closed→Open transition for re-trip grace accounting. */
  lastReleasedAt: number | null;
  /** Effective burst threshold (may be halved by re-trip logic). */
  effectiveNBurst: number;
  /** Effective sustained threshold (may be halved by re-trip logic). */
  effectiveNSustained: number;
}

export interface BreakerConfig {
  enabled: boolean;
  nBurst: number;
  tBurstMs: number;
  nSustained: number;
  tSustainedMs: number;
  probeIntervalMs: number;
  probeSuccessCount: number;
  reTripGraceMs: number;
  shadowMode: boolean;
}

export interface AuditRow {
  id: string;
  timestamp: number;
  action: "force_quarantine" | "reset" | "probe_release" | "auto_trip";
  adapterType: string;
  actorType: "board" | "agent" | "system";
  actorId: string;
  outcome: "success" | "rejected";
  rejectionReason?: string;
  details?: Record<string, unknown>;
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BreakerConfig = {
  enabled: process.env.PAPERCLIP_ADAPTER_BREAKER_ENABLED !== "false",
  nBurst: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_N_BURST ?? 3),
  tBurstMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_T_BURST_SEC ?? 60) * 1000,
  nSustained: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_N_SUSTAINED ?? 10),
  tSustainedMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_T_SUSTAINED_SEC ?? 600) * 1000,
  probeIntervalMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_PROBE_INTERVAL_SEC ?? 30) * 1000,
  probeSuccessCount: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_PROBE_SUCCESS_COUNT ?? 3),
  reTripGraceMs: Number(process.env.PAPERCLIP_ADAPTER_BREAKER_RETRP_GRACE_SEC ?? 120) * 1000,
  shadowMode: process.env.PAPERCLIP_ADAPTER_BREAKER_SHADOW_MODE === "true",
};

// ── State ──────────────────────────────────────────────────────────────────

/** Per-adapter-type circuit state. */
const registry = new Map<string, CircuitState>();

/** Recent failures per adapter type within the bust/sustained windows. */
const failureWindow = new Map<string, TripEvidence[]>();

/** Audit ring buffer — last 500 actions. */
const auditRing: AuditRow[] = [];
const AUDIT_MAX = 500;

let _config: BreakerConfig = { ...DEFAULT_CONFIG };

// ── Helpers ────────────────────────────────────────────────────────────────

function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function getOrInit(adapterType: string): CircuitState {
  if (!registry.has(adapterType)) {
    registry.set(adapterType, {
      adapterType,
      phase: "Closed",
      trippedAt: null,
      resumeAt: null,
      tripReason: null,
      tripEvidence: [],
      probeSuccessCount: 0,
      reTripCount: 0,
      lastReleasedAt: null,
      effectiveNBurst: _config.nBurst,
      effectiveNSustained: _config.nSustained,
    });
  }
  return registry.get(adapterType)!;
}

function writeAudit(row: Omit<AuditRow, "id" | "timestamp">): AuditRow {
  const full: AuditRow = { id: uuidv4(), timestamp: Date.now(), ...row };
  auditRing.push(full);
  if (auditRing.length > AUDIT_MAX) auditRing.shift();
  return full;
}

/** Apply re-trip threshold halving. Returns halved value (floor 1). */
function halveCeil(n: number): number {
  return Math.max(1, Math.ceil(n / 2));
}

function shouldTripBurst(windows: TripEvidence[], nBurst: number, tBurstMs: number, now: number): boolean {
  const cutoff = now - tBurstMs;
  const distinctAgents = new Set(windows.filter((e) => e.occurredAt >= cutoff).map((e) => e.agentId ?? "unknown"));
  return distinctAgents.size >= nBurst;
}

function shouldTripSustained(windows: TripEvidence[], nSustained: number, tSustainedMs: number, now: number): boolean {
  const cutoff = now - tSustainedMs;
  return windows.filter((e) => e.occurredAt >= cutoff).length >= nSustained;
}

function checkAndApplyRetrip(state: CircuitState, now: number): void {
  const { lastReleasedAt, reTripCount } = state;
  const withinGrace = lastReleasedAt !== null && now - lastReleasedAt < _config.reTripGraceMs;
  if (withinGrace) {
    state.reTripCount = reTripCount + 1;
    state.effectiveNBurst = halveCeil(state.effectiveNBurst);
    state.effectiveNSustained = halveCeil(state.effectiveNSustained);
  }
}

function doTrip(state: CircuitState, reason: string, evidence: TripEvidence[], now: number): void {
  checkAndApplyRetrip(state, now);
  state.phase = "Open";
  state.trippedAt = now;
  state.resumeAt = now + _config.probeIntervalMs;
  state.tripReason = reason;
  state.tripEvidence = evidence.slice(-10);
  state.probeSuccessCount = 0;
}

function resetThresholdsIfStable(state: CircuitState, now: number): void {
  if (
    state.lastReleasedAt !== null &&
    now - state.lastReleasedAt >= _config.reTripGraceMs &&
    state.reTripCount > 0
  ) {
    state.reTripCount = 0;
    state.effectiveNBurst = _config.nBurst;
    state.effectiveNSustained = _config.nSustained;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function configure(overrides: Partial<BreakerConfig>): void {
  _config = { ...DEFAULT_CONFIG, ...overrides };
}

export function getConfig(): Readonly<BreakerConfig> {
  return _config;
}

export function getCircuitState(adapterType: string): CircuitState | null {
  return registry.get(adapterType) ?? null;
}

export function getAllCircuitStates(): ReadonlyMap<string, CircuitState> {
  return registry;
}

/** Record an adapter-origin failure. Returns true if the breaker tripped. */
export function recordFailure(evidence: TripEvidence): boolean {
  if (!_config.enabled) return false;

  const { adapterType } = evidence;
  const state = getOrInit(adapterType);
  const now = evidence.occurredAt;

  // Ignore failures when already Open (the outage is known)
  if (state.phase === "Open") return false;

  // Accumulate failures
  let window = failureWindow.get(adapterType);
  if (!window) {
    window = [];
    failureWindow.set(adapterType, window);
  }
  window.push(evidence);

  // Prune old entries outside the longer sustained window
  const cutoff = now - _config.tSustainedMs;
  while (window.length > 0 && window[0].occurredAt < cutoff) {
    window.shift();
  }

  const { effectiveNBurst, effectiveNSustained } = state;
  let tripReason: string | null = null;

  if (shouldTripBurst(window, effectiveNBurst, _config.tBurstMs, now)) {
    tripReason = "burst_threshold_exceeded";
  } else if (shouldTripSustained(window, effectiveNSustained, _config.tSustainedMs, now)) {
    tripReason = "sustained_threshold_exceeded";
  }

  if (tripReason) {
    if (!_config.shadowMode) {
      doTrip(state, tripReason, window, now);
    }
    writeAudit({
      action: "auto_trip",
      adapterType,
      actorType: "system",
      actorId: "system",
      outcome: "success",
      details: { tripReason, shadowMode: _config.shadowMode, failureCount: window.length },
    });
    return !_config.shadowMode;
  }

  return false;
}

/** Record a probe result from the health-check background job. */
export function recordProbeResult(adapterType: string, ok: boolean): "released" | "re_tripped" | "noop" {
  const state = registry.get(adapterType);
  if (!state) return "noop";

  const now = Date.now();

  if (state.phase === "Open") {
    if (now >= (state.resumeAt ?? 0)) {
      state.phase = "HalfOpen";
      state.probeSuccessCount = 0;
    } else {
      return "noop";
    }
  }

  if (state.phase !== "HalfOpen") return "noop";

  if (ok) {
    state.probeSuccessCount += 1;
    if (state.probeSuccessCount >= _config.probeSuccessCount) {
      // Release
      state.phase = "Closed";
      state.trippedAt = null;
      state.resumeAt = null;
      state.tripReason = null;
      state.tripEvidence = [];
      state.lastReleasedAt = now;
      failureWindow.delete(adapterType);
      resetThresholdsIfStable(state, now);
      writeAudit({
        action: "probe_release",
        adapterType,
        actorType: "system",
        actorId: "system",
        outcome: "success",
        details: { probeSuccessCount: state.probeSuccessCount },
      });
      return "released";
    }
  } else {
    // Probe failure — re-open
    state.probeSuccessCount = 0;
    doTrip(state, "probe_failure", state.tripEvidence, now);
    writeAudit({
      action: "auto_trip",
      adapterType,
      actorType: "system",
      actorId: "system",
      outcome: "success",
      details: { tripReason: "probe_failure" },
    });
    return "re_tripped";
  }

  return "noop";
}

/**
 * Manually force an adapter into quarantine (Open state).
 * Only board (human) actors may call this; agent actors are rejected.
 * Returns the audit row written.
 */
export function forceQuarantine(
  adapterType: string,
  actorType: "board" | "agent",
  actorId: string,
  reason?: string,
): { allowed: boolean; auditRow: AuditRow } {
  if (actorType === "agent") {
    const row = writeAudit({
      action: "force_quarantine",
      adapterType,
      actorType: "agent",
      actorId,
      outcome: "rejected",
      rejectionReason: "actor_is_agent",
    });
    return { allowed: false, auditRow: row };
  }

  const state = getOrInit(adapterType);
  const now = Date.now();
  doTrip(state, reason ?? "manual_force_quarantine", [], now);

  const row = writeAudit({
    action: "force_quarantine",
    adapterType,
    actorType: "board",
    actorId,
    outcome: "success",
    details: { reason: reason ?? "manual_force_quarantine" },
  });
  return { allowed: true, auditRow: row };
}

/**
 * Manually reset the circuit breaker to Closed state.
 * Only board (human) actors may call this; agent actors are rejected.
 * Returns the audit row written.
 */
export function resetBreaker(
  adapterType: string,
  actorType: "board" | "agent",
  actorId: string,
  force = false,
): { allowed: boolean; auditRow: AuditRow } {
  if (actorType === "agent") {
    const row = writeAudit({
      action: "reset",
      adapterType,
      actorType: "agent",
      actorId,
      outcome: "rejected",
      rejectionReason: "actor_is_agent",
    });
    return { allowed: false, auditRow: row };
  }

  const state = getOrInit(adapterType);
  const now = Date.now();

  state.phase = "Closed";
  state.trippedAt = null;
  state.resumeAt = null;
  state.tripReason = null;
  state.tripEvidence = [];
  state.probeSuccessCount = 0;
  state.lastReleasedAt = now;
  if (force) {
    state.reTripCount = 0;
    state.effectiveNBurst = _config.nBurst;
    state.effectiveNSustained = _config.nSustained;
  }
  failureWindow.delete(adapterType);

  const row = writeAudit({
    action: "reset",
    adapterType,
    actorType: "board",
    actorId,
    outcome: "success",
    details: { force },
  });
  return { allowed: true, auditRow: row };
}

/** Returns a copy of the audit ring buffer (newest last). */
export function getAuditLog(): ReadonlyArray<AuditRow> {
  return [...auditRing];
}

/** Reset all in-memory state (used in tests). */
export function _resetForTesting(): void {
  registry.clear();
  failureWindow.clear();
  auditRing.length = 0;
  _config = { ...DEFAULT_CONFIG };
}
