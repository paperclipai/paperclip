/**
 * Process-scoped resolved state for the Cloud starter-inference experiment flag.
 *
 * `instance-settings.ts` updates this whenever the effective experimental
 * settings are resolved (including staging database overrides), while PostHog
 * direct transport and browser analytics read it so runtime behavior,
 * `$feature/cloud-trial-inference`, browser super-properties, and server events
 * always agree on the active cohort.
 *
 * Kept in its own leaf module (separate from `telemetry.ts`) so existing tests
 * that mock `../telemetry.js` never break on an unmocked export.
 */
let resolvedCloudTrialInferenceEnabled: boolean | null = null;

export function setResolvedCloudTrialInferenceEnabled(enabled: boolean): void {
  resolvedCloudTrialInferenceEnabled = enabled;
}

export function getResolvedCloudTrialInferenceEnabled(): boolean | null {
  return resolvedCloudTrialInferenceEnabled;
}

export function resetResolvedCloudTrialInferenceEnabledForTests(): void {
  resolvedCloudTrialInferenceEnabled = null;
}
