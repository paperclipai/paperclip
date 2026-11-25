/**
 * Process-scoped resolved state for the Cloud starter-inference experiment flag.
 *
 * `instance-settings.ts` updates this whenever the effective experimental
 * settings are resolved (including staging database overrides), while PostHog
 * direct transport and browser analytics read it so runtime behavior,
 * `$feature/cloud-trial-inference`, browser super-properties, `$groupidentify`,
 * and server events always agree on the active cohort.
 *
 * Kept in its own leaf module (separate from `telemetry.ts`) so existing tests
 * that mock `../telemetry.js` never break on an unmocked export.
 */
let resolvedCloudTrialInferenceEnabled: boolean | null = null;
const listeners = new Set<(enabled: boolean) => void>();

export function setResolvedCloudTrialInferenceEnabled(enabled: boolean): void {
  const changed = resolvedCloudTrialInferenceEnabled !== enabled;
  resolvedCloudTrialInferenceEnabled = enabled;
  if (changed) {
    for (const listener of listeners) {
      try {
        listener(enabled);
      } catch {
        // Best-effort analytics listeners must never disrupt settings reads.
      }
    }
  }
}

export function getResolvedCloudTrialInferenceEnabled(): boolean | null {
  return resolvedCloudTrialInferenceEnabled;
}

export function onCloudTrialInferenceCohortChange(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetResolvedCloudTrialInferenceEnabledForTests(): void {
  resolvedCloudTrialInferenceEnabled = null;
  listeners.clear();
}
