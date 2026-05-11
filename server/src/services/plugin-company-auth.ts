import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pluginCompanySettings } from "@paperclipai/db";

/**
 * Asserts that a plugin is authorized to operate within the given company.
 *
 * Authorization model: a plugin may write/delete secrets for a company unless
 * an explicit `plugin_company_settings` row disables it.
 * No row → authorized (default company behavior).
 * Row with `enabled = false` → denied.
 *
 * Throws if the plugin is explicitly disabled for the company.
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
