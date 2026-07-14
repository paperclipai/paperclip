/**
 * @fileoverview Pure helpers for the Paperclip EE discovery affordance
 * (PAP-13865 §3.5 / §4.7). Core Skill Studio points at EE for detailed policy
 * administration but must never depend on it: removing, disabling, or breaking
 * EE can never break unrestricted core skill management. These helpers resolve
 * the EE plugin's lifecycle state into one of four availability states and, when
 * appropriate, an in-app deep link — with no React or network coupling so the
 * mapping is unit-testable.
 */

import type { PluginRecord } from "@paperclipai/shared";

/** Manifest id / plugin key of the first-party Paperclip EE plugin. */
export const PAPERCLIP_EE_PLUGIN_KEY = "paperclipai.paperclip-ee";

/** Marketing / discovery URL used when EE is not installed. */
export const PAPERCLIP_EE_MARKETING_URL = "https://paperclip.ing/ee";

/**
 * EE lifecycle as it matters to core:
 * - `absent`   — not installed. Show a text-only discovery line → marketing URL.
 * - `enabled`  — installed & ready. Show an in-app deep link to the EE page.
 * - `disabled` — installed but turned off. Discovery line + enable hint.
 * - `error`    — installed but failed to load / upgrading. Discovery line + retry hint.
 */
export type EeAvailability = "absent" | "enabled" | "disabled" | "error";

export interface EeSkillPolicyState {
  availability: EeAvailability;
  /** The resolved EE plugin record, when installed. */
  plugin: PluginRecord | null;
}

/** Find the Paperclip EE plugin in an installed-plugins list, if present. */
export function findEePlugin(plugins: readonly PluginRecord[] | undefined): PluginRecord | null {
  if (!plugins) return null;
  return plugins.find((plugin) => plugin.pluginKey === PAPERCLIP_EE_PLUGIN_KEY) ?? null;
}

/** Resolve the EE plugin record into a core-facing availability state. */
export function resolveEeAvailability(plugin: PluginRecord | null): EeAvailability {
  if (!plugin) return "absent";
  switch (plugin.status) {
    case "ready":
    case "installed":
      return "enabled";
    case "disabled":
      return "disabled";
    case "error":
    case "upgrade_pending":
      return "error";
    case "uninstalled":
      return "absent";
    default:
      return "absent";
  }
}

/** Build the state descriptor from a list of installed plugins. */
export function resolveEeSkillPolicyState(
  plugins: readonly PluginRecord[] | undefined,
): EeSkillPolicyState {
  const plugin = findEePlugin(plugins);
  return { availability: resolveEeAvailability(plugin), plugin };
}

/**
 * In-app deep link to the EE plugin page, or `null` when EE isn't installed /
 * we can't resolve a company prefix. The route mirrors
 * `/:companyPrefix/plugins/:pluginId` (see `ui/src/pages/PluginPage.tsx`).
 */
export function eePluginPageLink(
  plugin: PluginRecord | null,
  companyPrefix: string | null | undefined,
): string | null {
  if (!plugin || !companyPrefix) return null;
  return `/${companyPrefix}/plugins/${plugin.id}`;
}

/** Deep link to Plugin settings so an operator can enable a disabled EE plugin. */
export function eePluginSettingsLink(plugin: PluginRecord | null): string | null {
  if (!plugin) return null;
  return `/company/settings/instance/plugins/${plugin.pluginKey}`;
}
