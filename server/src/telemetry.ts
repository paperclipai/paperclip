import { createHash } from "node:crypto";
import path from "node:path";
import {
  TelemetryClient,
  type TelemetryConfig,
  type TelemetryState,
  resolveTelemetryConfig,
  loadOrCreateState,
  trackServerStarted,
} from "@paperclipai/shared/telemetry";
import { resolvePaperclipInstanceRoot } from "./home-paths.js";
import { serverVersion } from "./version.js";
import { getCloudStackContext } from "./services/cloud-instance.js";
import { isPostHogDirectDeliveryEnabled, resolveCloudPostHogConfig } from "./services/cloud-posthog-config.js";
import {
  createPostHogDirectTransport,
  type PostHogDirectTransport,
  type PostHogNodeFactory,
} from "./services/posthog-direct/index.js";

let client: TelemetryClient | null = null;
let directTransport: PostHogDirectTransport | null = null;
let initializationFailed = false;

export type InitTelemetryOptions = {
  env?: Record<string, string | undefined>;
  /** Test seam for the posthog-node client. */
  postHogFactory?: PostHogNodeFactory;
};

/**
 * Picks the one sender for this process. Self-hosted installs (and Cloud
 * stacks without a PostHog token, or with PAPERCLIP_POSTHOG_DIRECT=0) keep the
 * collector. A Cloud stack with a token sends every batch straight to PostHog.
 */
function resolveDirectTransport(
  options: InitTelemetryOptions,
  telemetry: TelemetryConfig,
  getState: () => TelemetryState,
): PostHogDirectTransport | null {
  const env = options.env ?? process.env;
  const config = resolveCloudPostHogConfig(env);
  // Every direct event must carry an environment; without one keep the collector.
  if (!isPostHogDirectDeliveryEnabled(config)) return null;
  const transport = createPostHogDirectTransport(config, { factory: options.postHogFactory });
  const stack = getCloudStackContext(env);
  const { installId } = getState();
  void transport
    .announceWorkspace({
      stackSlug: stack?.stackSlug ?? null,
      primaryHost: stack?.primaryHost ?? null,
      app: telemetry.app ?? "paperclip",
      schemaVersion: telemetry.schemaVersion ?? "1",
      version: serverVersion,
      installId,
      installHash: createHash("sha256").update(installId).digest("hex"),
    })
    .catch(() => {
      console.warn("[telemetry] Could not announce the workspace to PostHog.");
    });
  return transport;
}

export function initTelemetry(
  fileConfig?: { enabled?: boolean },
  options: InitTelemetryOptions = {},
): TelemetryClient | null {
  if (client || initializationFailed) return client;

  const config = resolveTelemetryConfig(fileConfig);
  if (!config.enabled) return null;

  let pendingClient: TelemetryClient | null = null;
  try {
    const stateDir = path.join(resolvePaperclipInstanceRoot(), "telemetry");
    let state: TelemetryState | null = null;
    const getState = () => (state ??= loadOrCreateState(stateDir, serverVersion));
    const transport = resolveDirectTransport(options, config, getState);
    pendingClient = new TelemetryClient(
      config,
      getState,
      serverVersion,
      Math.random,
      transport ?? undefined,
    );
    trackServerStarted(pendingClient, { os_platform: process.platform });
    pendingClient.startPeriodicFlush(60_000);
    client = pendingClient;
    directTransport = transport;
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

/** Whether this process sends telemetry straight to PostHog (Cloud only). */
export function isPostHogDirectTelemetryActive(): boolean {
  return directTransport !== null;
}

/** Stops timers, sends queued events, then closes the PostHog client if any. */
export async function shutdownTelemetry(): Promise<void> {
  const current = client;
  if (!current) return;
  current.stop();
  try {
    await current.flush();
  } finally {
    await directTransport?.shutdown();
  }
}

/** Test-only: forget the process-wide client. */
export function resetTelemetryForTests(): void {
  client?.stop();
  client = null;
  directTransport = null;
  initializationFailed = false;
}
