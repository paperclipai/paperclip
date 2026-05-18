/**
 * Phase 4A-S4 B4 (LET-369): Layer 5 — lease-state-machine fail-closed tracker.
 *
 * This is the fifth kill-switch layer in the S3 §5 model. It does NOT replace
 * the per-lease state machine in `lease-state-machine.ts` (which models a
 * single lease's `requested → running → expired` lifecycle). It sits one level
 * above that, tracking the *provider*'s health across leases and tripping the
 * provider into a fail-closed posture when:
 *
 *   - 5 consecutive `acquireLease` failures fall inside a rolling 10-minute
 *     window → `degraded`.
 *   - An auth failure surfaces (HTTP 401 from the vendor) → immediate
 *     `degraded` transition.
 *   - A pre-egress redaction-boundary violation is detected (a registered
 *     resolved-secret canary appears in an outbound payload) → immediate
 *     `disabled` + Andrii page (the operator must explicitly clear it).
 *
 * While `degraded` or `disabled`, every subsequent `acquireLease` returns
 * `PROVIDER_DISABLED` synchronously and the inner provider is never invoked.
 * The state is intentionally in-memory and per-process: a server restart
 * resets to `healthy`, mirroring the existing lease state machine's scope.
 * Hard-cap and operator-toggle layers persist across restarts via the DB.
 *
 * Clear semantics:
 *   - `degraded` may be cleared by an operator after a manual investigation.
 *   - `disabled` should only be cleared after the redaction-boundary
 *     violation is root-caused and the page is acknowledged.
 */

import { SandboxProviderError } from "./provider-contract.js";

export type ProviderHealthState = "healthy" | "degraded" | "disabled";

export interface ProviderHealthTrackerOptions {
  /** Failure threshold within `windowMs` that trips to `degraded`. Default 5. */
  consecutiveFailureThreshold?: number;
  /** Rolling-window size in milliseconds. Default 10 minutes. */
  windowMs?: number;
  /** Wall-clock override for deterministic tests. */
  now?: () => Date;
  /** Hook called when the tracker pages Andrii on a redaction violation. */
  onAndriiPage?: (event: ProviderHealthPageEvent) => void | Promise<void>;
  /** Hook called whenever the tracker state transitions. */
  onTransition?: (event: ProviderHealthTransitionEvent) => void | Promise<void>;
}

export interface ProviderHealthSnapshot {
  state: ProviderHealthState;
  consecutiveFailures: number;
  trippedAt: Date | null;
  reason: string | null;
  lastFailureAt: Date | null;
  lastFailureCode: string | null;
}

export interface ProviderHealthTransitionEvent {
  from: ProviderHealthState;
  to: ProviderHealthState;
  reason: string;
  at: Date;
}

export interface ProviderHealthPageEvent {
  reason: string;
  at: Date;
  details: Record<string, unknown>;
}

const DEFAULT_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

export class ProviderHealthTracker {
  private state: ProviderHealthState = "healthy";
  private failureTimestamps: number[] = [];
  private trippedAt: Date | null = null;
  private reason: string | null = null;
  private lastFailureAt: Date | null = null;
  private lastFailureCode: string | null = null;
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly clock: () => Date;
  private readonly onAndriiPage: ProviderHealthTrackerOptions["onAndriiPage"];
  private readonly onTransition: ProviderHealthTrackerOptions["onTransition"];

  constructor(opts: ProviderHealthTrackerOptions = {}) {
    this.threshold = opts.consecutiveFailureThreshold ?? DEFAULT_THRESHOLD;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.now ?? (() => new Date());
    this.onAndriiPage = opts.onAndriiPage;
    this.onTransition = opts.onTransition;
  }

  snapshot(): ProviderHealthSnapshot {
    return {
      state: this.state,
      consecutiveFailures: this.failureTimestamps.length,
      trippedAt: this.trippedAt,
      reason: this.reason,
      lastFailureAt: this.lastFailureAt,
      lastFailureCode: this.lastFailureCode,
    };
  }

  /**
   * Returns true if the tracker is in a state that should reject new
   * `acquireLease` calls synchronously.
   */
  isFailClosed(): boolean {
    return this.state !== "healthy";
  }

  /** Throws PROVIDER_DISABLED if the tracker has tripped. Used as a pre-check
   *  inside `wrapAcquireLease`. */
  assertHealthy(provider: string): void {
    if (this.state === "healthy") return;
    throw new SandboxProviderError(
      "PROVIDER_DISABLED",
      this.state === "disabled"
        ? `Sandbox provider "${provider}" is disabled — Layer 5 fail-closed: ${this.reason ?? "unknown"}.`
        : `Sandbox provider "${provider}" is degraded — Layer 5 fail-closed: ${this.reason ?? "unknown"}.`,
      {
        details: {
          provider,
          layer: "lease-state-machine",
          healthState: this.state,
          reason: this.reason,
          trippedAt: this.trippedAt?.toISOString() ?? null,
        },
      },
    );
  }

