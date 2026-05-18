/**
 * Phase 4A-S4 B2 (LET-367): cumulative-spend coalescer.
 *
 * The monitor calls `resolveSpend()` once per tick, which:
 *   1. Tries `SourceA` (vendor usage API) — preferred when available.
 *   2. Falls back to `SourceB` (internal counter: lease runtime × rate).
 *
 * Failure semantics: Source A failures (network, 401, 404, malformed payload,
 * credential-shaped fields) NEVER abort the tick. They are logged, the source
 * is marked unavailable for this tick, and the monitor proceeds with Source B.
 * S3 AC §Constraints: the monitor must not itself initiate any billable call
 * — Source A must be a read-only metering endpoint.
 *
 * Source B is deterministic and always on. It sums runtime-seconds across the
 * lease scope (provider = `e2b`, lease overlaps the window) and multiplies by
 * the current per-second rate snapshot.
 */

import type { Logger } from "pino";
import {
  redactCredentialShapedValues,
  type RedactedVendorResponse,
} from "./redaction.js";

export type SandboxBillingSourceLabel = "e2b-usage-api" | "internal-estimate";

export interface SourceASample {
  /** Cumulative spend in cents inside the current day window. */
  dayCents: number;
  /** Cumulative spend in cents inside the current month window. */
  monthCents: number;
  /** Raw vendor payload — already redacted before being returned. */
  rawRedacted: Record<string, unknown> | null;
}

export interface SourceBSample {
  dayCents: number;
  monthCents: number;
  /** Total runtime-seconds inside the day window across all e2b leases. */
  dayRuntimeSeconds: number;
  /** Total runtime-seconds inside the month window across all e2b leases. */
  monthRuntimeSeconds: number;
  /** Per-second rate snapshot used to derive the cents totals. */
  ratePerSecondCents: number;
}

export interface SourceA {
  /**
   * Returns a sample or `null` when the source is intentionally unavailable
   * (e.g. pilot tier without billing API). Throwing is reserved for hard
   * errors the monitor should log.
   */
  sample(input: { companyId: string; now: Date; signal?: AbortSignal }): Promise<SourceASample | null>;
}

export interface SourceB {
  sample(input: { companyId: string; now: Date }): Promise<SourceBSample>;
}

export interface ResolvedSpend {
  source: SandboxBillingSourceLabel;
  dayCents: number;
  monthCents: number;
  /** Redacted vendor payload, if Source A returned one. */
  rawRedacted: Record<string, unknown> | null;
  /** Source B is always computed even when Source A wins — for cross-check. */
  internalEstimate: SourceBSample;
  /** Diagnostic: was Source A unavailable, errored, or unused this tick? */
  sourceAStatus: "ok" | "unavailable" | "error" | "redacted_parse_error";
  /** When `sourceAStatus !== "ok"`, the redaction info that triggered the fallback. */
  sourceARedactionPaths?: string[];
}

export interface ResolveSpendInput {
  companyId: string;
  now: Date;
  sourceA: SourceA | null;
  sourceB: SourceB;
  logger: Pick<Logger, "info" | "warn" | "error">;
  signal?: AbortSignal;
}

export async function resolveSpend(input: ResolveSpendInput): Promise<ResolvedSpend> {
  const internalEstimate = await input.sourceB.sample({
    companyId: input.companyId,
    now: input.now,
  });

  if (!input.sourceA) {
    return {
      source: "internal-estimate",
      dayCents: internalEstimate.dayCents,
      monthCents: internalEstimate.monthCents,
      rawRedacted: null,
      internalEstimate,
      sourceAStatus: "unavailable",
    };
  }

  let sample: SourceASample | null;
  try {
    sample = await input.sourceA.sample({
      companyId: input.companyId,
      now: input.now,
      signal: input.signal,
    });
  } catch (err) {
    input.logger.warn(
      { err, companyId: input.companyId },
      "sandbox billing-cap monitor source-A sample failed; falling back to internal estimate",
    );
    return {
      source: "internal-estimate",
      dayCents: internalEstimate.dayCents,
      monthCents: internalEstimate.monthCents,
      rawRedacted: null,
      internalEstimate,
      sourceAStatus: "error",
    };
  }

  if (!sample) {
    return {
      source: "internal-estimate",
      dayCents: internalEstimate.dayCents,
      monthCents: internalEstimate.monthCents,
      rawRedacted: null,
      internalEstimate,
      sourceAStatus: "unavailable",
    };
  }

  // Defence in depth: even if the SourceA adapter has its own redaction, we
  // walk the payload one more time and treat any credential-shaped value as a
  // parse error.
  const inspected: RedactedVendorResponse<Record<string, unknown> | null> = sample.rawRedacted
    ? redactCredentialShapedValues(sample.rawRedacted)
    : { value: null, redactedAny: false, redactedPaths: [] };
  if (inspected.redactedAny) {
    input.logger.warn(
      { companyId: input.companyId, redactedPaths: inspected.redactedPaths },
      "sandbox billing-cap monitor refused source-A sample carrying credential-shaped fields",
    );
    return {
      source: "internal-estimate",
      dayCents: internalEstimate.dayCents,
      monthCents: internalEstimate.monthCents,
      rawRedacted: null,
      internalEstimate,
      sourceAStatus: "redacted_parse_error",
      sourceARedactionPaths: inspected.redactedPaths,
    };
  }

  return {
    source: "e2b-usage-api",
    dayCents: Math.max(0, Math.trunc(sample.dayCents)),
    monthCents: Math.max(0, Math.trunc(sample.monthCents)),
    rawRedacted: inspected.value,
    internalEstimate,
    sourceAStatus: "ok",
  };
}
