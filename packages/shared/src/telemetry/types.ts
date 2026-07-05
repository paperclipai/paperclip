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

export interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  app?: string;
  schemaVersion?: string;
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
