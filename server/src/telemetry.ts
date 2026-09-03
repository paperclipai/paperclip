import type { TelemetryClient } from "@paperclipai/shared/telemetry";

let client: TelemetryClient | null = null;

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  void fileConfig;
  // Telemetry is permanently disabled. Never create a client.
  void client;
  return null;
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}
