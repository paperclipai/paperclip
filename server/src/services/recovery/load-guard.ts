import os from "node:os";

/**
 * RBR-1013 — load-aware recovery deferral (RBR-977 scope item 3).
 *
 * RBR-977 measured that of 34 concurrent runs at 08:40-08:46, 23 were
 * recovery-triggered (14 `issue_continuation_needed`, 9
 * `source_scoped_recovery_action`) — recovery was the largest single source
 * of new load, reacting to failures it was itself causing. This module is
 * the load gate recovery sweeps consult before dispatching: when host load
 * or API latency is over threshold, the sweep must defer instead of
 * dispatching more work into an overload it is already part of.
 *
 * Deliberately pure and side-effect-free at the decision layer: every input
 * (host load, API p50) is passed in by the caller rather than read from
 * global state inside `evaluateRecoveryLoadGate`. This keeps the gate
 * trivially unit-testable and — just as importantly — keeps it from being
 * silently exercised by unrelated tests that call recovery sweep functions
 * without supplying load data (see `HEALTHY_HOST_LOAD_SNAPSHOT`: callers
 * that don't care about this feature get a snapshot that never trips the
 * gate, rather than incidentally reading this host's *real*, possibly
 * elevated, load average).
 */

export type HostLoadSnapshot = {
  loadAverage1m: number;
  cpuCount: number;
};

/** A snapshot that never trips the gate. The default for callers/tests that
 * do not explicitly supply real load data — see module docstring. */
export const HEALTHY_HOST_LOAD_SNAPSHOT: HostLoadSnapshot = {
  loadAverage1m: 0,
  cpuCount: 1,
};

export type RecoveryLoadThresholds = {
  /** Defer when (1m load average / cpu count) exceeds this ratio. */
  loadRefusalRatio: number;
  /** Defer when the supplied API p50 (ms) exceeds this value. */
  apiP50ThresholdMs: number;
  /** Window (ms) the recovery sweep's default API-p50 reader looks back
   * over. Deliberately bounded — the tracker retains samples for six hours
   * (see `DEFAULT_API_LATENCY_RETENTION_MS`), but the recovery gate is
   * asking "is the host degraded *right now*", not "was it degraded at any
   * point in the last six hours". Without this bound, a sustained
   * degradation that later recovers keeps the sweep deferred until enough
   * stale samples age out of the full retention window (Greptile P1 on
   * PR #11028, commit c7bfe48c). */
  apiLatencyWindowMs: number;
};

export const DEFAULT_RECOVERY_LOAD_REFUSAL_RATIO = 1.25;
export const DEFAULT_RECOVERY_API_P50_THRESHOLD_MS = 5_000;
export const DEFAULT_RECOVERY_API_LATENCY_WINDOW_MS = 5 * 60 * 1000;

function readPositiveFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRecoveryLoadThresholds(
  env: Record<string, string | undefined> = process.env,
  overrides?: Partial<RecoveryLoadThresholds>,
): RecoveryLoadThresholds {
  return {
    loadRefusalRatio: readPositiveFloat(
      overrides?.loadRefusalRatio !== undefined ? String(overrides.loadRefusalRatio) : env.PAPERCLIP_RECOVERY_LOAD_REFUSAL_RATIO,
      DEFAULT_RECOVERY_LOAD_REFUSAL_RATIO,
    ),
    apiP50ThresholdMs: readPositiveFloat(
      overrides?.apiP50ThresholdMs !== undefined ? String(overrides.apiP50ThresholdMs) : env.PAPERCLIP_RECOVERY_API_P50_THRESHOLD_MS,
      DEFAULT_RECOVERY_API_P50_THRESHOLD_MS,
    ),
    apiLatencyWindowMs: readPositiveFloat(
      overrides?.apiLatencyWindowMs !== undefined ? String(overrides.apiLatencyWindowMs) : env.PAPERCLIP_RECOVERY_API_P50_WINDOW_MS,
      DEFAULT_RECOVERY_API_LATENCY_WINDOW_MS,
    ),
  };
}

/** Read the real host load snapshot. Only production call sites should call
 * this directly — recovery sweep functions accept load data as an argument
 * so tests are never implicitly exposed to this host's real load. */
export function readHostLoadSnapshot(): HostLoadSnapshot {
  const cpuCount = Math.max(1, os.cpus().length);
  const [loadAverage1m] = os.loadavg();
  return {
    cpuCount,
    loadAverage1m: Number.isFinite(loadAverage1m) ? Math.max(0, loadAverage1m) : 0,
  };
}

export type LoadGateDeps = {
  /** Defaults to `readHostLoadSnapshot` (real `os.loadavg()`). Tests should
   * override this rather than relying on this host's real, possibly
   * elevated, load average. */
  readHostLoadSnapshot?: () => HostLoadSnapshot;
  /** Defaults to `apiLatencyTracker.getP50()`. */
  readApiP50Ms?: () => number | null;
  thresholdOverrides?: Partial<RecoveryLoadThresholds>;
};

