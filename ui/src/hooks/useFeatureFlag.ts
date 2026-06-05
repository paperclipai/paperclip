declare global {
  interface Window {
    __PAPERCLIP_FEATURE_FLAGS__?: Record<string, boolean | undefined>;
  }
}

/**
 * Local feature-flag hook for small UI-only flags.
 * Falls back to disabled when no explicit flag source is present so new
 * surfaces ship dark unless explicitly enabled.
 */
export function useFeatureFlag(key: string): boolean {
  if (typeof window === "undefined") return false;

  const globalValue = window.__PAPERCLIP_FEATURE_FLAGS__?.[key];
  if (typeof globalValue === "boolean") return globalValue;

  try {
    const raw = window.localStorage.getItem(`paperclip.feature.${key}`);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Ignore storage failures and use the default.
  }

  return false;
}
