import { useSyncExternalStore } from "react";
import { timeZoneRequiresAnalyticsConsent, type BrowserAnalyticsConfig } from "@paperclipai/shared";

export const ANALYTICS_CONSENT_STORAGE_KEY = "paperclip.analyticsConsent";

export type AnalyticsChoice = "granted" | "denied";
export type AnalyticsConsent = AnalyticsChoice | "ask";

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function consentRequired(config: BrowserAnalyticsConfig): boolean {
  if (typeof config.consentRequired === "boolean") return config.consentRequired;
  return timeZoneRequiresAnalyticsConsent(browserTimeZone());
}

export function browserAsksNotToTrack(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1";
}

export function readStoredAnalyticsChoice(): AnalyticsChoice | null {
  try {
    const value = window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
    return value === "granted" || value === "denied" ? value : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let pageChoice: AnalyticsChoice | null = null;

function writeStoredAnalyticsChoice(choice: AnalyticsChoice): void {
  try {
    window.localStorage.setItem(ANALYTICS_CONSENT_STORAGE_KEY, choice);
  } catch {
    return;
  }
}

export function storeAnalyticsChoice(choice: AnalyticsChoice): void {
  pageChoice = choice;
  writeStoredAnalyticsChoice(choice);
  for (const listener of listeners) listener();
}

export function analyticsChoiceMadeOnThisPage(): boolean {
  return pageChoice !== null;
}

export function browserBlocksAnalytics(config: BrowserAnalyticsConfig): boolean {
  return consentRequired(config) && browserAsksNotToTrack();
}

export function resolveAnalyticsConsent(config: BrowserAnalyticsConfig): AnalyticsConsent {
  if (browserBlocksAnalytics(config)) return "denied";
  const stored = pageChoice ?? readStoredAnalyticsChoice();
  if (stored) return stored;
  return consentRequired(config) ? "ask" : "granted";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== ANALYTICS_CONSENT_STORAGE_KEY) return;
    pageChoice = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAnalyticsConsent(config: BrowserAnalyticsConfig | null): AnalyticsConsent | null {
  return useSyncExternalStore(
    subscribe,
    () => (config ? resolveAnalyticsConsent(config) : null),
    () => null,
  );
}

export function resetAnalyticsConsentForTest(): void {
  pageChoice = null;
}