export type RecoveryLoadGateReason = "host_load" | "api_latency";

export type RecoveryLoadGateDecision = {
  deferred: boolean;
  reason: RecoveryLoadGateReason | null;
  detail: string;
};

/**
 * The gate itself. Load is checked before API latency: it is the cheaper,
 * more direct signal (API latency can be elevated for reasons unrelated to
 * recovery, e.g. a single slow downstream call), and a host already past
 * the load ratio should not dispatch regardless of what the latency sample
 * says.
 */
export function evaluateRecoveryLoadGate(input: {
  hostLoad: HostLoadSnapshot;
  apiP50Ms: number | null;
  thresholds: RecoveryLoadThresholds;
}): RecoveryLoadGateDecision {
  const cpuCount = Math.max(1, input.hostLoad.cpuCount);
  const loadRatio = input.hostLoad.loadAverage1m / cpuCount;
  if (loadRatio > input.thresholds.loadRefusalRatio) {
    return {
      deferred: true,
      reason: "host_load",
      detail:
        `deferring recovery dispatch: 1m load ${input.hostLoad.loadAverage1m.toFixed(2)} on ${cpuCount} cores ` +
        `(ratio ${loadRatio.toFixed(2)}) exceeds ${input.thresholds.loadRefusalRatio}x`,
    };
  }
  if (input.apiP50Ms !== null && input.apiP50Ms > input.thresholds.apiP50ThresholdMs) {
    return {
      deferred: true,
      reason: "api_latency",
      detail: `deferring recovery dispatch: API p50 ${input.apiP50Ms}ms exceeds ${input.thresholds.apiP50ThresholdMs}ms threshold`,
    };
  }
  return {
    deferred: false,
    reason: null,
    detail: "recovery dispatch admitted: host load and API latency within thresholds",
  };
}

// --- API latency sampling -------------------------------------------------
//
// A tiny in-process ring buffer fed by the HTTP request middleware
// (`middleware/api-latency-sampler.ts`) so recovery sweeps and the
// productivity monitor can both ask "what has API p50 looked like recently"
// without a metrics backend. Deliberately process-local: it only needs to
// answer "is *this* server instance currently degraded", which is exactly
// the scope of the pathology RBR-977 measured.

const DEFAULT_API_LATENCY_MAX_SAMPLES = 5_000;
const DEFAULT_API_LATENCY_RETENTION_MS = 6 * 60 * 60 * 1000;

type LatencySample = { at: number; ms: number; companyId: string | null };

export class ApiLatencyTracker {
  private samples: LatencySample[] = [];

  constructor(
    private readonly maxSamples = DEFAULT_API_LATENCY_MAX_SAMPLES,
    private readonly retentionMs = DEFAULT_API_LATENCY_RETENTION_MS,
  ) {}

  /** `companyId` is optional so unauthenticated/pre-actor requests (health
   * checks, auth routes) can still feed the host-wide degradation signal —
   * but any *company-scoped* consumer (see `getP50`'s `companyId` param)
   * must never match those, hence `null` rather than an empty string. */
  record(ms: number, at = Date.now(), companyId: string | null = null) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push({ at, ms, companyId });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  private prune(now: number) {
    const cutoff = now - this.retentionMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) {
      this.samples.shift();
    }
  }

  /** p50 over the trailing `windowMs`, or over all retained samples when
   * `windowMs` is omitted. Returns null when there are no samples in range —
   * callers must treat that as "unknown", never as "healthy" or "degraded".
   *
   * When `companyId` is supplied, only that company's own recorded samples
   * count — a company-scoped consumer (e.g. the productivity monitor
   * deciding whether *this company's* no-comment streak is attributable)
   * must never be suppressed or explained by another company's slow
   * requests on a shared multi-tenant instance. Omit `companyId` for
   * host-wide consumers (e.g. the recovery sweep, which is asking "is this
   * server instance currently degraded" — a question with no company
   * scope). */
  getP50(windowMs?: number, now = Date.now(), companyId?: string): number | null {
    this.prune(now);
    const cutoff = windowMs !== undefined ? now - windowMs : -Infinity;
    const values = this.samples
      .filter((sample) => sample.at >= cutoff)
      .filter((sample) => companyId === undefined || sample.companyId === companyId)
      .map((sample) => sample.ms);
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.5 * sorted.length) - 1));
    return sorted[index] ?? null;
  }

  reset() {
    this.samples = [];
  }
}

/** Process-wide singleton fed by `middleware/api-latency-sampler.ts`. */
export const apiLatencyTracker = new ApiLatencyTracker();
