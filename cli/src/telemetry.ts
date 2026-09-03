import type { TelemetryClient } from "../../packages/shared/src/telemetry/index.js";
import {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
} from "../../packages/shared/src/telemetry/index.js";
import { readConfig } from "./config/store.js";

let client: TelemetryClient | null = null;

export function initTelemetry(fileConfig?: { enabled?: boolean }): TelemetryClient | null {
  void fileConfig;
  // Telemetry is permanently disabled. Never create a client.
  void client;
  return null;
}

export function initTelemetryFromConfigFile(configPath?: string): TelemetryClient | null {
  try {
    return initTelemetry(readConfig(configPath)?.telemetry);
  } catch {
    return initTelemetry();
  }
}

export function getTelemetryClient(): TelemetryClient | null {
  return client;
}

export async function flushTelemetry(): Promise<void> {
  if (client) {
    await client.flush();
  }
}

export {
  trackInstallStarted,
  trackInstallCompleted,
  trackCompanyImported,
};
