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
import {
  resetResolvedCloudTrialInferenceEnabledForTests,
  setResolvedCloudTrialInferenceEnabled,
} from "./services/cloud-posthog-cohort.js";
import {
  CLOUD_TRIAL_INFERENCE_FLAG_KEY,
  cloudTrialInferenceCohort,
  isPostHogDirectDeliveryEnabled,
  resolveCloudPostHogConfig,
} from "./services/cloud-posthog-config.js";
import {
  createPostHogDirectTransport,
  type PostHogDirectTransport,
  type PostHogEventContext,
  type PostHogNodeFactory,
} from "./services/posthog-direct/index.js";

let client: TelemetryClient | null = null;
let directTransport: PostHogDirectTransport | null = null;
let initializationFailed = false;
const exposedTrialActors = new Set<string>();

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

/**
 * Emits a Cloud-only direct PostHog event (never sent through the self-hosted
 * collector). Fire-and-forget; never throws to callers.
 */
export function trackCloudPostHogEvent(
  event: string,
  properties?: Record<string, unknown>,
  contextOverride?: {
    userId?: string | null;
    companyId?: string | null;
    sessionId?: string | null;
    windowId?: string | null;
  },
): void {
  const transport = directTransport;
  if (!transport) return;
  const normalizedContext: Partial<PostHogEventContext> | undefined = contextOverride
    ? {
        ...(contextOverride.userId ? { userId: contextOverride.userId } : {}),
        ...(contextOverride.companyId ? { companyId: contextOverride.companyId } : {}),
        ...(contextOverride.sessionId ? { sessionId: contextOverride.sessionId } : {}),
        ...(contextOverride.windowId ? { windowId: contextOverride.windowId } : {}),
      }
    : undefined;
  void transport
    .captureCloudEvent({
      event,
      properties,
      contextOverride: normalizedContext,
    })
    .catch(() => {
      // Best-effort analytics must never break product flows.
    });
}

/**
 * Emits PostHog's `$feature_flag_called` exposure event once per actor per
 * process when a Cloud user enters onboarding (both treatment and control),
 * establishing an exact denominator for A/B experiment funnels.
 */
export function trackCloudTrialExposure(input: {
  surface: "onboarding_wizard" | "onboarding_seed";
  userId?: string | null;
  companyId?: string | null;
  enabledOverride?: boolean;
}): void {
  const transport = directTransport;
  if (!transport) return;
  const dedupeKey = `${input.userId ?? "workspace"}:${input.companyId ?? ""}`;
  if (exposedTrialActors.has(dedupeKey)) return;
  exposedTrialActors.add(dedupeKey);
  const enabled =
    typeof input.enabledOverride === "boolean"
      ? input.enabledOverride
      : transport.cloudTrialInferenceEnabled;
  if (typeof input.enabledOverride === "boolean") {
    setResolvedCloudTrialInferenceEnabled(input.enabledOverride);
    transport.setCloudTrialInferenceEnabled(input.enabledOverride);
  }
  const cohort = cloudTrialInferenceCohort(enabled);
  void transport
    .captureCloudEvent({
      event: "$feature_flag_called",
      properties: {
        $feature_flag: CLOUD_TRIAL_INFERENCE_FLAG_KEY,
        $feature_flag_response: cohort,
        surface: input.surface,
      },
      contextOverride: {
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.companyId ? { companyId: input.companyId } : {}),
      },
      setOncePersonProperties: {
        cloud_trial_inference_cohort: cohort,
      },
    })
    .catch(() => {
      // Best-effort analytics must never break product flows.
    });
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
  exposedTrialActors.clear();
  resetResolvedCloudTrialInferenceEnabledForTests();
}
