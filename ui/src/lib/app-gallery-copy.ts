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
    tagline: "Reach 9,000+ apps your team already uses.",
    short: "Reach 9,000+ apps from your agents.",
  },
  github: {
    tagline: "Read code and pull requests, comment on issues.",
    short: "Read code and pull requests, comment on issues.",
  },
  slack: {
    tagline: "Send and read messages in your team's channels.",
    short: "Send and read messages in your channels.",
  },
  notion: {
    tagline: "Read and update pages in your workspace.",
    short: "Read and update pages in your workspace.",
  },
  linear: {
    tagline: "Create, update and read tickets.",
    short: "Create, update and read tickets.",
  },
  "google-sheets": {
    tagline: "Read and update selected spreadsheets.",
    short: "Read and update selected spreadsheets.",
  },
  gmail: {
    tagline: "Read mail and send drafts for your review.",
    short: "Read mail and send drafts for your review.",
  },
  hubspot: {
    tagline: "Look up contacts and update deal stages.",
    short: "Look up contacts and update deal stages.",
  },
  intercom: {
    tagline: "Read and reply to customer conversations.",
    short: "Read and reply to customer conversations.",
  },
  figma: {
    tagline: "Read files and post comments on frames.",
    short: "Read files and post comments on frames.",
  },
  stripe: {
    tagline: "Read customers, invoices, and payouts.",
    short: "Read customers, invoices, and payouts.",
  },
  context7: {
    tagline: "Look up up-to-date docs for your libraries.",
    short: "Look up up-to-date docs for your libraries.",
  },
};

const GENERIC: AppCopy = {
  tagline: "Give your agents access to this app.",
  short: "Give your agents access to this app.",
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
  if (fieldCount <= 1) return `Your ${appName} key`;
  const cleaned = sanitizeProsumerCopy(rawLabel);
  return cleaned || `Your ${appName} key`;
}
