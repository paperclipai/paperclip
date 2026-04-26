import path from "node:path";
import {
  TelemetryClient,
  resolveTelemetryConfig,
  loadOrCreateState,
} from "@paperclipai/shared/telemetry";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";
import { serverVersion } from "./version.js";

let client: TelemetryClient | null = null;

/** Initializes the singleton telemetry client with the resolved config, or returns null if telemetry is disabled. */
export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  if (client) return client;

  const config = resolveTelemetryConfig(fileConfig);
  if (!config.enabled) return null;

  const stateDir = path.join(resolvePaperclipInstanceRoot(), "telemetry");
  client = new TelemetryClient(
    config,
    () => loadOrCreateState(stateDir, serverVersion),
    serverVersion,
  );
  client.startPeriodicFlush(60_000);
  return client;
}

/** Returns the initialized telemetry client singleton, or null if telemetry was not initialized. */
export function getTelemetryClient(): TelemetryClient | null {
  return client;
}
