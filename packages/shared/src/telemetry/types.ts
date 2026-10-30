import type {
  EventDimensionsMap,
  PaperclipEventName,
} from "./generated/paperclip-telemetry.js";

export interface TelemetryState {
  installId: string;
  salt: string;
  createdAt: string;
  firstSeenVersion: string;
}

/**
 * Exponential-backoff-with-jitter parameters for the (future) batched-retry
 * sender. Shape mirrors the plugin worker crash-recovery backoff
 * (`server/src/services/plugin-worker-manager.ts`). Consumed by the
 * batched-retry sender; nothing reads it yet.
 */
export interface TelemetryBackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterRatio: number;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  app?: string;
  schemaVersion?: string;
  /**
   * Optional, additive soft caps + backoff. Defaulted centrally in
   * `resolveTelemetryConfig`; no wire/envelope change and no consumer today —
   * the batched-retry sender is the first reader.
   */
  maxEventsPerBatch?: number;
  maxBodyBytes?: number;
  maxPendingRetryBatches?: number;
  backoff?: TelemetryBackoffConfig;
}

export type TelemetryDimensionValue = string | number | boolean;
export type TelemetryDimensions = Record<string, TelemetryDimensionValue>;

/** Per-event object inside the backend envelope */
export interface TelemetryEvent {
  name: string;
  occurredAt: string;
  dimensions: TelemetryDimensions;
}

/** Full payload sent to the backend ingest endpoint */
export interface TelemetryEventEnvelope {
  app: string;
  schemaVersion: string;
  installId: string;
  version: string;
  events: TelemetryEvent[];
  /**
   * Deterministic, salt-free content-hash of `{installId, events}` used as the
   * server idempotency key so a retried batch de-dupes (202 replay) instead of
   * double-counting. Derived in `client.ts`; the server allow-set already
   * accepts it. The hash is salt-free so it stays stable across installs and
   * never leaks the per-install salt.
   */
  batchId: string;
}

export type RegisteredPluginEventName = never;
export type TelemetryEventName = PaperclipEventName | RegisteredPluginEventName;

export type TelemetryEventDimensions<K extends TelemetryEventName> =
  K extends keyof EventDimensionsMap ? EventDimensionsMap[K] : never;
