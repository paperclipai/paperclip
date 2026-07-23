/**
 * Per-company plugin enablement.
 *
 * Two AND-ed switches make a plugin act for a company: the instance switch
 * (`plugins.status === "ready"`, enforced elsewhere) and the company switch
 * computed here from the plugin manifest's `companyEnablement` default plus
 * the `plugin_company_settings` row:
 *
 * - no row + no manifest field            => enabled (backward compatible)
 * - no row + `default: "on"`              => enabled
 * - no row + `default: "off"`             => disabled (opt-in plugins)
 * - row                                   => row.enabled wins
 *
 * `locked: true` never changes the read path: lock enforcement happens at
 * write time (the enablement toggle route rejects non-instance-admins with
 * 409 `plugin_enablement_locked`), so any existing row on a locked plugin
 * was written by an instance admin and is honored here.
 *
 * @see docs/superpowers/specs/2026-07-18-settings-visibility-and-plugin-enablement-design.md §4
 */
import type { PaperclipPluginManifestV1, PluginCompanySettings } from "@paperclipai/shared";
import { forbidden } from "../errors.js";

/** Minimal manifest slice the enablement computation needs. */
export type CompanyEnablementManifest =
  Pick<PaperclipPluginManifestV1, "companyEnablement"> | null | undefined;

/**
 * Pure enablement computation: settings row wins; otherwise the manifest
 * default; otherwise "on".
 */
export function evaluateCompanyEnablement(
  manifest: CompanyEnablementManifest,
  settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
): boolean {
  if (settings) return settings.enabled;
  return (manifest?.companyEnablement?.default ?? "on") === "on";
}

/**
 * Throwing form of {@link evaluateCompanyEnablement} for request-path gates
 * that already hold the plugin record and settings row. Fails closed with
 * the typed 403 used at every enforcement point.
 */
export function assertCompanyEnablement(
  manifest: CompanyEnablementManifest,
  settings: Pick<PluginCompanySettings, "enabled"> | null | undefined,
): void {
  if (!evaluateCompanyEnablement(manifest, settings)) {
    throw forbidden("Plugin is not enabled for this company", {
      code: "plugin_not_enabled_for_company",
    });
  }
}

/**
 * Registry surface the enablement service needs. The full
 * `pluginRegistryService(db)` object structurally satisfies this.
 */
export interface PluginEnablementRegistry {
  getById(pluginId: string): Promise<{ manifestJson: PaperclipPluginManifestV1 | null } | null>;
  getByKey(pluginKey: string): Promise<{ id: string; manifestJson: PaperclipPluginManifestV1 | null } | null>;
  getCompanySettings(pluginId: string, companyId: string): Promise<PluginCompanySettings | null>;
}

/**
 * Registry-backed enablement service. `pluginId` is the plugin's database
 * UUID (`plugins.id`), matching `plugin_company_settings.plugin_id`.
 */
export function pluginCompanyEnablementService(registry: PluginEnablementRegistry) {
  async function isPluginEnabledForCompany(pluginId: string, companyId: string): Promise<boolean> {
    const [plugin, settings] = await Promise.all([
      registry.getById(pluginId),
      registry.getCompanySettings(pluginId, companyId),
    ]);
    // Unknown plugin: fail closed. Request-path gates should have 404'd
    // earlier; anything that reaches this with a bogus id gets a deny.
    if (!plugin) return false;
    return evaluateCompanyEnablement(plugin.manifestJson, settings);
  }

  async function ensurePluginEnabledForCompany(pluginId: string, companyId: string): Promise<void> {
    if (!(await isPluginEnabledForCompany(pluginId, companyId))) {
      throw forbidden("Plugin is not enabled for this company", {
        code: "plugin_not_enabled_for_company",
      });
    }
  }

  return { isPluginEnabledForCompany, ensurePluginEnabledForCompany };
}

/**
 * Event-bus deliverability checker. The bus registers subscriptions under
 * the manifest `pluginKey` (see plugin-event-bus.ts `forPlugin`), so this
 * resolves key -> plugin record before consulting the manifest default and
 * `plugin_company_settings` (keyed by the plugin's uuid).
 *
 * Fails OPEN — an enablement lookup error must never silently drop events —
 * and logs so failures stay visible. This is deliberately the opposite of
 * the request-path gates, which fail closed.
 */
export function createPluginEventDeliverabilityChecker(
  registry: PluginEnablementRegistry,
  log: (context: { err: unknown; pluginKey: string; companyId: string }, msg: string) => void,
): (pluginKey: string, companyId: string) => Promise<boolean> {
  return async (pluginKey, companyId) => {
    try {
      const plugin = await registry.getByKey(pluginKey);
      if (!plugin) return true;
      const settings = await registry.getCompanySettings(plugin.id, companyId);
      return evaluateCompanyEnablement(plugin.manifestJson, settings);
    } catch (err) {
      log(
        { err, pluginKey, companyId },
        "Plugin enablement lookup failed; delivering event (fail open)",
      );
      return true;
    }
  };
}
