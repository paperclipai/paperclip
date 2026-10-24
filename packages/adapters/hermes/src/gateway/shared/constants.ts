export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

export const DEFAULT_TIMEOUT_SEC = 600;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;

// Run-create rate-limit retry: mass seat wakes can land enough simultaneous
// create requests to trip the gateway's rate limiter, which used to fail the
// run at invocation. Absorb those bursts with a small jittered backoff before
// surfacing the 429 for the platform's own transient retry scheduling.
export const RATE_LIMIT_RETRY_DELAYS_MS = [2_000, 8_000, 30_000] as const;
export const RATE_LIMIT_RETRY_JITTER_MS = 1_000;
export const RATE_LIMIT_RETRY_AFTER_MAX_MS = 30_000;