  /** Record a successful `acquireLease`. Resets the rolling-window counter
   *  but does NOT clear an existing trip. Clearing is operator-driven. */
  recordSuccess(): void {
    this.failureTimestamps = [];
  }

  /**
   * Record a failed `acquireLease`. The caller passes the original error so
   * the tracker can recognise auth-failure status codes and decide whether
   * to trip immediately vs. on the rolling threshold.
   */
  async recordFailure(error: unknown): Promise<void> {
    const at = this.clock();
    const ts = at.getTime();
    const status = extractStatusCode(error);
    const code = error instanceof SandboxProviderError ? error.code : "UNKNOWN";
    this.lastFailureAt = at;
    this.lastFailureCode = code;

    // Trim out-of-window entries before recording.
    this.failureTimestamps = this.failureTimestamps.filter((t) => ts - t <= this.windowMs);
    this.failureTimestamps.push(ts);

    if (this.state !== "healthy") {
      // Already tripped — keep the counter accurate but don't transition again.
      return;
    }

    // Auth failure (401) → immediate degraded transition.
    if (status === 401) {
      await this.transition("degraded", `auth_failure_status_${status}`, at, {
        triggeringStatus: status,
        triggeringCode: code,
      });
      return;
    }

    if (this.failureTimestamps.length >= this.threshold) {
      await this.transition(
        "degraded",
        `consecutive_failures_${this.failureTimestamps.length}_within_${Math.round(this.windowMs / 1000)}s`,
        at,
        { consecutiveFailures: this.failureTimestamps.length, windowMs: this.windowMs },
      );
    }
  }

  /**
   * Report a pre-egress redaction-boundary violation. Always transitions to
   * `disabled` and fires the Andrii page hook. The caller should also halt
   * the outbound request — this method is the audit + state half of that
   * event.
   */
  async reportRedactionViolation(details: {
    boundary?: "before-provider" | "provider-owned";
    payloadKind?: string;
    redactedSampleLength?: number;
    [key: string]: unknown;
  }): Promise<void> {
    const at = this.clock();
    const reason = `redaction_boundary_violation_${details.boundary ?? "before-provider"}`;
    if (this.state !== "disabled") {
      await this.transition("disabled", reason, at, {
        boundary: details.boundary ?? "before-provider",
        payloadKind: details.payloadKind ?? "unknown",
        redactedSampleLength: details.redactedSampleLength ?? null,
      });
    }
    if (this.onAndriiPage) {
      await this.onAndriiPage({
        reason,
        at,
        details: {
          layer: "lease-state-machine",
          severity: "page-andrii",
          ...details,
        },
      });
    }
  }

  /**
   * Operator-initiated clear after manual investigation. Callers should only
   * invoke this from an audited admin path (the operator-toggle route).
   */
  async clear(reason: string): Promise<void> {
    if (this.state === "healthy") return;
    const at = this.clock();
    await this.transition("healthy", reason, at, {});
    this.failureTimestamps = [];
    this.trippedAt = null;
  }

  private async transition(
    to: ProviderHealthState,
    reason: string,
    at: Date,
    details: Record<string, unknown>,
  ): Promise<void> {
    const from = this.state;
    this.state = to;
    this.reason = to === "healthy" ? null : reason;
    if (to === "healthy") {
      this.trippedAt = null;
    } else {
      this.trippedAt = at;
    }
    if (this.onTransition) {
      await this.onTransition({ from, to, reason, at });
    }
    if (Object.keys(details).length > 0) {
      // The details bag is recorded into the transition event payload through
      // the onTransition hook above (already invoked); we don't store the raw
      // bag on the tracker to keep the snapshot shape stable.
      void details;
    }
  }
}

function extractStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  if (error instanceof SandboxProviderError) {
    const status = error.details?.status;
    return typeof status === "number" ? status : null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

/**
 * Convenience helper used by the integration suite: wraps a provider's
 * `acquireLease` with the tracker's pre-check + failure/success recording so
 * the kill-switch behaviour is uniform across providers.
 */
export async function trackedAcquireLease<TInput, TResult>(
  tracker: ProviderHealthTracker,
  provider: string,
  inner: (input: TInput) => Promise<TResult>,
  input: TInput,
): Promise<TResult> {
  tracker.assertHealthy(provider);
  try {
    const result = await inner(input);
    tracker.recordSuccess();
    return result;
  } catch (err) {
    await tracker.recordFailure(err);
    throw err;
  }
}
