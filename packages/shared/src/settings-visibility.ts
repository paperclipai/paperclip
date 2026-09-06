import { INSTANCE_FEATURE_KEYS, type InstanceFeatureKey } from "./feature-catalog.js";

/**
 * Operator-configurable settings visibility.
 *
 * A hosting operator (a managed cloud, an internal shared server) can hide
 * settings surfaces that do not apply to their deployment by setting the
 * `PAPERCLIP_HIDDEN_SETTINGS` environment variable to a comma-separated
 * list of keys from this registry. Hiding a surface removes it from the UI
 * (nav, routes, page sections). Surfaces backed by instance-level mutation
 * routes are also floored with a 403 carrying
 * `SETTINGS_OPERATOR_MANAGED_ERROR_CODE`: the Access, Plugins, and Adapters
 * pages, every field-backed General section, every experimental toggle
 * (individually or via the whole Experimental page), and the company Import
 * page (whose whole route surface is floored). The other company pages are
 * UI-visibility keys only: their APIs (memberships, invites, secrets,
 * exports) stay live for agents and integrations.
 *
 * Nothing is hidden by default: with the variable unset, UI and API behave
 * exactly as before this mechanism existed.
 *
 * Unknown keys are ignored (with a server-side warning) rather than rejected,
 * so an operator may roll one list across a fleet of mixed app versions: an
 * image that predates a key simply keeps that surface visible instead of
 * refusing to boot.
 */

/**
 * Instance settings pages that can be hidden (nav entry + route). The General
 * page is deliberately not hideable: it is the settings root and the redirect
 * target for hidden pages. Individual General sections are hideable below.
 */
export const HIDEABLE_INSTANCE_PAGES = [
  "instance.profile",
  "instance.environments",
  "instance.access",
  "instance.experimental",
  "instance.plugins",
  "instance.adapters",
] as const;

export type HideableInstancePage = (typeof HIDEABLE_INSTANCE_PAGES)[number];

/**
 * Company-level settings pages that can be hidden (nav entry + tab + route).
 * The company General page is deliberately not hideable: it is the settings
 * root and the redirect target for hidden pages. `company.import` also floors
 * the import API routes; the rest only hide UI surfaces.
 */
export const HIDEABLE_COMPANY_PAGES = [
  "company.members",
  "company.invites",
  "company.secrets",
  "company.export",
  "company.import",
] as const;

export type HideableCompanyPage = (typeof HIDEABLE_COMPANY_PAGES)[number];

/**
 * Sub-surfaces of company settings pages that can be hidden individually.
 * UI-visibility keys only: the backing APIs stay live for agents and
 * integrations. Hiding the whole page (`company.secrets`) already removes
 * everything inside it; these keys hide one tab while the page stays up.
 */
export const HIDEABLE_COMPANY_SECTIONS = [
  "company.secrets.vaults",
  "company.secrets.proposals",
] as const;

export type HideableCompanySection = (typeof HIDEABLE_COMPANY_SECTIONS)[number];

/**
 * Sections of Instance → General that can be hidden. Field-backed sections
 * (their suffix names a general-settings field) also floor writes to that
 * field; `deploymentStatus` and `signOut` are read-only UI with no field.
 */
export const HIDEABLE_GENERAL_SECTIONS = [
  "instance.general.deploymentStatus",
  "instance.general.censorUsernameInLogs",
  "instance.general.keyboardShortcuts",
  "instance.general.backupRetention",
  "instance.general.feedbackDataSharingPreference",
  "instance.general.signOut",
] as const;

export type HideableGeneralSection = (typeof HIDEABLE_GENERAL_SECTIONS)[number];

/** General sections that are informational UI only, with no settings field. */
export const UI_ONLY_GENERAL_SECTIONS = [
  "instance.general.deploymentStatus",
  "instance.general.signOut",
] as const satisfies readonly HideableGeneralSection[];

export type HideableExperimentalSetting = `instance.experimental.${InstanceFeatureKey}`;

/** The visibility key for an experimental toggle; every boolean flag is hideable. */
export function experimentalSettingKey(key: InstanceFeatureKey): HideableExperimentalSetting {
  return `instance.experimental.${key}`;
}

export type HideableSettingKey =
  | HideableInstancePage
  | HideableCompanyPage
  | HideableCompanySection
  | HideableGeneralSection
  | HideableExperimentalSetting;

/** Every key `PAPERCLIP_HIDDEN_SETTINGS` accepts. */
export const HIDEABLE_SETTING_KEYS: readonly HideableSettingKey[] = [
  ...HIDEABLE_INSTANCE_PAGES,
  ...HIDEABLE_COMPANY_PAGES,
  ...HIDEABLE_COMPANY_SECTIONS,
  ...HIDEABLE_GENERAL_SECTIONS,
  ...INSTANCE_FEATURE_KEYS.map(experimentalSettingKey),
];

/** Stable 403 code for writes to operator-hidden settings. */
export const SETTINGS_OPERATOR_MANAGED_ERROR_CODE = "settings_operator_managed";

export interface ParsedHiddenSettings {
  /** Recognized keys, deduplicated, in input order. */
  hidden: HideableSettingKey[];
  /** Unrecognized entries, for the caller to warn about. */
  unknown: string[];
}

/** Parse a `PAPERCLIP_HIDDEN_SETTINGS`-style comma-separated list. */
export function parseHiddenSettingsList(raw: string | undefined): ParsedHiddenSettings {
  const hidden: HideableSettingKey[] = [];
  const unknown: string[] = [];
  if (!raw) return { hidden, unknown };
  const known = new Set<string>(HIDEABLE_SETTING_KEYS);
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (known.has(key)) {
      hidden.push(key as HideableSettingKey);
    } else {
      unknown.push(key);
    }
  }
  return { hidden, unknown };
}

export function hidesInstancePage(
  hidden: ReadonlySet<string>,
  page: HideableInstancePage,
): boolean {
  return hidden.has(page);
}

export function hidesCompanyPage(
  hidden: ReadonlySet<string>,
  page: HideableCompanyPage,
): boolean {
  return hidden.has(page);
}

export function hidesCompanySection(
  hidden: ReadonlySet<string>,
  section: HideableCompanySection,
): boolean {
  return hidden.has(section);
}

export function hidesGeneralSection(
  hidden: ReadonlySet<string>,
  section: HideableGeneralSection,
): boolean {
  return hidden.has(section);
}

/**
 * Whether a toggle is hidden, either individually or because the whole
 * Experimental page is hidden.
 */
export function hidesExperimentalSetting(
  hidden: ReadonlySet<string>,
  key: InstanceFeatureKey,
): boolean {
  return hidden.has("instance.experimental") || hidden.has(experimentalSettingKey(key));
}
