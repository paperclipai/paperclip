import { t } from "@/i18n";
/**
 * Prosumer copy for the Apps surface (PAP-10856).
 *
 * The P1a gallery manifest carries developer-flavoured taglines and credential
 * labels (e.g. "Connect Zapier-hosted MCP actions", "Zapier MCP token"). Those
 * strings would fail the vocabulary gate from PAP-10827 — no "MCP", "server",
 * "profile", "policy", "gateway", or "transport" anywhere on this surface. So
 * the UI never renders the raw manifest copy directly: it looks up plain copy
 * here, and `sanitizeProsumerCopy` is a final backstop for any free-text we do
 * surface (app names, fallback taglines).
 */

/** Words that must never appear in prosumer-facing copy on the Apps surface. */
const BANNED_WORDS = [
  "mcp",
  "server",
  "profile",
  "policy",
  "gateway",
  "transport",
  "stdio",
  "endpoint",
];

const BANNED_RE = new RegExp(`\\b(${BANNED_WORDS.join("|")})s?\\b`, "gi");

/**
 * Strip banned vocabulary from a free-text string as a last-resort backstop.
 * Prefer curated copy below; this only protects against manifest text we can't
 * fully control (e.g. a newly added gallery app with no curated entry yet).
 */
export function sanitizeProsumerCopy(text: string): string {
  return text
    .replace(BANNED_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

export interface AppCopy {
  /** Two short lines for the gallery card (M2). */
  tagline: string;
  /** Single line for the connect step header (M3b). */
  short: string;
}

/**
 * Curated prosumer copy keyed by gallery key. Taken from the M-series wires
 * (https://happy-grove-jzyc.here.now/). Apps without an entry fall back to a
 * generic, gate-safe line.
 */
const APP_COPY: Record<string, AppCopy> = {
  zapier: {
    get "tagline"() { return t("display:copy_cc64c518fef9"); },
    get "short"() { return t("display:copy_cf2be4a98927"); },
  },
  github: {
    get "tagline"() { return t("display:copy_979a9e719d38"); },
    get "short"() { return t("display:copy_979a9e719d38"); },
  },
  slack: {
    get "tagline"() { return t("display:copy_8758484a12b4"); },
    get "short"() { return t("display:copy_2b5693410709"); },
  },
  notion: {
    get "tagline"() { return t("display:copy_7f333cb1fb57"); },
    get "short"() { return t("display:copy_7f333cb1fb57"); },
  },
  railway: {
    get "tagline"() { return t("display:copy_db0542d56287"); },
    get "short"() { return t("display:copy_f17a79ff312e"); },
  },
  posthog: {
    get "tagline"() { return t("display:copy_69c922e975ba"); },
    get "short"() { return t("display:copy_674a020b231f"); },
  },
  ditto: {
    get "tagline"() { return t("display:copy_941b6f8d1a95"); },
    get "short"() { return t("display:copy_9ffff57931f1"); },
  },
  gauge: {
    get "tagline"() { return t("display:copy_8230d41403ae"); },
    get "short"() { return t("display:copy_e764817147f2"); },
  },
  neon: {
    get "tagline"() { return t("display:copy_a319eaa49272"); },
    get "short"() { return t("display:copy_4bc9e84f7560"); },
  },
  superagent: {
    get "tagline"() { return t("display:copy_21d98fa1f1e4"); },
    get "short"() { return t("display:copy_0adf89ee64cd"); },
  },
  linear: {
    get "tagline"() { return t("display:copy_e559aa135706"); },
    get "short"() { return t("display:copy_e559aa135706"); },
  },
  "google-sheets": {
    get "tagline"() { return t("display:copy_b9f5b7b6d660"); },
    get "short"() { return t("display:copy_d2a7b671287a"); },
  },
  gmail: {
    get "tagline"() { return t("display:copy_e97d99559666"); },
    get "short"() { return t("display:copy_e97d99559666"); },
  },
  "google-drive": {
    get "tagline"() { return t("display:copy_c54dd7004c1e"); },
    get "short"() { return t("display:copy_c54dd7004c1e"); },
  },
  "google-docs": {
    get "tagline"() { return t("display:copy_765ce0fe3419"); },
    get "short"() { return t("display:copy_765ce0fe3419"); },
  },
  "google-slides": {
    get "tagline"() { return t("display:copy_1c1325feba4c"); },
    get "short"() { return t("display:copy_1c1325feba4c"); },
  },
  "google-calendar": {
    get "tagline"() { return t("display:copy_9329f556a9dc"); },
    get "short"() { return t("display:copy_9329f556a9dc"); },
  },
  "google-chat": {
    get "tagline"() { return t("display:copy_c0e73ff5d407"); },
    get "short"() { return t("display:copy_c0e73ff5d407"); },
  },
  "google-people": {
    get "tagline"() { return t("display:copy_574ef8c1d649"); },
    get "short"() { return t("display:copy_574ef8c1d649"); },
  },
  "google-workspace-search": {
    get "tagline"() { return t("display:copy_d3a07e2d3d5d"); },
    get "short"() { return t("display:copy_d3a07e2d3d5d"); },
  },
  hubspot: {
    get "tagline"() { return t("display:copy_0b0377fd1d59"); },
    get "short"() { return t("display:copy_0b0377fd1d59"); },
  },
  intercom: {
    get "tagline"() { return t("display:copy_85a6866cc3a9"); },
    get "short"() { return t("display:copy_85a6866cc3a9"); },
  },
  figma: {
    get "tagline"() { return t("display:copy_0815830358de"); },
    get "short"() { return t("display:copy_0815830358de"); },
  },
  stripe: {
    get "tagline"() { return t("display:copy_d20ef7ebf8f1"); },
    get "short"() { return t("display:copy_d20ef7ebf8f1"); },
  },
  context7: {
    get "tagline"() { return t("display:copy_e6f8878f375b"); },
    get "short"() { return t("display:copy_e6f8878f375b"); },
  },
};

const GENERIC: AppCopy = {
  get "tagline"() { return t("display:copy_dd0d69a77bc4"); },
  get "short"() { return t("display:copy_dd0d69a77bc4"); },
};

/** Curated, gate-safe copy for a gallery app. */
export function appCopyFor(key: string, fallbackTagline?: string | null): AppCopy {
  const curated = APP_COPY[key];
  if (curated) return curated;
  if (fallbackTagline) {
    const cleaned = sanitizeProsumerCopy(fallbackTagline);
    if (cleaned) return { tagline: cleaned, short: cleaned };
  }
  return GENERIC;
}

/**
 * Label for a single credential field on the key-paste step (M3b). The raw
 * manifest label can contain banned vocab ("Zapier MCP token"), so for the
 * common single-field case we present "Your {App} key" per the wires; multi-
 * field apps fall back to a sanitized version of the manifest label.
 */
export function credentialFieldLabel(
  appName: string,
  rawLabel: string,
  fieldCount: number,
): string {
  if (/^Paste your\b/.test(rawLabel)) return sanitizeProsumerCopy(rawLabel);
  if (fieldCount <= 1) return t("display:copy_038ce4f71c51", { value0: appName });
  const cleaned = sanitizeProsumerCopy(rawLabel);
  return cleaned || t("display:copy_038ce4f71c51", { value0: appName });
}
