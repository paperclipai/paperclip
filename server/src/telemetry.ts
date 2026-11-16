import path from "node:path";
import {
  TelemetryClient,
  resolveTelemetryConfig,
  loadOrCreateState,
  trackServerStarted,
} from "@paperclipai/shared/telemetry";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";
import { serverVersion } from "./version.js";

let client: TelemetryClient | null = null;
let initializationFailed = false;

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  if (client || initializationFailed) return client;

  const config = resolveTelemetryConfig(fileConfig);
  if (!config.enabled) return null;

  let pendingClient: TelemetryClient | null = null;
  try {
    const stateDir = path.join(resolvePaperclipInstanceRoot(), "telemetry");
    pendingClient = new TelemetryClient(
      config,
      () => loadOrCreateState(stateDir, serverVersion),
      serverVersion,
    );
    trackServerStarted(pendingClient, { os_platform: process.platform });
    pendingClient.startPeriodicFlush(60_000);
    client = pendingClient;
    return client;
  } catch {
    pendingClient?.stop();
    initializationFailed = true;
    console.warn("[telemetry] Initialization failed; telemetry is disabled for this process.");
    return null;
  }
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}
