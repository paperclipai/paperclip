import { isCloudManagedInstance, type CloudInstanceEnv } from "./cloud-instance.js";

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
  return {
    token,
    host: (readEnv(env, "PAPERCLIP_POSTHOG_HOST") ?? DEFAULT_CLOUD_POSTHOG_HOST).replace(/\/+$/, ""),
    environment: readEnv(env, "PAPERCLIP_POSTHOG_ENVIRONMENT"),
    stackId,
    directEnabled: readEnv(env, "PAPERCLIP_POSTHOG_DIRECT") !== "0",
    browserEnabled,
    replayEnabled: browserEnabled && readEnv(env, "PAPERCLIP_POSTHOG_REPLAY_ENABLED") !== "0",
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
