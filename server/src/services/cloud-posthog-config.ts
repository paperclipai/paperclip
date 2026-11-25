import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import { getResolvedCloudTrialInferenceEnabled } from "./cloud-posthog-cohort.js";

/**
 * PostHog experiment / feature flag key for the Cloud starter-inference A/B test.
 * Stamped onto workspace groups, direct server events, browser super-properties,
 * and `$feature_flag_called` exposure events so every onboarding, activation,
 * conversion, and retention chart can split treatment vs. control cleanly.
 */
export const CLOUD_TRIAL_INFERENCE_FLAG_KEY = "cloud-trial-inference";
export type CloudTrialInferenceCohort = "treatment" | "control";

export function cloudTrialInferenceCohort(enabled: boolean): CloudTrialInferenceCohort {
  return enabled ? "treatment" : "control";
}

/**
 * Resolves whether `enableCloudTrialInference` is active in this stack's
 * `PAPERCLIP_MANAGED_CONFIG` document. Fails closed (`false`) if absent or
 * malformed so analytics never throw on startup.
 */
export function resolveCloudTrialInferenceEnabled(env: CloudInstanceEnv = process.env): boolean {
  if (env === process.env) {
    const resolved = getResolvedCloudTrialInferenceEnabled();
    if (resolved !== null) return resolved;
  }
  const raw = env.PAPERCLIP_MANAGED_CONFIG?.trim();
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { features?: Record<string, unknown> } | null;
    return parsed?.features?.enableCloudTrialInference === true;
  } catch {
    return false;
  }
}

/**
 * PostHog settings for a Paperclip Cloud stack. Present only on a
 * Cloud-managed instance that has a project token and a stack id; every
 * self-hosted install resolves `null` and keeps the collector path.
 */
export type CloudPostHogConfig = {
  token: string; // PAPERCLIP_POSTHOG_PROJECT_TOKEN
  host: string; // PAPERCLIP_POSTHOG_HOST, default "https://us.i.posthog.com"
  environment: string | null; // PAPERCLIP_POSTHOG_ENVIRONMENT
  stackId: string; // PAPERCLIP_CLOUD_STACK_ID
  directEnabled: boolean; // PAPERCLIP_POSTHOG_DIRECT !== "0"
  browserEnabled: boolean; // PAPERCLIP_POSTHOG_BROWSER_ENABLED === "1"
  replayEnabled: boolean; // browserEnabled && PAPERCLIP_POSTHOG_REPLAY_ENABLED !== "0"
  replayWorkContentEnabled: boolean;
  cloudTrialInferenceEnabled: boolean; // PAPERCLIP_MANAGED_CONFIG.features.enableCloudTrialInference
};

export const DEFAULT_CLOUD_POSTHOG_HOST = "https://us.i.posthog.com";

function readEnv(env: CloudInstanceEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function resolveCloudPostHogConfig(
  env: Record<string, string | undefined> = process.env,
): CloudPostHogConfig | null {
  if (!isCloudManagedInstance(env)) return null;
  const token = readEnv(env, "PAPERCLIP_POSTHOG_PROJECT_TOKEN");
  const stackId = readEnv(env, "PAPERCLIP_CLOUD_STACK_ID");
  if (!token || !stackId) return null;

  const browserEnabled = readEnv(env, "PAPERCLIP_POSTHOG_BROWSER_ENABLED") === "1";
  const replayEnabled = browserEnabled && readEnv(env, "PAPERCLIP_POSTHOG_REPLAY_ENABLED") !== "0";
  return {
    token,
    host: (readEnv(env, "PAPERCLIP_POSTHOG_HOST") ?? DEFAULT_CLOUD_POSTHOG_HOST).replace(/\/+$/, ""),
    environment: readEnv(env, "PAPERCLIP_POSTHOG_ENVIRONMENT"),
    stackId,
    directEnabled: readEnv(env, "PAPERCLIP_POSTHOG_DIRECT") !== "0",
    browserEnabled,
    replayEnabled,
    replayWorkContentEnabled: replayEnabled && readEnv(env, "PAPERCLIP_POSTHOG_REPLAY_WORK_CONTENT_ENABLED") === "1",
    cloudTrialInferenceEnabled: resolveCloudTrialInferenceEnabled(env),
  };
}

/**
 * Whether server events go straight to PostHog. Requires the kill switch to
 * be on and an environment: every direct event carries `environment`, so
 * without one the stack keeps using the collector.
 */
export function isPostHogDirectDeliveryEnabled(
  config: CloudPostHogConfig | null,
): config is CloudPostHogConfig & { environment: string } {
  return Boolean(config?.directEnabled && config.environment);
}
