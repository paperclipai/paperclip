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
 * (`server/src/services/plugin-worker-manager.ts`). Consumed by Impl-2; nothing
 * reads it yet.
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
   * Impl-2 (PAP-2853) is the first reader.
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
}

export type RegisteredPluginEventName = never;
export type TelemetryEventName = PaperclipEventName | RegisteredPluginEventName;

export type TelemetryEventDimensions<K extends TelemetryEventName> =
  K extends keyof EventDimensionsMap ? EventDimensionsMap[K] : never;
