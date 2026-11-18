const CONSENT_REQUIRED_COUNTRIES = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "AX", "GF", "GP", "MQ", "RE", "YT", "MF",
  "IS", "LI", "NO", "SJ",
  "GB", "GG", "JE", "IM", "GI",
  "CH",
]);

const CONSENT_REQUIRED_TIME_ZONES = new Set([
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

const COUNTRY_ALIASES = new Map([
  ["UK", "GB"],
  ["EL", "GR"],
]);

let regionNames: Intl.DisplayNames | null | undefined;

function isKnownRegion(code: string): boolean {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  if (!regionNames) return true;
  const name = regionNames.of(code);
  return !!name && name !== code && name !== "Unknown Region";
}

export function countryRequiresAnalyticsConsent(country: string | null | undefined): boolean | null {
  const raw = country?.trim().toUpperCase();
  if (!raw || !/^[A-Z]{2}$/.test(raw)) return null;
  const code = COUNTRY_ALIASES.get(raw) ?? raw;
  if (CONSENT_REQUIRED_COUNTRIES.has(code)) return true;
  return isKnownRegion(code) ? false : null;
}

export function timeZoneRequiresAnalyticsConsent(timeZone: string | null | undefined): boolean {
  const zone = timeZone?.trim() ?? "";
  if (UNKNOWN_TIME_ZONES.has(zone) || zone.startsWith("Etc/")) return true;
  return zone.startsWith("Europe/") || CONSENT_REQUIRED_TIME_ZONES.has(zone);
}
