import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginCompanySettings } from "@paperclipai/db";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";

export class PluginCompanyAuthorizationError extends Error {
  code = PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED;

  constructor(companyId: string) {
    super(`Plugin is not authorized for company ${companyId}`);
    this.name = "PluginCompanyAuthorizationError";
  }
}

/**
 * Asserts that a plugin is authorized to operate within the given company.
 *
 * Authorization model: a plugin may write/delete secrets for a company only
 * when an explicit `plugin_company_settings` row enables it.
 * No row → denied.
 * Row with `enabled = true` → authorized.
 *
 * Throws if the plugin is not explicitly enabled for the company.
 */
export async function assertPluginAuthorizedForCompany(
  db: Db,
  pluginId: string,
  companyId: string,
): Promise<void> {
  const row = await db
    .select({ enabled: pluginCompanySettings.enabled })
    .from(pluginCompanySettings)
    .where(
      and(
        eq(pluginCompanySettings.pluginId, pluginId),
        eq(pluginCompanySettings.companyId, companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);

  if (row === null || !row.enabled) {
    throw new PluginCompanyAuthorizationError(companyId);
  }
}
