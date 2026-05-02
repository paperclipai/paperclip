import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginCompanySettings } from "@paperclipai/db";

/**
 * Asserts that a plugin is authorized to operate within the given company.
 *
 * Authorization model: a plugin may write/delete secrets for a company unless
 * a `plugin_company_settings` row explicitly disables it (`enabled = false`).
 * No row → enabled by default (matches the table's stated semantics).
 *
 * Throws if the plugin has been explicitly disabled for the company.
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

  if (row !== null && !row.enabled) {
    throw new Error(
      `Plugin is not authorized for company ${companyId}`,
    );
  }
}
