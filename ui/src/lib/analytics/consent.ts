import { useSyncExternalStore } from "react";
import type { BrowserAnalyticsConfig } from "@paperclipai/shared";

export const ANALYTICS_CONSENT_STORAGE_KEY = "paperclip.analyticsConsent";

export type AnalyticsChoice = "granted" | "denied";
export type AnalyticsConsent = AnalyticsChoice | "ask";

const CONSENT_TIME_ZONES = new Set([
  "Arctic/Longyearbyen",
  "Asia/Famagusta",
  "Asia/Nicosia",
  "Atlantic/Azores",
  "Atlantic/Canary",
  "Atlantic/Faeroe",
  "Atlantic/Faroe",
  "Atlantic/Jan_Mayen",
  "Atlantic/Madeira",
  "Atlantic/Reykjavik",
  "America/Cayenne",
  "America/Guadeloupe",
  "America/Marigot",
  "America/Martinique",
  "America/St_Barthelemy",
  "Indian/Mayotte",
  "Indian/Reunion",
  "CET",
  "EET",
  "Eire",
  "GB",
  "GB-Eire",
  "Iceland",
  "MET",
  "Poland",
  "Portugal",
  "WET",
]);

const UNKNOWN_TIME_ZONES = new Set(["", "UTC", "GMT", "UCT", "Universal", "Zulu", "Greenwich"]);

export function timeZoneRequiresConsent(timeZone: string | null | undefined): boolean {
  const zone = timeZone?.trim() ?? "";
  if (UNKNOWN_TIME_ZONES.has(zone) || zone.startsWith("Etc/")) return true;
  return zone.startsWith("Europe/") || CONSENT_TIME_ZONES.has(zone);
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

export function consentRequired(config: BrowserAnalyticsConfig): boolean {
  if (typeof config.consentRequired === "boolean") return config.consentRequired;
  return timeZoneRequiresConsent(browserTimeZone());
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

export function resolveAnalyticsConsent(config: BrowserAnalyticsConfig): AnalyticsConsent {
  const stored = readStoredAnalyticsChoice() ?? pageChoice;
  if (stored) return stored;
  if (!consentRequired(config)) return "granted";
  if (browserAsksNotToTrack()) return "denied";
  return "ask";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ANALYTICS_CONSENT_STORAGE_KEY) listener();
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
