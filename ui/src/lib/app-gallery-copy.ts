import { t } from "@/i18n";
import { appDefinitionText } from "@/pages/apps/app-definition-display";
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
    get tagline() { return t("localizationApps.reach9000AppsYourTeamAlreadyUses762"); },
    get short() { return t("localizationApps.reach9000AppsFromYourAgents763"); },
  },
  github: {
    get tagline() { return t("localizationApps.readCodeAndPullRequestsCommentOnIssues764"); },
    get short() { return t("localizationApps.readCodeAndPullRequestsCommentOnIssues764"); },
  },
  slack: {
    get tagline() { return t("localizationApps.sendAndReadMessagesInYourTeamSChannels765"); },
    get short() { return t("localizationApps.sendAndReadMessagesInYourChannels766"); },
  },
  notion: {
    get tagline() { return t("localizationApps.readAndUpdatePagesInYourWorkspace767"); },
    get short() { return t("localizationApps.readAndUpdatePagesInYourWorkspace767"); },
  },
  posthog: {
    get tagline() { return t("localizationApps.exploreProductUsageErrorsFlagsAndExperiments768"); },
    get short() { return t("localizationApps.signInWithPostHogProjectPinningAndAccessContr769"); },
  },
  linear: {
    get tagline() { return t("localizationApps.createUpdateAndReadTickets770"); },
    get short() { return t("localizationApps.createUpdateAndReadTickets770"); },
  },
  "google-sheets": {
    get tagline() { return t("localizationApps.readAndUpdateSelectedSpreadsheets771"); },
    get short() { return t("localizationApps.readSpreadsheetsOrUpdateTheFilesYouChoose772"); },
  },
  gmail: {
    get tagline() { return t("localizationApps.readMailAndCreateDraftsForYourReview773"); },
    get short() { return t("localizationApps.readMailAndCreateDraftsForYourReview773"); },
  },
  "google-drive": {
    get tagline() { return t("localizationApps.findReadAndCreateFilesInDrive774"); },
    get short() { return t("localizationApps.findReadAndCreateFilesInDrive774"); },
  },
  "google-docs": {
    get tagline() { return t("localizationApps.readAndUpdateDocuments775"); },
    get short() { return t("localizationApps.readAndUpdateDocuments775"); },
  },
  "google-slides": {
    get tagline() { return t("localizationApps.readAndUpdatePresentations776"); },
    get short() { return t("localizationApps.readAndUpdatePresentations776"); },
  },
  "google-calendar": {
    get tagline() { return t("localizationApps.reviewCalendarsAndManageEvents777"); },
    get short() { return t("localizationApps.reviewCalendarsAndManageEvents777"); },
  },
  "google-chat": {
    get tagline() { return t("localizationApps.readConversationsAndSendMessages778"); },
    get short() { return t("localizationApps.readConversationsAndSendMessages778"); },
  },
  "google-people": {
    get tagline() { return t("localizationApps.lookUpContactsAndPeopleInYourDirectory779"); },
    get short() { return t("localizationApps.lookUpContactsAndPeopleInYourDirectory779"); },
  },
  "google-workspace-search": {
    get tagline() { return t("localizationApps.searchAcrossYourGoogleWorkspace780"); },
    get short() { return t("localizationApps.searchAcrossYourGoogleWorkspace780"); },
  },
  hubspot: {
    get tagline() { return t("localizationApps.lookUpContactsAndUpdateDealStages781"); },
    get short() { return t("localizationApps.lookUpContactsAndUpdateDealStages781"); },
  },
  intercom: {
    get tagline() { return t("localizationApps.readAndReplyToCustomerConversations782"); },
    get short() { return t("localizationApps.readAndReplyToCustomerConversations782"); },
  },
  figma: {
    get tagline() { return t("localizationApps.readFilesAndPostCommentsOnFrames783"); },
    get short() { return t("localizationApps.readFilesAndPostCommentsOnFrames783"); },
  },
  stripe: {
    get tagline() { return t("localizationApps.readCustomersInvoicesAndPayouts784"); },
    get short() { return t("localizationApps.readCustomersInvoicesAndPayouts784"); },
  },
  context7: {
    get tagline() { return t("localizationApps.lookUpUpToDateDocsForYourLibraries785"); },
    get short() { return t("localizationApps.lookUpUpToDateDocsForYourLibraries785"); },
  },
};

const GENERIC: AppCopy = {
  get tagline() { return t("localizationApps.giveYourAgentsAccessToThisApp786"); },
  get short() { return t("localizationApps.giveYourAgentsAccessToThisApp786"); },
};

/** Curated, gate-safe copy for a gallery app. */
export function appCopyFor(key: string, fallbackTagline?: string | null): AppCopy {
  const curated = APP_COPY[key];
  if (curated) return curated;
  if (fallbackTagline) {
    const cleaned = sanitizeProsumerCopy(appDefinitionText(key, fallbackTagline));
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
  if (fieldCount <= 1) return t("localizationApps.yourAppKey", { app: appName });
  const cleaned = sanitizeProsumerCopy(rawLabel);
  return cleaned || t("localizationApps.yourAppKey", { app: appName });
}
