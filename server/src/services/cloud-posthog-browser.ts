// Browser product analytics (PostHog) for hosted Paperclip Cloud instances.
//
// The signed-in session hands the board UI a `browserAnalytics` config only
// when `resolveCloudPostHogConfig` returns a config (cloud managed, project
// token and stack ID set) and `PAPERCLIP_POSTHOG_BROWSER_ENABLED=1`. Every
// other instance gets `null`, so self-hosted installs, local development and
// tests never download posthog-js and never mount the PostHog proxy.
//
// The browser sends to `POSTHOG_PROXY_PATH` on its own origin, not to PostHog,
// so ad blockers do not drop the events. See `routes/posthog-proxy.ts`.

import { countryRequiresAnalyticsConsent, type BrowserAnalyticsConfig } from "@paperclipai/shared";
import { isCloudStagingInstance, type CloudInstanceEnv } from "./cloud-instance.js";
import { resolveCloudPostHogConfig, type CloudPostHogConfig } from "./cloud-posthog-config.js";

/** Same-origin path that the PostHog reverse proxy serves. */
export const POSTHOG_PROXY_PATH = "/_ph";

const POSTHOG_CLOUD_INGEST_HOST = /^(us|eu)\.i\.posthog\.com$/i;

export type RequestHeaders = Record<string, string | string[] | undefined>;

export function resolveAnalyticsConsentRequired(env: CloudInstanceEnv, headers: RequestHeaders): boolean | null {
  const headerName = env.PAPERCLIP_POSTHOG_COUNTRY_HEADER?.trim().toLowerCase();
  if (!headerName) return null;
  const value = headers[headerName];
  return countryRequiresAnalyticsConsent(Array.isArray(value) ? value[0] : value);
}

/** The browser analytics part of the Cloud PostHog config, or null when it is off. */
export function resolveBrowserPostHogConfig(env: CloudInstanceEnv = process.env): CloudPostHogConfig | null {
  const config = resolveCloudPostHogConfig(env);
  return config?.browserEnabled ? config : null;
}

/**
 * PostHog serves its static scripts (`/static/*`, `/array/*`) from a separate
 * assets host. A self-run or test host serves both from one origin.
 */
export function posthogAssetsOrigin(ingestHost: string): string {
  const url = new URL(ingestHost);
  const match = POSTHOG_CLOUD_INGEST_HOST.exec(url.hostname);
  if (match) url.hostname = `${match[1]!.toLowerCase()}-assets.i.posthog.com`;
  return url.origin;
}

/** The PostHog app host (for toolbar and replay links), or null for a non-PostHog host. */
export function posthogUiHost(ingestHost: string): string | null {
  const url = new URL(ingestHost);
  const match = POSTHOG_CLOUD_INGEST_HOST.exec(url.hostname);
  return match ? `https://${match[1]!.toLowerCase()}.posthog.com` : null;
}

export function resolveBrowserAnalyticsConfig(
  env: CloudInstanceEnv = process.env,
  headers: RequestHeaders = {},
  options?: { cloudTrialInferenceEnabled?: boolean },
): BrowserAnalyticsConfig | null {
  const config = resolveBrowserPostHogConfig(env);
  if (!config) return null;
  let uiHost: string | null;
  try {
    uiHost = posthogUiHost(config.host);
  } catch {
    // An invalid host cannot be proxied either; keep browser analytics off.
    return null;
  }
  return {
    token: config.token,
    apiHost: POSTHOG_PROXY_PATH,
    uiHost,
    // Every browser event carries an environment. Without the explicit
    // variable, a staging host name means staging; anything else production.
    environment: config.environment ?? (isCloudStagingInstance(env) ? "staging" : "production"),
    stackId: config.stackId,
    replayEnabled: config.replayEnabled,
    replayWorkContentEnabled: config.replayWorkContentEnabled,
    consentRequired: resolveAnalyticsConsentRequired(env, headers),
    cloudTrialInferenceEnabled:
      typeof options?.cloudTrialInferenceEnabled === "boolean"
        ? options.cloudTrialInferenceEnabled
        : config.cloudTrialInferenceEnabled,
  };
}
