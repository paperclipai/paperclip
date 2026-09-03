import type { TelemetryBackoffConfig, TelemetryConfig } from "./types.js";

// Telemetry is permanently disabled. There is no supported way to enable it:
// config values and environment variables are intentionally ignored here.

/**
 * Single source of truth for telemetry soft caps + backoff. Kept as config
 * *defaults* (not hardcoded flush logic) so later work reads config, not
 * literals. Exported so the `client.ts` consumer resolves the same values.
 */
export const TELEMETRY_DEFAULTS: {
  readonly maxEventsPerBatch: number;
  readonly maxBodyBytes: number;
  readonly maxPendingRetryBatches: number;
  readonly backoff: Readonly<TelemetryBackoffConfig>;
} = Object.freeze({
  maxEventsPerBatch: 50,
  maxBodyBytes: 512 * 1024, // 524288
  maxPendingRetryBatches: 20,
  backoff: Object.freeze({
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxAttempts: 5,
    jitterRatio: 0.25,
  }),
});

/** Caller-supplied overrides for the additive caps + backoff surface. */
export type TelemetryConfigOverrides = Partial<
  Pick<
    TelemetryConfig,
    "enabled" | "maxEventsPerBatch" | "maxBodyBytes" | "maxPendingRetryBatches" | "backoff"
  >
>;

/**
 * Fully-resolved caps + backoff — every field is present (defaults applied), so
 * `client.ts` can consume them without re-defaulting. `TelemetryConfig`'s own
 * cap fields stay optional (additive wire surface); this is the resolved view.
 */
export interface ResolvedTelemetryCaps {
  maxEventsPerBatch: number;
  maxBodyBytes: number;
  maxPendingRetryBatches: number;
  backoff: TelemetryBackoffConfig;
}

/**
 * Resolves soft caps + backoff, applying `TELEMETRY_DEFAULTS` for any field the
 * caller did not override. One source of truth for both the config surface and
 * the `client.ts` consumer.
 */
export function resolveCaps(overrides?: TelemetryConfigOverrides): ResolvedTelemetryCaps {
  return {
    maxEventsPerBatch: overrides?.maxEventsPerBatch ?? TELEMETRY_DEFAULTS.maxEventsPerBatch,
    maxBodyBytes: overrides?.maxBodyBytes ?? TELEMETRY_DEFAULTS.maxBodyBytes,
    maxPendingRetryBatches:
      overrides?.maxPendingRetryBatches ?? TELEMETRY_DEFAULTS.maxPendingRetryBatches,
    backoff: { ...TELEMETRY_DEFAULTS.backoff, ...overrides?.backoff },
  };
}

export function resolveTelemetryConfig(
  fileConfig?: { enabled?: boolean } & TelemetryConfigOverrides,
): TelemetryConfig {
  const caps = resolveCaps(fileConfig);

  // Permanently disabled. Ignore every enable path: file config, endpoint
  // overrides, and environment variables.
  void fileConfig;
  return { enabled: false, ...caps };
}
